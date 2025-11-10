import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const FRONT = path.join(ROOT, "frontend");

const app = express();
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.use(express.static(FRONT, { extensions: ["html"] }));

// Default route -> Control screen
app.get("/", (_req, res) => res.redirect("/control"));

// Convenience routes
app.get("/control", (_req, res) =>
  res.sendFile(path.join(FRONT, "control.html"))
);
app.get("/display", (_req, res) =>
  res.sendFile(path.join(FRONT, "display.html"))
);

// HTTP + WS
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/**
 * Room state model (back-compat + authoritative clock):
 * - status:       "idle" | "running" | "paused" | "finished"
 * - durationMs:   configured duration (locked at 3:00 by UI)
 * - deadlineMs:   epoch ms when timer will hit 0 (authoritative when running)
 * - remainingMs:  remaining time snapshot when paused/idle
 * - t0, elapsedPausedMs: maintained for older clients (derived from above)
 * - thresholds:   kept for compatibility (not required by display)
 * - updatedAt:    last mutation time (server clock)
 */
const rooms = new Map();

const now = () => Date.now();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      state: {
        roomId,
        status: "idle",
        durationMs: 180_000,
        deadlineMs: null,
        remainingMs: 180_000, // mirrors duration when idle
        // legacy fields (kept in sync)
        t0: null,
        elapsedPausedMs: 0,
        thresholds: { yellowFrac: 0.5, redFrac: 0.1 },
        updatedAt: now(),
      },
      clients: new Set(),
    });
  }
  return rooms.get(roomId);
}

/** Compute remaining from authoritative fields. */
function remainingFromAuthoritative(s, at = now()) {
  if (s.status === "running" && typeof s.deadlineMs === "number") {
    return s.deadlineMs - at;
  }
  return s.remainingMs;
}

/** Keep legacy fields (t0/elapsedPausedMs) consistent with authoritative ones. */
function syncLegacyFields(s) {
  if (s.status === "running" && typeof s.deadlineMs === "number") {
    // Set t0 so legacy clients compute the same remaining
    // remaining = duration - (now - t0 + elapsedPausedMs)
    // Choose elapsedPausedMs = duration - remaining at this instant, t0 = now
    const rem = clamp(s.deadlineMs - now(), 0, s.durationMs);
    s.elapsedPausedMs = clamp(s.durationMs - rem, 0, s.durationMs);
    s.t0 = now();
    return;
  }
  // paused/idle/finished: encode elapsedPausedMs as "consumed" time
  const rem = clamp(s.remainingMs, 0, s.durationMs);
  s.elapsedPausedMs = clamp(s.durationMs - rem, 0, s.durationMs);
  s.t0 = null;
}

