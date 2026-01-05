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
app.get("/control", (_req, res) => res.sendFile(path.join(FRONT, "control.html")));
app.get("/display", (_req, res) => res.sendFile(path.join(FRONT, "display.html")));

// HTTP + WS
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/**
 * Room state model:
 * - status: "idle" | "running" | "paused" | "finished"
 * - durationMs: configured duration (default 3:00, but can expand)
 * - deadlineMs: epoch ms when timer will hit 0 (authoritative when running)
 * - remainingMs: remaining time snapshot when paused/idle
 *
 * Snapshot contract additions (computed server-side):
 * - serverNow: epoch ms (set right before send)
 * - yellowAtMs / redAtMs: FIXED absolute thresholds (Option #1):
 *     yellowAtMs = 60_000 (1:00)
 *     redAtMs    = 30_000 (0:30)
 */
const rooms = new Map();

const now = () => Date.now();

// ws readyState constants (don’t rely on instance.OPEN)
const WS_OPEN = 1;

// ===== FIXED THRESHOLDS (Option #1) =====
const FIXED_YELLOW_AT_MS = 60_000;
const FIXED_RED_AT_MS = 30_000;

function normalizeRoomId(v) {
  const id = (v || "").toString().toUpperCase().slice(0, 8);
  return id || "DEMO";
}

function normalizeRole(v) {
  const r = (v || "display").toString().toLowerCase();
  return r === "control" ? "control" : "display";
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      state: {
        roomId,
        status: "idle",
        durationMs: 180_000,
        deadlineMs: null,
        remainingMs: 180_000,

        // legacy/back-compat fields (kept stable + meaningful)
        t0: null, // epoch ms start time when running, else null
        elapsedPausedMs: 0,

        // kept for back-compat; NOT used for display thresholds anymore
        thresholds: { yellowFrac: 0.5, redFrac: 0.1 },

        updatedAt: now(),
      },
      clients: new Set(),
      // cache last broadcast msg per tick to avoid rebuilding per-client
      _lastMsg: null,
      _lastMsgAt: 0,
    });
  }
  return rooms.get(roomId);
}

function clampNonNeg(n) {
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function remainingFromAuthoritative(s, at = now()) {
  if (s.status === "running" && typeof s.deadlineMs === "number") {
    return clampNonNeg(s.deadlineMs - at);
  }
  return clampNonNeg(s.remainingMs);
}

function syncLegacyFields(s, at = now()) {
  const rem = remainingFromAuthoritative(s, at);
  s.elapsedPausedMs = clampNonNeg((Number(s.durationMs) || 0) - rem);

  if (s.status === "running" && typeof s.deadlineMs === "number") {
    // stable start time for this run
    s.t0 = s.deadlineMs - (Number(s.durationMs) || 0);
  } else {
    s.t0 = null;
  }
}

/**
 * Finalize immediately when elapsed
 */
function finalizeIfElapsed(roomId, at = now()) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const s = room.state;
  if (s.status !== "running") return false;

  if (remainingFromAuthoritative(s, at) <= 0) {
    s.status = "finished";
    s.deadlineMs = null;
    s.remainingMs = 0;
    s.updatedAt = at;
    syncLegacyFields(s, at);
    return true;
  }
  return false;
}

function makeSnapshotPayload(s, serverNowMs) {
  return {
    ...s,
    yellowAtMs: FIXED_YELLOW_AT_MS,
    redAtMs: FIXED_RED_AT_MS,
    serverNow: serverNowMs,
  };
}

function buildSnapshotMessage(room) {
  const serverNowMs = now();

  // Always keep state consistent before snapshot
  finalizeIfElapsed(room.state.roomId, serverNowMs);
  syncLegacyFields(room.state, serverNowMs);

  return JSON.stringify({
    type: "snapshot",
    payload: makeSnapshotPayload(room.state, serverNowMs),
  });
}

