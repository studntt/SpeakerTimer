// control.js (authority-driven; adjustable default 3:00; reset restores default; free pre-start adjust)

const qs = new URLSearchParams(location.search);

// ===== DEFAULT DURATION (3:00) =====
const DEFAULT_DURATION_MS = 180_000;

// DOM
const roomInput   = document.getElementById("room");
const joinBtn     = document.getElementById("join");
const openDisplay = document.getElementById("openDisplay");
const statusEl    = document.getElementById("status");
const preview     = document.getElementById("preview");
const startBtn    = document.getElementById("start");
const pauseBtn    = document.getElementById("pause");
const resetBtn    = document.getElementById("reset");
const copyBtn     = document.getElementById("copyLink");

// Time controls disabled
const timeInput   = document.getElementById("timeInput");
const timeHint    = document.getElementById("timeHint");

const presets = {
  preset30: 30_000,
  preset60: 60_000,
  preset120: 120_000,
  preset180: 180_000,
  preset600: 600_000
};

let ws;

// Track the *currently intended* room + socket identity (prevents reconnect to old room)
let currentRoom = "DEMO";
let wsToken = 0; // increments each time we create a brand-new socket

// Reconnect guard (prevents stacking reconnect timers)
let reconnectTimer = null;

// Track rooms we've already "default-pushed" to avoid clobbering existing running rooms
const initializedRooms = new Set();

let state = {
  roomId: "DEMO",
  status: "idle",
  durationMs: DEFAULT_DURATION_MS,
  deadlineMs: null,
  remainingMs: DEFAULT_DURATION_MS,
  serverNow: Date.now(),
  yellowAtMs: undefined,
  redAtMs: undefined,
};

let syncedBaseRemainingMs = state.remainingMs;
let syncedReceivedAt = performance.now();
let lastInputEcho = "";
let pushedOnce = false;
let lastPhase = null; // track control preview phase

// ---------- Utils ----------
function randomRoom() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
function fmt(ms) {
  ms = Math.max(0, Math.abs(ms));
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const r = totalSeconds % 60;
  const mm = m >= 10 ? String(m).padStart(2, "0") : String(m);
  const rr = String(r).padStart(2, "0");
  return `${mm}:${rr}`;
}
function displayUrlFor(room) {
  const u = new URL(location.origin + "/display");
  u.searchParams.set("room", room);
  return u.toString();
}
function liveRemainingMs() {
  const nowMono = performance.now();
  if (state.status === "running") {
    const dt = nowMono - syncedReceivedAt;
    return Math.max(0, syncedBaseRemainingMs - dt);
  }
  return Math.max(0, syncedBaseRemainingMs);
}

// mirror display.js phase logic
function computePhase(remMs) {
  const yellowAt = typeof state.yellowAtMs === "number" ? state.yellowAtMs : 60_000;
  const redAt = typeof state.redAtMs === "number" ? state.redAtMs : 30_000;
  if (remMs <= 0) return "red";
  if (remMs <= redAt) return "red";
  if (remMs <= yellowAt) return "yellow";
  return "green";
}

function applyPhase(phase) {
  if (!preview) return;
  if (phase === lastPhase) return;
  lastPhase = phase;

  // same class set the display uses
  preview.classList.remove("phase-green", "phase-yellow", "phase-red", "overtime", "pulse");

  if (phase === "green") preview.classList.add("phase-green");
  else if (phase === "yellow") preview.classList.add("phase-yellow");
  else if (phase === "red") preview.classList.add("phase-red");
}

/**
 * Hotkey guard:
 * Don't trigger global hotkeys while the user is typing in an input/textarea/select
 * or any contenteditable element (prevents room code "H" conflict).
 */
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

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ---------- UI ----------
function setStatusPill(status) {
  if (!statusEl) return;
  statusEl.classList.remove("status-running", "status-paused", "status-finished");
  statusEl.classList.add("status-pill");
  statusEl.textContent = String(status || "").toUpperCase();
  if (status === "running") statusEl.classList.add("status-running");
  if (status === "paused") statusEl.classList.add("status-paused");
  if (status === "finished") statusEl.classList.add("status-finished");
}
function setButtonsByStatus(status) {
  if (startBtn) startBtn.textContent = status === "paused" ? "Resume" : "Start";
  if (pauseBtn) pauseBtn.disabled = status !== "running";
  if (timeInput) timeInput.disabled = true;
}
function updateDisplayLink(room) {
  if (!openDisplay) return;
  const href = displayUrlFor(room);
  openDisplay.href = href;
  openDisplay.textContent = "Open Display";
  openDisplay.target = "_blank";
  if (copyBtn) copyBtn.dataset.href = href;
}
function echoTimeInputIfNeeded() {
  if (!timeInput) return;
  const desired = fmt(state.remainingMs || DEFAULT_DURATION_MS);
  if (document.activeElement === timeInput) timeInput.blur();
  if (desired !== lastInputEcho) {
    timeInput.value = desired;
    lastInputEcho = desired;
  }
}
function setTimeHint(msg = "") {
  if (!timeHint) return;
  timeHint.textContent = msg;
  timeHint.style.visibility = "hidden";
}
function updateUI() {
  const rem = liveRemainingMs();
  if (preview) {
    const floored = Math.floor(rem / 1000) * 1000;
    preview.textContent = fmt(floored);
    applyPhase(computePhase(floored));
  }
  setStatusPill(state.status);
  setButtonsByStatus(state.status);
  echoTimeInputIfNeeded();
}

