// display.js (authoritative-deadline client; fixed thresholds; NO flashing; end alarm w/ reset-stop + fullscreen-safe overlay + 2.5s alarm limit)

const qs = new URLSearchParams(location.search);

let connected = false;
let els = {
  count: null,
  statusMsg: null,
  subline: null,
  stage: null,
  expiredMsg: null,
};

// Local view state (render-only)
let state = {
  roomId: "DEMO",
  status: "idle",
  durationMs: 180_000,
  metadata: { speakerName: "", topic: "" },
  yellowAtMs: undefined,
  redAtMs: undefined,
  deadlineMs: null,
  remainingMs: 180_000,
};

let syncedBaseRemainingMs = state.remainingMs;
let syncedReceivedAt = performance.now();
let lastPhase = null;

/**
 * Socket/reconnect guard:
 * Ensure only ONE websocket + ONE reconnect timer exist at a time.
 */
let wsRef = null;
let reconnectTimer = null;
let reconnectRoom = null;

// Track expired banner visibility so alarm plays ONCE per "show" cycle
let expiredShown = false;

// ---------- Typing guard ----------
function isTypingContext(e) {
  if (e?.metaKey || e?.ctrlKey || e?.altKey) return true;

  const el = document.activeElement;
  if (!el) return false;

  if (el.isContentEditable) return true;

  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;

  if (el.closest && el.closest('[contenteditable="true"]')) return true;

  return false;
}

// ---------- Flash overlay (disabled; no DOM/CSS injected) ----------
const flash = {
  didYellow: false,
  didRed: false,
  ensure() {},
  trigger(_color) {},
  resetFlags() {
    this.didYellow = false;
    this.didRed = false;
  },
};

// ---------- End-of-timer alarm ----------
const alarm = {
  audio: null,
  armed: false,
  hadPositive: false,
  ensureAudio() {
    if (this.audio) return;
    this.audio = new Audio("/audio/alarm.mp3");
    this.audio.preload = "auto";
    this.audio.volume = 0.35;
  },
  arm() {
    if (this.armed) return;
    this.ensureAudio();
    try {
      const p = this.audio.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          this.audio.pause();
          this.audio.currentTime = 0;
          this.armed = true;
        }).catch(() => {});
      } else {
        this.armed = true;
      }
    } catch {}
  },
  playLimited() {
    // Plays every time the "expired" message appears (once per show cycle),
    // but still requires a user gesture to arm audio.
    if (!this.armed) return;

    this.ensureAudio();
    try {
      // Restart from the top cleanly
      this.stop();
      this.audio.currentTime = 0;

      const p = this.audio.play();
      const stopAfter = () => {
        setTimeout(() => this.stop(), 2500);
      };

      if (p && typeof p.then === "function") {
        p.then(stopAfter).catch(() => {});
      } else {
        stopAfter();
      }
    } catch {}
  },
  stop() {
    if (!this.audio) return;
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
    } catch {}
  },
  reset() {
    this.hadPositive = false;
    // keep armed state; user gesture arms it
  },
};

// ---------- Utils ----------
function fmt(ms) {
  ms = Math.max(0, Math.abs(ms));
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const r = totalSeconds % 60;
  const mm = m >= 10 ? String(m).padStart(2, "0") : String(m);
  const rr = String(r).padStart(2, "0");
  return `${mm}:${rr}`;
}

function liveRemainingMs() {
  const nowMono = performance.now();
  return state.status === "running"
    ? Math.max(0, syncedBaseRemainingMs - (nowMono - syncedReceivedAt))
    : Math.max(0, syncedBaseRemainingMs);
}

function ensureStatusMsg() {
  // Prefer an existing DOM element if it appears later
  const existing = document.getElementById("statusMsg");
  if (existing && existing.nodeType === 1) {
    els.statusMsg = existing;
    return existing;
  }

  if (els.statusMsg && els.statusMsg.nodeType === 1) return els.statusMsg;

  const fallback = document.createElement("div");
  fallback.id = "statusMsg";
  fallback.style.cssText =
    "position:fixed;top:10px;left:50%;transform:translateX(-50%);padding:.4rem .6rem;border-radius:.5rem;font:500 12px/1.2 system-ui, sans-serif;background:rgba(0,0,0,.6);color:#fff;z-index:2147483647;display:none";
  document.body.appendChild(fallback);
  els.statusMsg = fallback;
  return fallback;
}