function sendSnapshot(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const msg = buildSnapshotMessage(room);
  try {
    ws.send(msg);
  } catch {}
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const msg = buildSnapshotMessage(room);

  room.clients.forEach((ws) => {
    if (ws.readyState === WS_OPEN) {
      try {
        ws.send(msg);
      } catch {}
    }
  });
}

/**
 * High-frequency "authoritative heartbeat" snapshots
 * This is what removes the perceived lag between control and display.
 *
 * - We broadcast frequently ONLY when there are clients and the room is active-ish.
 * - Also covers cases where control page does local UI updates; the display stays tightly synced.
 */
const SNAPSHOT_TICK_MS = 100;

setInterval(() => {
  const t = now();

  for (const [roomId, room] of rooms.entries()) {
    if (!room || room.clients.size === 0) continue;

    const s = room.state;
    const active =
      s.status === "running" || s.status === "paused" || s.status === "finished";

    if (!active) continue;

    // finalize if needed (only matters when running)
    const changed = finalizeIfElapsed(roomId, t);

    // Build once per tick per room (cache by time bucket)
    // Note: we still include a fresh serverNow each tick.
    const msg = (() => {
      // Avoid rebuilding within same tick timestamp
      if (room._lastMsg && room._lastMsgAt === t) return room._lastMsg;
      const m = JSON.stringify({
        type: "snapshot",
        payload: makeSnapshotPayload(
          (() => {
            syncLegacyFields(s, t);
            return s;
          })(),
          t
        ),
      });
      room._lastMsg = m;
      room._lastMsgAt = t;
      return m;
    })();

    room.clients.forEach((ws) => {
      if (ws.readyState === WS_OPEN) {
        try {
          ws.send(msg);
        } catch {}
      }
    });

    // If we just transitioned to finished, keep broadcasting (clients will stop showing overtime anyway)
    // (no special handling needed; active includes finished)
    void changed;
  }
}, SNAPSHOT_TICK_MS);

function detachFromRoom(ws) {
  const prevRoomId = ws._roomId;
  if (!prevRoomId) return;

  const prevRoom = rooms.get(prevRoomId);
  if (prevRoom) prevRoom.clients.delete(ws);

  ws._roomId = null;
}

