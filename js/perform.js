// Full-Screen Stage Performance Mode (js/perform.js)
// Features:
// - Screen Wake Lock API (keeps phone/tablet screen on while playing)
// - Auto-scroll with adjustable speed (+ / -) and tap-to-pause
// - Bluetooth page-turner pedal & keyboard bindings (PageDown/ArrowRight/Space, PageUp/ArrowLeft)
// - Set list progression footer ("Next song: Title in Key")

import { esc, toast, loadLocal, saveLocal } from "./core.js";
import { renderSongBodyHTML } from "./render.js";
import { soundingKeyWithTuning, getTuning, transposeKey } from "./chords.js";
import { getDeviceProfile } from "./device.js";
import { estimateSongTiming, formatMinutes } from "./timing.js";

let wakeLockSentinel = null;
let scrollFrame = null;
let scrollSpeed = 1; // 1 = the song's calculated pace
let songSeconds = 240;
let isScrolling = false;
let currentSongList = [];
let currentSongIndex = 0;
let lastSongTurnAt = 0;
const SONG_TURN_GUARD_MS = 600;
const STAGE_FONT_MIN = 15;
const STAGE_FONT_MAX = 40;

function stageFontPx() {
  const saved = Number(loadLocal("stage_font_px", 0));
  if (saved >= STAGE_FONT_MIN && saved <= STAGE_FONT_MAX) return saved;
  return getDeviceProfile().isPhone ? 19 : 24;
}

function applyStageFont(px = stageFontPx()) {
  const bodyEl = document.getElementById("perform-body");
  if (bodyEl) bodyEl.style.fontSize = `${px}px`;
}

function changeStageFont(step) {
  const next = Math.max(STAGE_FONT_MIN, Math.min(STAGE_FONT_MAX, stageFontPx() + step));
  saveLocal("stage_font_px", next);
  applyStageFont(next);
}

function goToSong(step) {
  const target = currentSongIndex + step;
  if (target < 0 || target >= currentSongList.length) {
    if (currentSongList.length > 1 && step > 0) toast("End of set");
    return;
  }
  lastSongTurnAt = Date.now();
  currentSongIndex = target;
  stopAutoScroll();
  renderPerformSong({});
}

// One page turn for taps and pedals. At the end of a song it moves on to the next one.
function turnPage(direction) {
  const bodyEl = document.getElementById("perform-body");
  if (!bodyEl || Date.now() - lastSongTurnAt < SONG_TURN_GUARD_MS) return;
  const atEnd = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 4;
  const atTop = bodyEl.scrollTop <= 2;
  if (direction > 0 && atEnd) {
    goToSong(1);
  } else if (direction < 0 && atTop) {
    goToSong(-1);
  } else {
    bodyEl.scrollBy({ top: direction * Math.round(bodyEl.clientHeight * 0.8), behavior: "smooth" });
  }
}

export async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && navigator.wakeLock?.request) {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
    }
  } catch {
    // Wake lock not permitted or unsupported
  }
}

export async function releaseWakeLock() {
  try {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  } catch {
    wakeLockSentinel = null;
  }
}

export function openPerformanceMode(songs, startIndex = 0, viewOpts = {}) {
  if (!songs || !songs.length) return;
  currentSongList = songs;
  currentSongIndex = Math.max(0, Math.min(songs.length - 1, startIndex));

  const overlay = document.getElementById("perform-overlay");
  if (!overlay) return;
  overlay.hidden = false;
  document.body.classList.add("in-perform-mode");

  requestWakeLock();
  applyStageFont();
  renderPerformSong(viewOpts);
}

export function closePerformanceMode() {
  stopAutoScroll();
  releaseWakeLock();
  const overlay = document.getElementById("perform-overlay");
  if (overlay) overlay.hidden = true;
  document.body.classList.remove("in-perform-mode");
}

function renderPerformSong(viewOpts = {}) {
  const song = currentSongList[currentSongIndex];
  if (!song) return;
  const bodyEl = document.getElementById("perform-body");
  const titleEl = document.getElementById("perform-title");
  const metaEl = document.getElementById("perform-meta");
  const nextFooterEl = document.getElementById("perform-next-footer");

  const semitoneDelta = viewOpts.semitoneDelta ?? (song.preferred_transpose || 0);
  const capo = Number(viewOpts.capo ?? song.capo ?? 0);
  const model = renderSongBodyHTML(song, {
    ...viewOpts,
    semitoneDelta,
    alignMode: false,
    editableNotes: false
  });
  const tuning = getTuning(song.tuning || model.parsed.meta.tuning);
  const showSounding = capo > 0 || tuning.offset !== 0;
  const sounding = showSounding ? soundingKeyWithTuning(model.targetKey, capo, tuning.value) : model.targetKey;
  songSeconds = estimateSongTiming(song, model.parsed, model.sectionsToRender).seconds;
  scrollSpeed = 1;

  if (titleEl) titleEl.textContent = song.title;
  if (metaEl) {
    metaEl.textContent = [
      capo > 0 ? `${model.targetKey} shapes` : `Key of ${model.targetKey}`,
      capo > 0 ? `Capo ${capo}` : "",
      tuning.id === "standard" ? "" : tuning.display,
      showSounding ? `Sounds in ${sounding}` : ""
    ].filter(Boolean).join(" · ");
  }
  if (bodyEl) {
    bodyEl.innerHTML = `
      <div class="perform-columns">
        ${model.sectionsToRender.map(model.renderSection).join("")}
      </div>
    `;
    bodyEl.scrollTop = 0;
  }
  updateScrollBtnLabel();

  if (nextFooterEl) {
    const nextSong = currentSongList[currentSongIndex + 1];
    const prevSong = currentSongList[currentSongIndex - 1];
    nextFooterEl.hidden = currentSongList.length <= 1;
    const nextKey = nextSong ? transposeKey(nextSong.key || "G", nextSong.preferred_transpose || 0, "auto") : "";
    nextFooterEl.innerHTML = `
      <div class="perform-nav-bar">
        <button type="button" class="ghost-btn perform-prev-btn" id="perform-prev-song" ${prevSong ? `aria-label="Previous song: ${esc(prevSong.title)}"` : `aria-label="Previous song" disabled`}>←</button>
        <span class="perform-set-pos">${currentSongIndex + 1} of ${currentSongList.length}</span>
        <button type="button" class="solid-btn perform-next-btn" id="perform-next-song" ${nextSong ? "" : "disabled"}>
          ${nextSong ? `Next: ${esc(nextSong.title)} (${esc(nextKey)}) →` : "End of set"}
        </button>
      </div>
    `;
    document.getElementById("perform-prev-song")?.addEventListener("click", () => goToSong(-1));
    document.getElementById("perform-next-song")?.addEventListener("click", () => goToSong(1));
  }
}