// ---------- WebSocket ----------
function wsUrlFor(room) {
  const url = new URL(location.origin.replace(/^http/, "ws") + "/ws");
  url.searchParams.set("room", room);
  url.searchParams.set("role", "control");
  return url.toString();
}

function resetLocalViewForRoom(room) {
  state.roomId = room;
  state.status = "idle";
  state.durationMs = DEFAULT_DURATION_MS;
  state.deadlineMs = null;
  state.remainingMs = DEFAULT_DURATION_MS;
  state.serverNow = Date.now();
  state.yellowAtMs = undefined;
  state.redAtMs = undefined;

  syncedBaseRemainingMs = DEFAULT_DURATION_MS;
  syncedReceivedAt = performance.now();
  lastPhase = null;
  updateUI();
}

function connect(room) {
  room = (room || "DEMO").toUpperCase().slice(0, 8) || "DEMO";
  currentRoom = room;

  clearReconnect();

  // Always update UI link + local render baseline immediately
  updateDisplayLink(room);
  resetLocalViewForRoom(room);

  // If we already have an OPEN socket, do NOT create a second connection.
  // Instead, switch rooms on the same socket (server supports type:"join").
  if (ws && ws.readyState === WebSocket.OPEN) {
    setStatusPill("connecting");
    try {
      ws.send(JSON.stringify({ type: "join", payload: { roomId: room, role: "control" } }));
      ws.send(JSON.stringify({ type: "requestSnapshot" }));
    } catch {}
    return;
  }

  // If there’s a socket that’s CONNECTING/CLOSING, close it and replace.
  try { ws?.close(); } catch {}

  setStatusPill("connecting");

  const myToken = ++wsToken; // this socket's identity
  ws = new WebSocket(wsUrlFor(room));

  ws.onopen = () => {
    if (myToken !== wsToken) return;

    try {
      ws.send(JSON.stringify({ type: "join", payload: { roomId: currentRoom, role: "control" } }));
      ws.send(JSON.stringify({ type: "requestSnapshot" }));
    } catch {}

    if (!pushedOnce) {
      setTimeout(() => {
        if (myToken !== wsToken) return;
        pushedOnce = true;
      }, 50);
    }
  };

  ws.onerror = (err) => console.warn("[control] WebSocket error:", err);

  ws.onmessage = (ev) => {
    let parsed;
    try { parsed = JSON.parse(ev.data); } catch { return; }
    const { type, payload } = parsed || {};
    if (type !== "snapshot" || !payload) return;

    const snapRoom = (payload.roomId || "").toUpperCase();
    if (snapRoom && snapRoom !== currentRoom) return;

    state.roomId = snapRoom || currentRoom;
    state.status = payload.status ?? state.status;
    state.durationMs = payload.durationMs ?? state.durationMs;
    state.serverNow = typeof payload.serverNow === "number" ? payload.serverNow : Date.now();

    // server now provides these; still tolerate missing
    state.yellowAtMs = typeof payload.yellowAtMs === "number" ? payload.yellowAtMs : state.yellowAtMs;
    state.redAtMs = typeof payload.redAtMs === "number" ? payload.redAtMs : state.redAtMs;

    const nowMono = performance.now();
    if (state.status === "running" && typeof payload.deadlineMs === "number") {
      const base = payload.deadlineMs - state.serverNow;
      syncedBaseRemainingMs = Math.max(0, base);
      syncedReceivedAt = nowMono;
      state.deadlineMs = payload.deadlineMs;
      state.remainingMs = undefined;
    } else {
      const rem = typeof payload.remainingMs === "number" ? payload.remainingMs : state.remainingMs;
      syncedBaseRemainingMs = Math.max(0, rem);
      syncedReceivedAt = nowMono;
      state.deadlineMs = null;
      state.remainingMs = rem;
    }

    // Safer default push: only once per room, only if room is idle (don’t clobber running/paused rooms)
    if (!initializedRooms.has(state.roomId) && state.status === "idle") {
      initializedRooms.add(state.roomId);
      setTimeout(() => {
        if (ws?.readyState === WebSocket.OPEN && state.roomId === currentRoom && state.status === "idle") {
          setDuration(DEFAULT_DURATION_MS);
        }
      }, 75);
    }

    lastPhase = null;
    updateUI();
  };

  ws.onclose = () => {
    const stillActiveSocket = (myToken === wsToken);
    const intendedRoom = currentRoom;

    setStatusPill("connecting");
    if (!stillActiveSocket) return;

    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (myToken !== wsToken) return;
      connect(intendedRoom);
    }, 2500);
  };
}