function attachToRoom(ws, roomId) {
  const id = normalizeRoomId(roomId);
  const room = ensureRoom(id);
  room.clients.add(ws);
  ws._roomId = id;
  return id;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Initial bind from URL
  const initialRoomId = normalizeRoomId(url.searchParams.get("room"));
  const initialRole = normalizeRole(url.searchParams.get("role"));

  ws._role = initialRole;
  attachToRoom(ws, initialRoomId);

  // Send initial snapshot immediately
  sendSnapshot(ws, ws._roomId);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    const { type, payload } = msg || {};

    // Allow dynamic room switching / leaving (fix for stale subscriptions)
    if (type === "join") {
      const nextRoomId = normalizeRoomId(payload?.roomId);
      const nextRole = normalizeRole(payload?.role ?? ws._role);

      ws._role = nextRole;

      const prevRoomId = ws._roomId;
      if (prevRoomId !== nextRoomId) {
        detachFromRoom(ws);
        attachToRoom(ws, nextRoomId);
      }

      sendSnapshot(ws, ws._roomId);
      return;
    }

    if (type === "leave") {
      detachFromRoom(ws);
      return;
    }

    // From here on, all actions apply to the socket's CURRENT room
    const roomId = ws._roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const role = ws._role || "display";

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

    // Finalize BEFORE applying any new command.
    const n = now();
    finalizeIfElapsed(roomId, n);

    const s = room.state;

    switch (type) {
      case "start": {
        const durationMs = Math.max(1000, Number(payload?.durationMs ?? s.durationMs));
        s.status = "running";
        s.durationMs = durationMs;
        s.remainingMs = durationMs;
        s.deadlineMs = n + durationMs;
        s.updatedAt = n;
        syncLegacyFields(s, n);
        break;
      }

      case "pause": {
        if (s.status !== "running") break;
        const rem = remainingFromAuthoritative(s, n);
        s.status = "paused";
        s.remainingMs = rem;
        s.deadlineMs = null;
        s.updatedAt = n;
        syncLegacyFields(s, n);
        break;
      }

      case "resume": {
        if (s.status !== "paused") break;
        const rem = clampNonNeg(s.remainingMs);
        s.status = "running";
        s.deadlineMs = n + rem;
        s.updatedAt = n;
        syncLegacyFields(s, n);
        break;
      }

      case "reset": {
        s.status = "idle";
        s.remainingMs = Math.max(0, Number(s.durationMs) || 0);
        s.deadlineMs = null;
        s.updatedAt = n;
        syncLegacyFields(s, n);
        break;
      }

      case "setDuration": {
        // preserve elapsed time when changing duration while running
        const newDur = Math.max(1000, Number(payload?.durationMs ?? s.durationMs));

        const oldDur = Math.max(1000, Number(s.durationMs) || 180_000);
        const currentRem = remainingFromAuthoritative(s, n);
        const elapsed = clampNonNeg(oldDur - currentRem);

        s.durationMs = newDur;

        if (s.status === "running") {
          const newRem = clampNonNeg(newDur - elapsed);
          s.remainingMs = newRem;
          s.deadlineMs = n + newRem;
        } else {
          const clampedRem = Math.min(currentRem, newDur);
          s.remainingMs = clampNonNeg(clampedRem);
          s.deadlineMs = null;
        }

        s.updatedAt = n;
        syncLegacyFields(s, n);
        break;
      }

      case "adjustTime": {
        const delta = Number(payload?.deltaMs ?? 0);

        if (s.status === "running" && typeof s.deadlineMs === "number") {
          const minDeadline = n + 1000;
          s.deadlineMs = Math.max(minDeadline, s.deadlineMs + delta);

          const newRemaining = remainingFromAuthoritative(s, n);
          s.remainingMs = newRemaining;

          if (newRemaining > s.durationMs) s.durationMs = newRemaining;

          s.updatedAt = n;
          syncLegacyFields(s, n);
        } else {
          let newRem = clampNonNeg(s.remainingMs + delta);
          if (newRem > s.durationMs) s.durationMs = newRem;
          s.remainingMs = newRem;
          s.updatedAt = n;
          s.deadlineMs = null;
          syncLegacyFields(s, n);
        }
        break;
      }

      case "setThresholds": {
        // Option #1: thresholds are FIXED server-side (1:00 / 0:30).
        // Keep message type for backwards-compat; store payload but don't change behavior.
        if (payload && typeof payload === "object") {
          const yf = Number(payload?.yellowFrac);
          const rf = Number(payload?.redFrac);
          if (Number.isFinite(yf) || Number.isFinite(rf)) {
            s.thresholds = {
              yellowFrac: Number.isFinite(yf) ? yf : s.thresholds?.yellowFrac ?? 0.5,
              redFrac: Number.isFinite(rf) ? rf : s.thresholds?.redFrac ?? 0.1,
            };
          }
        }
        s.updatedAt = n;
        break;
      }

      case "finish": {
        s.status = "finished";
        s.deadlineMs = null;
        s.remainingMs = 0;
        s.updatedAt = n;
        syncLegacyFields(s, n);
        break;
      }

      case "requestSnapshot": {
        // send the requester an immediate snapshot (useful if a client wants it)
        sendSnapshot(ws, roomId);
        return;
      }

      default:
        return;
    }

    // Edge safety: finalize + broadcast now (immediate, not waiting for tick)
    finalizeIfElapsed(roomId);
    broadcast(roomId);
  });

  ws.on("close", () => {
    detachFromRoom(ws);
  });
});

// ---- Cleanup inactive rooms ----
// Rooms are kept for 4 hours after last update if no clients are connected.
const ROOM_TTL_MS = 4 * 60 * 60_000; // 4 hours
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
