// display.js (authoritative-deadline client; fixed thresholds; stable flashing + end alarm w/ reset-stop)

const qs = new URLSearchParams(location.search);

let connected = false;
let els = {
  count: null,
  statusMsg: null,
  subline: null,
  stage: null,
};

// Local view state (render-only). We no longer use t0/elapsed for math.
let state = {
  roomId: "DEMO",
  status: "idle",
  // For first paint only; real time comes from server snapshots.
  durationMs: 180_000,
  metadata: { speakerName: "", topic: "" },

  // Optional server-provided concrete thresholds (ms). If absent, we use 60s / 30s.
  yellowAtMs: undefined,
  redAtMs: undefined,

  // Authoritative timing fields mirrored from server snapshots:
  // - When running:   we receive { deadlineMs, serverNow } and compute a base remaining.
  // - When paused/idle: we receive { remainingMs } and use that as base.
  deadlineMs: null,
  remainingMs: 180_000,
};

// Latency-compensated base remaining.
let syncedBaseRemainingMs = state.remainingMs;
let syncedReceivedAt = performance.now();

// Track last applied phase so we don't restart CSS animations every frame
let lastPhase = null; // "green" | "yellow" | "red" | null

// ---------- Flash overlay (3-pulse, full-screen) ----------
const flash = {
  overlay: null,
  styleEl: null,
  didYellow: false,
  didRed: false,
  ensure() {
    if (this.overlay) return;
    const prefersReduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dur = prefersReduce ? 700 : 500;        // per-iteration ms
    const iters = prefersReduce ? 1 : 3;          // pulses
    const total = dur * iters + 100;              // safety buffer

    const css = `
      @keyframes st-flash {
        0%, 100% { opacity: 0; }
        50%     { opacity: 0.9; }
      }
      .st-flash-overlay {
        position: fixed; inset: 0; pointer-events: none;
        z-index: 2147483646; opacity: 0; display: none;
        mix-blend-mode: normal;
      }
      .st-flash-yellow {
        background: #facc15;
        animation: st-flash ${dur}ms ease-in-out ${iters};
      }
      .st-flash-red {
        background: #ef4444;
        animation: st-flash ${dur}ms ease-in-out ${iters};
      }
    `;
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = css;
    document.head.appendChild(this.styleEl);

    this.overlay = document.createElement("div");
    this.overlay.className = "st-flash-overlay";
    document.body.appendChild(this.overlay);

    this._totalMs = total;
  },
  trigger(color) {
    this.ensure();
    const o = this.overlay;
    if (!o) return;
    o.classList.remove("st-flash-yellow", "st-flash-red");
    o.style.display = "block";
    // Force reflow so animation restarts reliably
    // eslint-disable-next-line no-unused-expressions
    o.offsetHeight;
    o.classList.add(color === "red" ? "st-flash-red" : "st-flash-yellow");
    setTimeout(() => {
      o.classList.remove("st-flash-yellow", "st-flash-red");
      o.style.display = "none";
    }, this._totalMs);
  },
  resetFlags() {
    this.didYellow = false;
    this.didRed = false;
  },
};

// ---------- End-of-timer alarm (Display-only) ----------
const alarm = {
  audio: null,
  armed: false,       // set true after a user gesture unlocks audio
  didPlay: false,     // ensures one-shot per run
  hadPositive: false, // becomes true once we’ve seen rem>0 while running

  ensureAudio() {
    if (this.audio) return;
    this.audio = new Audio("/audio/alarm2.mp3");
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
        }).catch(() => { /* will arm on next gesture */ });
      } else {
        this.armed = true;
      }
    } catch { /* ignore */ }
  },

  tryPlayOnce() {
    if (!this.armed || this.didPlay) return;
    this.ensureAudio();
    try {
      this.audio.currentTime = 0;
      const p = this.audio.play();
      if (p && typeof p.then === "function") {
        p.then(() => { this.didPlay = true; }).catch(() => {});
      } else {
        this.didPlay = true;
      }
    } catch { /* ignore */ }
  },

  stop() {
    if (!this.audio) return;
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
    } catch { /* ignore */ }
  },

  reset() {
    this.didPlay = false;
    this.hadPositive = false;
  }
};