/** If running and elapsed, flip to finished. */
function finalizeIfElapsed(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const s = room.state;
  if (s.status !== "running") return;

  if (remainingFromAuthoritative(s) <= 0) {
    s.status = "finished";
    s.deadlineMs = null;
    s.remainingMs = 0;
    s.updatedAt = now();
    syncLegacyFields(s);
  }
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const s = room.state;
  const payload = {
    ...s,
    serverNow: now(), // stamp for latency compensation on clients
  };
  const msg = JSON.stringify({ type: "snapshot", payload });
  room.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId =
    (url.searchParams.get("room") || "").toUpperCase().slice(0, 8) || "DEMO";
  const role = (url.searchParams.get("role") || "display").toLowerCase();

  const room = ensureRoom(roomId);
  room.clients.add(ws);

  // Initial snapshot
  finalizeIfElapsed(roomId);
  syncLegacyFields(room.state);
  ws.send(
    JSON.stringify({
      type: "snapshot",
      payload: { ...room.state, serverNow: now() },
    })
  );

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const { type, payload } = msg || {};

    const mutating =
      type === "start" ||
      type === "pause" ||
      type === "resume" ||
      type === "reset" ||
      type === "adjustTime" ||
      type === "setDuration" ||
      type === "setThresholds" ||
      type === "finish";

    if (mutating && role !== "control") return;

    const s = room.state;
    const n = now();

    switch (type) {
      case "start": {
        // Start fresh from configured duration (control enforces 3:00)
        const durationMs = Math.max(
          1000,
          Number(payload?.durationMs ?? s.durationMs)
        );
        s.status = "running";
        s.durationMs = durationMs;
        s.remainingMs = durationMs;
        s.deadlineMs = n + durationMs;
        s.updatedAt = n;
        syncLegacyFields(s);
        break;
      }

      case "pause": {
        if (s.status !== "running") break;
        const rem = clamp(remainingFromAuthoritative(s, n), 0, s.durationMs);
        s.status = "paused";
        s.remainingMs = rem;
        s.deadlineMs = null;
        s.updatedAt = n;
        syncLegacyFields(s);
        break;
      }

      case "resume": {
        if (s.status !== "paused") break;
        const rem = clamp(s.remainingMs, 0, s.durationMs);
        s.status = "running";
        s.deadlineMs = n + rem;
        s.updatedAt = n;
        syncLegacyFields(s);
        break;
      }

      case "reset": {
        s.status = "idle";
        s.remainingMs = s.durationMs;
        s.deadlineMs = null;
        s.updatedAt = n;
        syncLegacyFields(s);
        break;
      }

      case "setDuration": {
        const newDur = Math.max(
          1000,
          Number(payload?.durationMs ?? s.durationMs)
        );
        // Adjust duration while preserving current remaining where possible.
        const currentRem = clamp(
          remainingFromAuthoritative(s, n),
          0,
          s.durationMs
        );
        s.durationMs = newDur;

        if (s.status === "running") {
          const consumed = clamp(newDur - currentRem, 0, newDur);
          s.deadlineMs = n + (newDur - consumed);
          s.remainingMs = newDur - consumed;
        } else {
          s.remainingMs = clamp(currentRem, 0, newDur);
          s.deadlineMs = null;
        }
        s.updatedAt = n;
        syncLegacyFields(s);
        break;
      }

      case "adjustTime": {
        const delta = Number(payload?.deltaMs ?? 0);
        if (s.status === "running" && typeof s.deadlineMs === "number") {
          // Shift the deadline (authoritative)
          const minDeadline = n + 1000; // don't allow negative/instant expiry
          s.deadlineMs = Math.max(minDeadline, s.deadlineMs + delta);
          s.updatedAt = n;
          // keep remainingMs in sync for completeness
          s.remainingMs = clamp(s.deadlineMs - n, 0, s.durationMs);
          syncLegacyFields(s);
        } else {
          // paused/idle: adjust remaining within [0, duration]
          const newRem = clamp(s.remainingMs + delta, 0, s.durationMs);
          s.remainingMs = newRem;
          s.updatedAt = n;
          s.deadlineMs = null;
          syncLegacyFields(s);
        }
        break;
      }

      case "setThresholds": {
        let yf = Number(payload?.yellowFrac ?? s.thresholds.yellowFrac);
        let rf = Number(payload?.redFrac ?? s.thresholds.redFrac);
        yf = clamp(yf, 0, 1);
        rf = clamp(rf, 0, 1);
        if (rf > yf) rf = yf;
        s.thresholds = { yellowFrac: yf, redFrac: rf };
        s.updatedAt = n;
        break;
      }

      case "finish": {
        s.status = "finished";
        s.deadlineMs = null;
        s.remainingMs = 0;
        s.updatedAt = n;
        syncLegacyFields(s);
        break;
      }

      case "requestSnapshot": {
        // no-op; handled by broadcast below
        break;
      }

      default:
        return;
    }

    finalizeIfElapsed(roomId);
    broadcast(roomId);
  });

  ws.on("close", () => {
    room.clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Speaker Timer running on http://localhost:${PORT}`);
});
