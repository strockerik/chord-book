// Core utilities: Supabase initialization, Auth gate, XSS-safe esc(),
// per-user localStorage, accessible sheets, toast + Undo, and offline write queue.

export const APP_VERSION = "0.6.2";

export function esc(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Deliberately broad. Genre lives in layout_prefs; songs without one are Worship.
export const GENRES = [
  { id: "worship", label: "Worship" },
  { id: "country", label: "Country & Folk" },
  { id: "rock", label: "Rock & Alternative" },
  { id: "pop", label: "Pop & Other" }
];

export function getSongGenre(song) {
  const id = song?.layout_prefs?.genre;
  return GENRES.some((g) => g.id === id) ? id : "worship";
}

// Per-account local storage keys (SPEC 2.4 & 9)
let currentUserId = "local";

export function setCurrentUserId(uid) {
  currentUserId = uid || "local";
}

export function getCurrentUserId() {
  return currentUserId;
}

export function userKey(key) {
  return `cb:${currentUserId}:${key}`;
}

export function loadLocal(key, fallback = null) {
  try {
    const raw = localStorage.getItem(userKey(key));
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key, value) {
  try {
    localStorage.setItem(userKey(key), JSON.stringify(value));
  } catch (e) {
    console.warn("saveLocal failed:", e);
  }
}

// Supabase client singleton
let sbClient = null;

export function getSupabase() {
  if (sbClient) return sbClient;
  // config.js declares these with const, so they are global bindings but not window properties.
  const url = typeof SUPABASE_URL !== "undefined" ? SUPABASE_URL : window.SUPABASE_URL;
  const key = typeof SUPABASE_ANON_KEY !== "undefined" ? SUPABASE_ANON_KEY : window.SUPABASE_ANON_KEY;
  if (window.supabase && typeof window.supabase.createClient === "function" && url && key) {
    sbClient = window.supabase.createClient(url, key);
  }
  return sbClient;
}

// The client for reading and writing song data: only while someone is signed in.
export function getCloud() {
  return currentUserId !== "local" ? getSupabase() : null;
}

// Accessible Toast & Undo Bar (sits outside inert regions so Undo is always clickable)
let toastTimer = null;

export function toast(msg, durationMs = 3800) {
  const bar = document.getElementById("toast-bar");
  if (!bar) return;
  clearTimeout(toastTimer);
  bar.className = "toast-bar is-visible";
  bar.innerHTML = `<span class="toast-msg">${esc(msg)}</span>`;
  toastTimer = setTimeout(() => {
    bar.className = "toast-bar";
  }, durationMs);
}

export function toastError(msg, durationMs = 5500) {
  const bar = document.getElementById("toast-bar");
  if (!bar) return;
  clearTimeout(toastTimer);
  bar.className = "toast-bar is-visible is-error";
  bar.innerHTML = `<span class="toast-msg">${esc(msg)}</span>`;
  toastTimer = setTimeout(() => {
    bar.className = "toast-bar";
  }, durationMs);
}

export function toastAction(msg, actionLabel, onAction, durationMs = 7000) {
  const bar = document.getElementById("toast-bar");
  if (!bar) return;
  clearTimeout(toastTimer);
  bar.className = "toast-bar is-visible";
  bar.innerHTML = `
    <span class="toast-msg">${esc(msg)}</span>
    <button type="button" class="toast-action-btn" id="toast-action-trigger">${esc(actionLabel)}</button>
  `;
  const btn = document.getElementById("toast-action-trigger");
  if (btn) {
    btn.addEventListener("click", async () => {
      clearTimeout(toastTimer);
      bar.className = "toast-bar";
      if (typeof onAction === "function") {
        await onAction();
      }
    }, { once: true });
  }
  toastTimer = setTimeout(() => {
    bar.className = "toast-bar";
  }, durationMs);
}

// Accessible modal sheet stack (SPEC 8: focus in, focus back, Escape closes top, background inert)
const sheetStack = [];
const sheetCloseGuards = new Map();

// A guard returns false to keep a sheet open (e.g. the user chose to keep editing).
export function setSheetCloseGuard(sheetId, guardFn) {
  sheetCloseGuards.set(sheetId, guardFn);
}

export function openSheet(sheetId, triggerEl = null) {
  const sheet = document.getElementById(sheetId);
  if (!sheet) return;
  // Prevent duplicate stack pushes if sheet is already open
  const existingIdx = sheetStack.findIndex((s) => s.id === sheetId);
  if (existingIdx !== -1) {
    return;
  }
  const opener = triggerEl || document.activeElement;
  sheet.hidden = false;
  sheet.setAttribute("aria-hidden", "false");

  const mainShell = document.getElementById("app-shell");
  if (mainShell && sheetStack.length === 0) {
    mainShell.setAttribute("inert", "");
  } else if (sheetStack.length > 0) {
    const prev = document.getElementById(sheetStack[sheetStack.length - 1].id);
    if (prev) prev.setAttribute("inert", "");
  }

  sheetStack.push({ id: sheetId, opener });

  // Focus first focusable control inside the sheet
  requestAnimationFrame(() => {
    const focusable = sheet.querySelector(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable) focusable.focus();
  });
}

export function closeSheet(sheetId = null, { force = false } = {}) {
  if (!sheetStack.length) return;
  const idx = sheetId
    ? sheetStack.findIndex((s) => s.id === sheetId)
    : sheetStack.length - 1;
  if (idx === -1) return;

  const guard = sheetCloseGuards.get(sheetStack[idx].id);
  if (!force && guard && !guard()) return;

  const [entry] = sheetStack.splice(idx, 1);
  const sheet = document.getElementById(entry.id);
  if (sheet) {
    sheet.hidden = true;
    sheet.setAttribute("aria-hidden", "true");
    sheet.removeAttribute("inert");
  }

  if (sheetStack.length > 0) {
    const top = document.getElementById(sheetStack[sheetStack.length - 1].id);
    if (top) top.removeAttribute("inert");
  } else {
    const mainShell = document.getElementById("app-shell");
    if (mainShell) mainShell.removeAttribute("inert");
  }

  if (entry.opener && typeof entry.opener.focus === "function") {
    try { entry.opener.focus(); } catch { /* ignore */ }
  }
}

export function setupGlobalEscapeAndBackdrop() {
  document.addEventListener("keydown", (e) => {
    // Stage mode handles its own Escape, so leaving it returns to the open set list.
    if (document.getElementById("perform-overlay")?.hidden === false) return;
    if (e.key === "Escape" && sheetStack.length > 0) {
      e.preventDefault();
      closeSheet();
    }
  });
  document.querySelectorAll(".modal-sheet").forEach((sheet) => {
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet) {
        closeSheet(sheet.id);
      }
    });
  });
}