function computePhase(remMs) {
  const yellowAt = typeof state.yellowAtMs === "number" ? state.yellowAtMs : 60_000;
  const redAt = typeof state.redAtMs === "number" ? state.redAtMs : 30_000;
  if (remMs <= 0) return "red";
  if (remMs <= redAt) return "red";
  if (remMs <= yellowAt) return "yellow";
  return "green";
}

function applyPhase(phase) {
  if (!els.count) return;
  if (phase === lastPhase) return;
  lastPhase = phase;

  els.count.classList.remove("phase-green", "phase-yellow", "phase-red", "overtime", "pulse");

  if (phase === "green") els.count.classList.add("phase-green");
  else if (phase === "yellow") els.count.classList.add("phase-yellow");
  else if (phase === "red") els.count.classList.add("phase-red");
}

function renderSubline() {
  if (!els.subline) return;
  const name = state.metadata?.speakerName?.trim();
  const topic = state.metadata?.topic?.trim();
  els.subline.textContent = name || topic ? [name, topic].filter(Boolean).join(" · ") : "";
  els.subline.style.display = els.subline.textContent ? "block" : "none";
}

function resetVisualAndAlarm() {
  flash.resetFlags();
  alarm.stop();
  alarm.reset();
  expiredShown = false;
  if (els.expiredMsg) els.expiredMsg.hidden = true;
}

// ---------- Loop ----------
function tick() {
  const rem = liveRemainingMs();

  if (state.status === "running" && rem > 0) alarm.hadPositive = true;

  const showExpired =
    rem === 0 &&
    (state.status === "running" || state.status === "paused" || state.status === "finished");

  // ✅ Play sound each time the expired message APPEARS (once per show cycle)
  if (showExpired && !expiredShown) {
    expiredShown = true;
    alarm.playLimited();
  }
  if (!showExpired && expiredShown) {
    expiredShown = false;
  }

  if (els.expiredMsg) {
    els.expiredMsg.textContent = showExpired ? "Your time has expired!!!" : "";
    els.expiredMsg.hidden = !showExpired;
  }

  applyPhase(computePhase(rem));
  if (els.count) els.count.textContent = fmt(Math.floor(rem / 1000) * 1000);

  requestAnimationFrame(tick);
}

// ---------- WebSocket ----------
function wsUrlForRoom(room) {
  return new URL(
    location.origin.replace(/^http/, "ws") +
      "/ws?room=" +
      encodeURIComponent(room) +
      "&role=display"
  );
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(room) {
  clearReconnect();
  reconnectRoom = room;
  const badge = ensureStatusMsg();
  badge.textContent = "Reconnecting…";
  badge.style.display = "block";

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(reconnectRoom);
  }, 2500);
}

function cleanupSocket() {
  if (!wsRef) return;
  try {
    wsRef.onopen = null;
    wsRef.onclose = null;
    wsRef.onmessage = null;
    wsRef.onerror = null;
  } catch {}
  try {
    if (wsRef.readyState === WebSocket.OPEN || wsRef.readyState === WebSocket.CONNECTING) {
      wsRef.close();
    }
  } catch {}
  wsRef = null;
}

