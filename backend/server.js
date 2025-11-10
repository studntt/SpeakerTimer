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
 * Room state model:
 * - status: "idle" | "running" | "paused" | "finished"
 * - durationMs: configured duration (default 3:00, but can expand)
 * - deadlineMs: epoch ms when timer will hit 0 (authoritative when running)
 * - remainingMs: remaining time snapshot when paused/idle
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
        remainingMs: 180_000,
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

function remainingFromAuthoritative(s, at = now()) {
  if (s.status === "running" && typeof s.deadlineMs === "number") {
    return s.deadlineMs - at;
  }
  return s.remainingMs;
}

function syncLegacyFields(s) {
  if (s.status === "running" && typeof s.deadlineMs === "number") {
    const rem = Math.max(0, s.deadlineMs - now());
    s.elapsedPausedMs = Math.max(0, s.durationMs - rem);
    s.t0 = now();
    return;
  }
  const rem = Math.max(0, s.remainingMs);
  s.elapsedPausedMs = Math.max(0, s.durationMs - rem);
  s.t0 = null;
}

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
  const payload = { ...s, serverNow: now() };
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
        const durationMs = Math.max(1000, Number(payload?.durationMs ?? s.durationMs));
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
        const rem = Math.max(0, remainingFromAuthoritative(s, n));
        s.status = "paused";
        s.remainingMs = rem;
        s.deadlineMs = null;
        s.updatedAt = n;
        syncLegacyFields(s);
        break;
      }

      case "resume": {
        if (s.status !== "paused") break;
        const rem = Math.max(0, s.remainingMs);
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
        const newDur = Math.max(1000, Number(payload?.durationMs ?? s.durationMs));
        const currentRem = Math.max(0, remainingFromAuthoritative(s, n));
        s.durationMs = newDur;

        if (s.status === "running") {
          const consumed = Math.max(0, newDur - currentRem);
          s.deadlineMs = n + (newDur - consumed);
          s.remainingMs = newDur - consumed;
        } else {
          s.remainingMs = Math.max(0, currentRem);
          s.deadlineMs = null;
        }
        s.updatedAt = n;
        syncLegacyFields(s);
        break;
      }

      // ✅ UPDATED: allow remainingMs to exceed durationMs by expanding duration
      case "adjustTime": {
        const delta = Number(payload?.deltaMs ?? 0);
        if (s.status === "running" && typeof s.deadlineMs === "number") {
          const minDeadline = n + 1000;
          s.deadlineMs = Math.max(minDeadline, s.deadlineMs + delta);
          const newRemaining = Math.max(0, s.deadlineMs - n);
          s.remainingMs = newRemaining;
          if (newRemaining > s.durationMs) s.durationMs = newRemaining;
          s.updatedAt = n;
          syncLegacyFields(s);
        } else {
          let newRem = s.remainingMs + delta;
          if (newRem < 0) newRem = 0;
          // expand duration if new remaining time exceeds it
          if (newRem > s.durationMs) s.durationMs = newRem;
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
        yf = Math.min(1, Math.max(0, yf));
        rf = Math.min(1, Math.max(0, rf));
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

// ---- Cleanup inactive rooms ----
const ROOM_TTL_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

setInterval(() => {
  const nowMs = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.clients.size === 0 && nowMs - room.state.updatedAt > ROOM_TTL_MS) {
      rooms.delete(roomId);
    }
  }
}, SWEEP_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Speaker Timer running on http://localhost:${PORT}`);
});