// Offline write queue
export function queueOfflineWrite(op) {
  const q = loadLocal("offline_queue", []);
  q.push({ ...op, queuedAt: new Date().toISOString() });
  saveLocal("offline_queue", q);
  updateOfflineBanner();
}

export function getOfflineQueue() {
  return loadLocal("offline_queue", []);
}

export function clearOfflineQueue() {
  saveLocal("offline_queue", []);
  updateOfflineBanner();
}

export async function flushOfflineQueue() {
  if (!navigator.onLine) {
    updateOfflineBanner();
    return;
  }
  const sb = getCloud();
  const q = getOfflineQueue();
  if (!sb || !q.length) {
    updateOfflineBanner();
    return;
  }
  const remaining = [];
  for (const op of q) {
    try {
      if (op.type === "update_song" && op.row?.id) {
        const { error } = await sb.from("cb_songs").update(op.row).eq("id", op.row.id);
        if (error) throw error;
      } else if (op.type === "insert_song" && op.row) {
        const { error } = await sb.from("cb_songs").insert(op.row);
        if (error) throw error;
      }
    } catch {
      remaining.push(op);
    }
  }
  saveLocal("offline_queue", remaining);
  updateOfflineBanner();
}

export function updateOfflineBanner() {
  const banner = document.getElementById("offline-banner");
  if (!banner) return;
  const q = getOfflineQueue();
  const isOffline = !navigator.onLine;
  if (isOffline || q.length > 0) {
    banner.hidden = false;
    banner.textContent = isOffline
      ? `Offline mode — your saved songs & set lists are available${q.length ? ` (${q.length} edit${q.length > 1 ? "s" : ""} queued)` : ""}.`
      : `Syncing ${q.length} offline edit${q.length > 1 ? "s" : ""}…`;
  } else {
    banner.hidden = true;
  }
}
