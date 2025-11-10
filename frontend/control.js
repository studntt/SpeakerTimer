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
let state = {
  roomId: "DEMO",
  status: "idle",
  durationMs: DEFAULT_DURATION_MS,
  deadlineMs: null,
  remainingMs: DEFAULT_DURATION_MS,
  serverNow: Date.now(),
};

let syncedBaseRemainingMs = state.remainingMs;
let syncedReceivedAt = performance.now();
let lastInputEcho = "";
let pushedOnce = false;

// ---------- Utils ----------
function randomRoom() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
function fmt(ms) {
  ms = Math.max(0, Math.abs(ms));
  const s = Math.floor(ms / 1000),
    m = Math.floor(s / 60),
    r = s % 60;
  return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
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

// ---------- UI ----------
function setStatusPill(status) {
  if (!statusEl) return;
  statusEl.classList.remove("status-running", "status-paused", "status-finished");
  statusEl.classList.add("status-pill");
  statusEl.textContent = status.toUpperCase();
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
  }
  setStatusPill(state.status);
  setButtonsByStatus(state.status);
  echoTimeInputIfNeeded();
}

// ---------- WebSocket ----------
function connect(room) {
  if (ws) ws.close();
  setStatusPill("connecting");

  const url = new URL(location.origin.replace(/^http/, "ws") + "/ws");
  url.searchParams.set("room", room);
  url.searchParams.set("role", "control");
  ws = new WebSocket(url);

  ws.onopen = () => {
    try { ws.send(JSON.stringify({ type: "requestSnapshot" })); } catch {}
    if (!pushedOnce) {
      setTimeout(() => {
        setDuration(DEFAULT_DURATION_MS);
        pushedOnce = true;
      }, 100);
    }
  };

  ws.onerror = (err) => console.warn("[control] WebSocket error:", err);

  ws.onmessage = (ev) => {
    let parsed;
    try { parsed = JSON.parse(ev.data); } catch { return; }
    const { type, payload } = parsed || {};
    if (type !== "snapshot" || !payload) return;

    state.status = payload.status ?? state.status;
    state.durationMs = payload.durationMs ?? state.durationMs;
    state.serverNow = typeof payload.serverNow === "number" ? payload.serverNow : Date.now();

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
    updateUI();
  };

  ws.onclose = () => {
    setStatusPill("connecting");
    setTimeout(() => connect(room), 2500);
  };
}

function send(type, payload = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

// ---------- Commands ----------
function setDuration(ms) { send("setDuration", { durationMs: ms }); }
function start() { send("start", { durationMs: state.remainingMs }); }
function pause() { send("pause"); }
function resume() { send("resume"); }
function resetToDefault() {
  send("setDuration", { durationMs: DEFAULT_DURATION_MS });
  send("reset");
}

// ---------- Bindings ----------
document.getElementById("minus30")?.addEventListener("click", () => send("adjustTime", { deltaMs: -30_000 }));
document.getElementById("plus30")?.addEventListener("click", () => send("adjustTime", { deltaMs: 30_000 }));
document.getElementById("minus10")?.addEventListener("click", () => send("adjustTime", { deltaMs: -10_000 }));
document.getElementById("plus10")?.addEventListener("click", () => send("adjustTime", { deltaMs: 10_000 }));

Object.keys(presets).forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.style.display = "none";
  }
});

// ✅ Cleaned up start/resume/reset flow
startBtn?.addEventListener("click", () => {
  if (state.status === "paused") {
    resume();
  } else if (state.status === "idle" || state.status === "finished") {
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
  setTimeout(() => setDuration(DEFAULT_DURATION_MS), 50);
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
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isPanelOpen()) closePanel(); });

// Loop
function tick() {
  updateUI();
  requestAnimationFrame(tick);
}

// ===== Help Modal (subtle link + H shortcut) =====
const helpLink     = document.getElementById("helpLink");
const helpModal    = document.getElementById("helpModal");
const helpBackdrop = document.getElementById("helpBackdrop");
const helpClose    = document.getElementById("helpClose");
const helpClose2   = document.getElementById("helpClose2");

let lastFocusedEl = null;
let trapFocusHandler = null;
let modalKeyHandler = null;

function openHelp() {
  if (!helpModal || !helpBackdrop) return;
  if (!helpModal.hasAttribute("hidden")) return;

  lastFocusedEl = document.activeElement;

  helpBackdrop.hidden = false;
  helpModal.hidden = false;
  document.body.classList.add("no-scroll");

  // Focus trap inside modal
  const sel = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const nodes = helpModal.querySelectorAll(sel);
  const first = nodes[0];
  const last  = nodes[nodes.length - 1];

  trapFocusHandler = (e) => {
    if (e.key !== "Tab") return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };
  helpModal.addEventListener("keydown", trapFocusHandler);

  // Modal-level keys: Esc closes; H toggles close (debounced)
  let hArm = true;
  modalKeyHandler = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeHelp(); }
    if ((e.key === "h" || e.key === "H") && hArm) {
      e.preventDefault(); hArm = false; closeHelp(); setTimeout(()=>hArm=true,150);
    }
  };
  window.addEventListener("keydown", modalKeyHandler);

  (first || helpModal).focus();
}
function closeHelp() {
  if (!helpModal || helpModal.hasAttribute("hidden")) return;
  helpModal.hidden = true;
  helpBackdrop.hidden = true;
  document.body.classList.remove("no-scroll");

  if (trapFocusHandler) helpModal.removeEventListener("keydown", trapFocusHandler);
  if (modalKeyHandler) window.removeEventListener("keydown", modalKeyHandler);
  trapFocusHandler = null;
  modalKeyHandler = null;

  if (lastFocusedEl && typeof lastFocusedEl.focus === "function") lastFocusedEl.focus();
}

// Click handlers
helpLink?.addEventListener("click", (e) => { e.preventDefault(); openHelp(); });
helpClose?.addEventListener("click", closeHelp);
helpClose2?.addEventListener("click", closeHelp);
helpBackdrop?.addEventListener("click", closeHelp);

// Global H to open when closed (debounced)
(() => {
  let hArm = true;
  window.addEventListener("keydown", (e) => {
    if ((e.key === "h" || e.key === "H") && helpModal?.hasAttribute("hidden") && hArm) {
      e.preventDefault(); hArm = false; openHelp(); setTimeout(()=>hArm=true,150);
    }
  });
})();

// Init
(function init() {
  const room = (qs.get("room") || randomRoom()).toUpperCase();
  roomInput.value = room;
  updateDisplayLink(room);
  joinBtn.click();

  syncedBaseRemainingMs = DEFAULT_DURATION_MS;
  syncedReceivedAt = performance.now();

  if (roomPanel && panelToggle) {
    const saved = (() => { try { return localStorage.getItem(PANEL_LS_KEY); } catch { return null; } })();
    saved === "1" ? openPanel() : closePanel();
  }

  tick();
})();