function send(type, payload = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

// ---------- Commands ----------
function setDuration(ms) { send("setDuration", { durationMs: ms }); }
function start() { send("start", { durationMs: state.remainingMs ?? DEFAULT_DURATION_MS }); }
function pause() { send("pause"); }
function resume() { send("resume"); }
function resetToDefault() {
  // FIX: previously sent the wrong payload shape to setDuration
  setDuration(DEFAULT_DURATION_MS);
  send("reset");
}

// ---------- Bindings ----------
document.getElementById("minus30")?.addEventListener("click", () =>
  send("adjustTime", { deltaMs: -30_000 })
);
document.getElementById("plus30")?.addEventListener("click", () =>
  send("adjustTime", { deltaMs: 30_000 })
);
document.getElementById("minus10")?.addEventListener("click", () =>
  send("adjustTime", { deltaMs: -10_000 })
);
document.getElementById("plus10")?.addEventListener("click", () =>
  send("adjustTime", { deltaMs: 10_000 })
);

Object.keys(presets).forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.style.display = "none";
  }
});

// ✅ Start / resume / restart-from-zero flow
startBtn?.addEventListener("click", () => {
  const rem = liveRemainingMs();

  // If we're effectively at 0, always treat Start as "new 3:00 round"
  if (rem <= 1000) {
    syncedBaseRemainingMs = DEFAULT_DURATION_MS;
    syncedReceivedAt = performance.now();
    state.remainingMs = DEFAULT_DURATION_MS;
    state.durationMs = DEFAULT_DURATION_MS;

    setDuration(DEFAULT_DURATION_MS);
    send("start", { durationMs: DEFAULT_DURATION_MS });
    return;
  }

  if (state.status === "paused") {
    resume();
    return;
  }

  if (state.status === "idle" || state.status === "finished") {
    start();
  }
});

pauseBtn?.addEventListener("click", () => pause());
resetBtn?.addEventListener("click", () => resetToDefault());

if (timeInput) {
  timeInput.disabled = true;
  timeInput.readOnly = true;
  timeInput.style.display = "none";
}
if (timeHint) timeHint.style.display = "none";

// Copy display link
copyBtn?.addEventListener("click", async () => {
  const href = copyBtn.dataset.href || openDisplay?.href || "";
  if (!href) return;
  try {
    await navigator.clipboard.writeText(href);
    const prev = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = prev), 1200);
  } catch {}
});

// Join flow
joinBtn.onclick = () => {
  const room = roomInput.value.trim().toUpperCase() || randomRoom();
  roomInput.value = room;
  history.replaceState(null, "", `?room=${room}`);
  updateDisplayLink(room);

  connect(room);
  updateUI();
};

// Button color classes
document.getElementById("minus30")?.classList.add("btn-red");
document.getElementById("plus30")?.classList.add("btn-light-green");
startBtn?.classList.add("btn-dark-green");
pauseBtn?.classList.add("btn-yellow");

// Dropdown panel
const PANEL_LS_KEY = "controlRoomPanelOpen";
const panelToggle = document.getElementById("panelToggle");
const roomPanel = document.getElementById("roomPanel");

function isPanelOpen() { return roomPanel?.classList.contains("is-open"); }
function openPanel() {
  if (!roomPanel || !panelToggle) return;
  roomPanel.classList.add("is-open");
  roomPanel.classList.remove("is-closed");
  roomPanel.setAttribute("aria-hidden", "false");
  panelToggle.setAttribute("aria-expanded", "true");
  try { localStorage.setItem(PANEL_LS_KEY, "1"); } catch {}
}
function closePanel() {
  if (!roomPanel || !panelToggle) return;
  roomPanel.classList.remove("is-open");
  roomPanel.classList.add("is-closed");
  roomPanel.setAttribute("aria-hidden", "true");
  panelToggle.setAttribute("aria-expanded", "false");
  try { localStorage.setItem(PANEL_LS_KEY, "0"); } catch {}
}
function togglePanel() { isPanelOpen() ? closePanel() : openPanel(); }

panelToggle?.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(); });
document.addEventListener("click", (e) => {
  if (!roomPanel || !panelToggle || !isPanelOpen()) return;
  const inside = roomPanel.contains(e.target) || panelToggle.contains(e.target);
  if (!inside) closePanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isPanelOpen()) closePanel();
});

// Loop
function tick() {
  updateUI();
  requestAnimationFrame(tick);
}

// Init
(function init() {
  const room = (qs.get("room") || randomRoom()).toUpperCase();
  roomInput.value = room;
  updateDisplayLink(room);
  joinBtn.click();

  syncedBaseRemainingMs = DEFAULT_DURATION_MS;
  syncedReceivedAt = performance.now();

  if (roomPanel && panelToggle) {
    const saved = (() => {
      try { return localStorage.getItem(PANEL_LS_KEY); }
      catch { return null; }
    })();
    saved === "1" ? openPanel() : closePanel();
  }

  tick();
})();