function connect(room) {
  // Guard: if we already have a live/connecting socket for this room, don't stack another
  if (wsRef && (wsRef.readyState === WebSocket.OPEN || wsRef.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearReconnect();
  cleanupSocket();

  let url;
  try {
    url = wsUrlForRoom(room);
  } catch (e) {
    console.error("[display] Invalid WS URL:", e);
    return;
  }

  const ws = new WebSocket(url);
  wsRef = ws;

  ws.onopen = () => {
    connected = true;
    const badge = ensureStatusMsg();
    badge.textContent = "";
    badge.style.display = "none";
  };

  ws.onclose = () => {
    connected = false;
    // If we intentionally cleaned up, don't schedule.
    if (wsRef !== ws) return;
    wsRef = null;
    scheduleReconnect(room);
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      console.warn("[display] Non-JSON message:", ev.data);
      return;
    }

    const { type, payload } = msg || {};
    if (type !== "snapshot" || !payload || typeof payload !== "object") return;

    const prevStatus = state.status;

    state.roomId = payload.roomId ?? state.roomId;
    state.status = payload.status ?? state.status;
    state.durationMs = typeof payload.durationMs === "number" ? payload.durationMs : state.durationMs;
    state.metadata = payload.metadata ?? state.metadata;

    // Server now provides these; still tolerate missing
    state.yellowAtMs = typeof payload.yellowAtMs === "number" ? payload.yellowAtMs : state.yellowAtMs;
    state.redAtMs = typeof payload.redAtMs === "number" ? payload.redAtMs : state.redAtMs;

    const serverNow = typeof payload.serverNow === "number" ? payload.serverNow : Date.now();
    const hasDeadline = typeof payload.deadlineMs === "number";
    const nowMono = performance.now();

    if (state.status === "running" && hasDeadline) {
      const base = payload.deadlineMs - serverNow;
      syncedBaseRemainingMs = Math.max(0, base);
      syncedReceivedAt = nowMono;
      state.deadlineMs = payload.deadlineMs;
      state.remainingMs = undefined;
    } else {
      const rem = typeof payload.remainingMs === "number" ? payload.remainingMs : 0;
      syncedBaseRemainingMs = Math.max(0, rem);
      syncedReceivedAt = nowMono;
      state.deadlineMs = null;
      state.remainingMs = rem;
    }

    // Reset alarm/expired UI reliably when transitioning to idle
    if (prevStatus !== "idle" && state.status === "idle") {
      resetVisualAndAlarm();
    } else if (
      state.status === "idle" &&
      typeof state.durationMs === "number" &&
      Math.abs(syncedBaseRemainingMs - state.durationMs) < 50
    ) {
      resetVisualAndAlarm();
    }

    // If connected but badge still showing for any reason, hide it
    if (connected) {
      const badge = ensureStatusMsg();
      badge.textContent = "";
      badge.style.display = "none";
    }

    renderSubline();
    lastPhase = null;
  };

  ws.onerror = (err) => {
    connected = false;
    // Don't spam; close will handle reconnect scheduling
    console.warn("[display] WebSocket error:", err?.message || err);
  };
}

// ---------- Fullscreen ----------
function toggleFullscreen() {
  if (!els.stage) return;
  if (!document.fullscreenElement) els.stage.requestFullscreen?.();
  else document.exitFullscreen?.();
}

// ---------- Init ----------
function bindDom() {
  els.count = document.getElementById("count");
  els.statusMsg = document.getElementById("statusMsg");
  els.subline = document.getElementById("subline");
  els.stage = document.getElementById("stage");
  els.expiredMsg = document.getElementById("expiredMsg");
  if (!els.count) console.warn("[display] Missing element: #count.");
  if (!els.stage) console.warn("[display] Missing element: #stage.");
}

(function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
    return;
  }

  bindDom();
  flash.ensure();
  alarm.ensureAudio();

  applyPhase("green");
  if (els.count) els.count.textContent = fmt(state.durationMs);
  syncedBaseRemainingMs = state.durationMs;
  syncedReceivedAt = performance.now();

  const room = (qs.get("room") || "DEMO").toUpperCase();
  connect(room);
  requestAnimationFrame(tick);

  if (els.stage) {
    els.stage.addEventListener("click", () => {
      toggleFullscreen();
      alarm.arm();
    });
  }

  window.addEventListener("keydown", (e) => {
    if (isTypingContext(e)) return;

    if (e.key?.toLowerCase() === "f") toggleFullscreen();
    alarm.arm();
  });
})();