export function toggleAutoScroll() {
  if (isScrolling) {
    stopAutoScroll();
  } else {
    startAutoScroll();
  }
}

export function startAutoScroll() {
  stopAutoScroll();
  isScrolling = true;
  updateScrollBtnLabel();
  const bodyEl = document.getElementById("perform-body");
  if (!bodyEl) return;
  // Keep an exact position because slow speeds move less than a pixel per frame.
  let position = bodyEl.scrollTop;
  let lastFrame = performance.now();
  const step = (now) => {
    if (!isScrolling) return;
    const elapsed = Math.min(0.12, (now - lastFrame) / 1000);
    lastFrame = now;
    // Measured every frame, so rotating the screen or changing text size keeps the song's timing.
    const distance = bodyEl.scrollHeight - bodyEl.clientHeight;
    if (distance <= 0) {
      stopAutoScroll();
      return;
    }
    if (Math.abs(bodyEl.scrollTop - position) > 2) position = bodyEl.scrollTop;
    position += (distance / songSeconds) * scrollSpeed * elapsed;
    bodyEl.scrollTop = position;
    if (position >= distance - 1) {
      stopAutoScroll();
      return;
    }
    scrollFrame = requestAnimationFrame(step);
  };
  scrollFrame = requestAnimationFrame(step);
}

export function stopAutoScroll() {
  isScrolling = false;
  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  }
  updateScrollBtnLabel();
}

function updateScrollBtnLabel() {
  const btn = document.getElementById("perform-autoscroll-btn");
  if (btn) {
    btn.textContent = isScrolling ? "Pause" : "Scroll";
    btn.classList.toggle("is-active", isScrolling);
  }
  document.getElementById("perform-overlay")?.classList.toggle("is-scrolling", isScrolling);
  const speedEl = document.getElementById("perform-speed-val");
  if (speedEl) {
    const length = formatMinutes(songSeconds / scrollSpeed);
    speedEl.textContent = length;
    speedEl.setAttribute("aria-label", `Scrolls through the song in about ${length}`);
  }
}

export function initPerformanceControls() {
  document.getElementById("perform-close-btn")?.addEventListener("click", closePerformanceMode);
  document.getElementById("perform-autoscroll-btn")?.addEventListener("click", toggleAutoScroll);

  document.getElementById("perform-font-down")?.addEventListener("click", () => changeStageFont(-2));
  document.getElementById("perform-font-up")?.addEventListener("click", () => changeStageFont(2));

  document.getElementById("perform-speed-down")?.addEventListener("click", () => {
    scrollSpeed = Math.max(0.5, Number((scrollSpeed - 0.1).toFixed(1)));
    updateScrollBtnLabel();
  });
  document.getElementById("perform-speed-up")?.addEventListener("click", () => {
    scrollSpeed = Math.min(2, Number((scrollSpeed + 0.1).toFixed(1)));
    updateScrollBtnLabel();
  });

  const bodyEl = document.getElementById("perform-body");
  if (bodyEl) {
    // Tap the middle to start or pause scrolling; left and right thirds turn the page
    bodyEl.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const rect = bodyEl.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
      if (isScrolling) {
        stopAutoScroll();
        toast("Auto-scroll paused");
        return;
      }
      if (relX > 0.68) {
        turnPage(1);
      } else if (relX < 0.32) {
        turnPage(-1);
      } else {
        startAutoScroll();
      }
    });
  }

  // Re-acquire Screen Wake Lock if user switches away and returns to the tab while on stage
  document.addEventListener("visibilitychange", () => {
    const overlay = document.getElementById("perform-overlay");
    if (document.visibilityState === "visible" && overlay && !overlay.hidden) {
      requestWakeLock();
    }
  });

  // Bluetooth pedal & keyboard page turns
  document.addEventListener("keydown", (e) => {
    const overlay = document.getElementById("perform-overlay");
    if (!overlay || overlay.hidden) return;
    const container = document.getElementById("perform-body");
    if (!container) return;

    if (e.key === "Escape") {
      e.preventDefault();
      closePerformanceMode();
      return;
    }
    if (e.key === "PageDown" || e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      turnPage(1);
    } else if (e.key === "PageUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      turnPage(-1);
    }
  });
}