// ---------- Utilities ----------
function fmt(ms) {
  // MM:SS, clamped at 0 (no negative sign on display)
  ms = Math.max(0, Math.abs(ms));
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

// Remaining time derived from authoritative base + local monotonic clock.
function liveRemainingMs() {
  const nowMono = performance.now();
  if (state.status === "running") {
    const dt = nowMono - syncedReceivedAt;
    return Math.max(0, syncedBaseRemainingMs - dt);
  }
  return Math.max(0, syncedBaseRemainingMs);
}

function ensureStatusMsg() {
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
  const yellowAt = typeof state.yellowAtMs === "number" ? state.yellowAtMs : 60_000; // 1:00
  const redAt = typeof state.redAtMs === "number" ? state.redAtMs : 30_000; // 0:30

  if (remMs <= 0) return "red"; // clamp end-state to red
  if (remMs <= redAt) return "red";
  if (remMs <= yellowAt) return "yellow";
  return "green";
}

function applyPhase(phase) {
  if (!els.count) return;
  if (phase === lastPhase) return;
  lastPhase = phase;

  els.count.classList.remove(
    "phase-green",
    "phase-yellow",
    "phase-red",
    "overtime",
    "pulse"
  );

  if (phase === "green") {
    els.count.classList.add("phase-green");
    return;
  }
  if (phase === "yellow") {
    els.count.classList.add("phase-yellow", "pulse");
    if (!flash.didYellow) {
      flash.didYellow = true;
      flash.trigger("yellow");
    }
    return;
  }
  if (phase === "red") {
    els.count.classList.add("phase-red", "pulse");
    if (!flash.didRed) {
      flash.didRed = true;
      flash.trigger("red");
    }
    return;
  }
}

function renderSubline() {
  if (!els.subline) return;
  const name = state.metadata?.speakerName?.trim();
  const topic = state.metadata?.topic?.trim();
  els.subline.textContent = name || topic ? [name, topic].filter(Boolean).join(" · ") : "";
  els.subline.style.display = els.subline.textContent ? "block" : "none";
}

// ---------- Render loop ----------
function tick() {
  const rem = liveRemainingMs(); // already clamped >= 0

  // Track whether we ever had time left during this run
  if (state.status === "running" && rem > 0) {
    alarm.hadPositive = true;
  }

  // Alarm: play once when we FIRST hit 0 after having been >0 in this run
  if (state.status === "running" && rem === 0 && alarm.hadPositive && !alarm.didPlay) {
    alarm.tryPlayOnce();
  }

  applyPhase(computePhase(rem));
  if (els.count) {
    // Floor to seconds for stable, identical display across clients.
    const floored = Math.floor(rem / 1000) * 1000;
    els.count.textContent = fmt(floored);
  }

  requestAnimationFrame(tick);
}

// ---------- WebSocket ----------
function connect(room) {
  let url;
  try {
    url = new URL(location.origin.replace(/^http/, "ws") + "/ws");
  } catch (e) {
    console.error("[display] Invalid WS URL:", e);
    return;
  }
  url.searchParams.set("room", room);
  url.searchParams.set("role", "display");
  const ws = new WebSocket(url);

  ws.onopen = () => {
    connected = true;
    const badge = ensureStatusMsg();
    badge.textContent = "";
    badge.style.display = "none";
  };

  ws.onclose = () => {
    connected = false;
    const badge = ensureStatusMsg();
    badge.textContent = "Reconnecting…";
    badge.style.display = "block";
    setTimeout(() => connect(room), 800);
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

    // Merge non-timing metadata first
    state.roomId = payload.roomId ?? state.roomId;
    state.status = payload.status ?? state.status;
    state.durationMs = typeof payload.durationMs === "number" ? payload.durationMs : state.durationMs;
    state.metadata = payload.metadata ?? state.metadata;

    // Optional concrete thresholds (server may omit)
    state.yellowAtMs = typeof payload.yellowAtMs === "number" ? payload.yellowAtMs : state.yellowAtMs;
    state.redAtMs = typeof payload.redAtMs === "number" ? payload.redAtMs : state.redAtMs;

    // Authoritative timing handling
    const serverNow = typeof payload.serverNow === "number" ? payload.serverNow : Date.now();
    const hasDeadline = typeof payload.deadlineMs === "number";
    const nowMono = performance.now();

    if (state.status === "running" && hasDeadline) {
      const base = payload.deadlineMs - serverNow;
      syncedBaseRemainingMs = Math.max(0, base);
      syncedReceivedAt = nowMono;
      state.deadlineMs = payload.deadlineMs;
      state.remainingMs = undefined;
    } else if (state.status === "paused" || state.status === "idle" || state.status === "finished") {
      const rem = typeof payload.remainingMs === "number" ? payload.remainingMs : 0;
      syncedBaseRemainingMs = Math.max(0, rem);
      syncedReceivedAt = nowMono;
      state.deadlineMs = null;
      state.remainingMs = rem;
    }

    // Detect reset → clear flags and stop any ongoing alarm.
    if (
      state.status === "idle" &&
      (typeof state.durationMs === "number") &&
      Math.abs(syncedBaseRemainingMs - state.durationMs) < 50
    ) {
      flash.resetFlags();
      alarm.stop();
      alarm.reset();
    }
    if (prevStatus !== "idle" && state.status === "idle") {
      flash.resetFlags();
      alarm.stop();
      alarm.reset();
    }

    // Hide badge if we got a good snapshot
    if (!connected) {
      const badge = ensureStatusMsg();
      badge.textContent = "";
      badge.style.display = "none";
    }

    renderSubline();
    lastPhase = null;
  };

  ws.onerror = (e) => {
    console.warn("[display] WebSocket error:", e?.message || e);
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

  if (!els.count) console.warn('[display] Missing element: #count (required).');
  if (!els.stage) console.warn('[display] Missing element: #stage (fullscreen).');
  if (!els.subline) console.info('[display] Optional missing: #subline.');
  if (!els.statusMsg) console.info('[display] Optional missing: #statusMsg.');
}

(function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
    return;
  }

  bindDom();
  flash.ensure();      // prepare overlay/css once
  alarm.ensureAudio(); // prepare audio

  // Safe first paint before first snapshot arrives
  applyPhase("green");
  if (els.count) els.count.textContent = fmt(state.durationMs);
  syncedBaseRemainingMs = state.durationMs;
  syncedReceivedAt = performance.now();

  const room = (qs.get("room") || "DEMO").toUpperCase();
  connect(room);
  requestAnimationFrame(tick);

  // Use user gestures to arm audio (required on mobile)
  if (els.stage) {
    els.stage.addEventListener("click", () => {
      toggleFullscreen();
      alarm.arm();
    });
  }
  window.addEventListener("keydown", (e) => {
    if (e.key && e.key.toLowerCase() === "f") toggleFullscreen();
    // Any keydown counts as a gesture to arm audio
    alarm.arm();
  });
})();
