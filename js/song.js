// Song View, Live Transpose/Capo, 1-Sheet / 2-Sheet / Scroll Layout Controller,
// Inline Sidebar Margin Note Editor, Per-Song Saved Settings, and ChordPro Editor (js/song.js)

import {
  esc,
  saveLocal,
  GENRES,
  getSongGenre,
  toast,
  toastAction,
  toastError,
  openSheet,
  closeSheet,
  setSheetCloseGuard,
  getCloud
} from "./core.js";
import {
  ALL_MAJOR_KEYS,
  ALL_MINOR_KEYS,
  NOTE_TO_PITCH,
  normalizeKeyName,
  transposeKey,
  soundingKeyWithTuning,
  getTuning,
  TUNINGS,
  suggestCapoPositions
} from "./chords.js";
import {
  parse,
  transposeChordPro,
  auditChordAlignment,
  autoFixChordAlignment,
  nudgeChordInChordPro,
  chorusWording,
  chorusWordingInChordPro
} from "./chordpro.js";
import { renderChordDiagramSVG } from "./render.js";
import { renderAndFitSong, scaleLetterPagesToViewport } from "./fit.js";
import { getIdealVocalRangeRecommendations } from "./analytics.js";
import { getDeviceProfile } from "./device.js";
import { openPerformanceMode } from "./perform.js";
import { printCurrentSheet, downloadSelfContainedSongHTML } from "./send.js";
import { runAiChordAlignmentCheck, lookUpMelodyRanges } from "./ai.js";
import {
  NOTE_LOWEST,
  NOTE_HIGHEST,
  midiToNote,
  rangeText,
  storedMelody,
  sungRange,
  melodyFromSung,
  melodyFromRecording,
  getVocalRange,
  rangeFit
} from "./melody.js";

let activeSong = null;
let viewState = {
  semitoneDelta: 0,
  capo: 0,
  pageMode: "1-sheet",    // "1-sheet" | "2-sheet" | "scroll"
  columns: "auto",        // "auto" | 1 | 2
  compactChorus: false,
  showDiagrams: false,
  fontOffset: 0,
  accidentalPref: "auto", // "auto" | "sharps" | "flats"
  displayStyle: "above",  // "above" | "inline" | "lyrics_only" | "chords_only"
  nashville: false,
  leftHanded: false,
  vocalRating: null,
  vocalComfort: null,
  melody: null,           // layout_prefs.melody: lowest and highest sung notes (js/melody.js)
  tuning: "E A D G B E",
  sidebarNotes: {},
  alignMode: false,
  isDirty: false
};

let onSaveSongCallback = null;
let onDeleteSongCallback = null;
let getLibrarySongsCallback = null;
let autosaveTimer = null;
const AUTOSAVE_DELAY_MS = 350;

export function getActiveSong() {
  return activeSong;
}

export function getViewState() {
  return viewState;
}

/** A melody range found in the background reaches the open song, so its next save keeps it. */
export function applyMelodyToOpenSong(songId, melody) {
  if (!activeSong || activeSong.id !== songId) return false;
  activeSong = { ...activeSong, layout_prefs: { ...(activeSong.layout_prefs || {}), melody } };
  viewState.melody = melody;
  refreshSongToolbar();
  return true;
}

// The song as it is set up on screen now, for melody math.
function songAsShown() {
  return {
    ...activeSong,
    capo: viewState.capo,
    preferred_transpose: viewState.semitoneDelta,
    tuning: viewState.tuning,
    layout_prefs: { ...(activeSong?.layout_prefs || {}), melody: viewState.melody || undefined }
  };
}

export function initSongController({ onSaveSong, onDeleteSong, getLibrarySongs }) {
  onSaveSongCallback = onSaveSong;
  onDeleteSongCallback = onDeleteSong;
  getLibrarySongsCallback = getLibrarySongs;

  // Transpose -1 / +1 / Reset
  document.getElementById("transpose-down-btn")?.addEventListener("click", () => {
    viewState.semitoneDelta = ((viewState.semitoneDelta - 1 + 12 + 6) % 12) - 6;
    viewState.isDirty = true;
    refreshSongView();
  });

  document.getElementById("transpose-up-btn")?.addEventListener("click", () => {
    viewState.semitoneDelta = ((viewState.semitoneDelta + 1 + 12 + 5) % 12) - 5;
    viewState.isDirty = true;
    refreshSongView();
  });

  // Target Key Picker
  document.getElementById("target-key-select")?.addEventListener("change", (e) => {
    if (!activeSong) return;
    const pickedKey = e.target.value;
    const parsed = parse(activeSong.chordpro || "");
    const baseKey = normalizeKeyName(activeSong.key || parsed.meta.key || parsed.meta.inferredKey || "G");
    const baseRoot = baseKey.endsWith("m") ? baseKey.slice(0, -1) : baseKey;
    const pickedRoot = pickedKey.endsWith("m") ? pickedKey.slice(0, -1) : pickedKey;
    const rawDiff = ((NOTE_TO_PITCH[pickedRoot] - NOTE_TO_PITCH[baseRoot]) % 12 + 12) % 12;
    viewState.semitoneDelta = rawDiff > 6 ? rawDiff - 12 : rawDiff;
    viewState.isDirty = true;
    refreshSongView();
  });

  // Capo Picker (0..11)
  document.getElementById("capo-select")?.addEventListener("change", (e) => {
    viewState.capo = parseInt(e.target.value, 10) || 0;
    viewState.isDirty = true;
    refreshSongView();
  });

  // Page Fit Mode: 1-Sheet (8.5x11) | 2-Sheet (8.5x11) | Scroll
  document.querySelectorAll("[data-page-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      viewState.pageMode = btn.getAttribute("data-page-mode") || "1-sheet";
      viewState.isDirty = true;
      refreshSongView();
    });
  });

  // Columns: Auto | 1 | 2
  document.getElementById("columns-select")?.addEventListener("change", (e) => {
    viewState.columns = e.target.value;
    viewState.isDirty = true;
    refreshSongView();
  });

  // Font Nudge - / +
  document.getElementById("font-smaller-btn")?.addEventListener("click", () => {
    viewState.fontOffset = Math.max(-4, viewState.fontOffset - 1);
    viewState.isDirty = true;
    refreshSongView();
  });
  document.getElementById("font-larger-btn")?.addEventListener("click", () => {
    viewState.fontOffset = Math.min(4, viewState.fontOffset + 1);
    viewState.isDirty = true;
    refreshSongView();
  });

  // Hide tabs (toolbar, shown only for songs with tab)
  document.getElementById("toggle-tabs-btn")?.addEventListener("click", () => {
    viewState.hideTabs = !viewState.hideTabs;
    viewState.isDirty = true;
    refreshSongView();
  });

  // Compact Choruses checkbox
  document.getElementById("compact-chorus-toggle")?.addEventListener("change", (e) => {
    viewState.compactChorus = !!e.target.checked;
    viewState.isDirty = true;
    refreshSongView();
  });

  // Diagrams toggle
  document.getElementById("show-diagrams-toggle")?.addEventListener("change", (e) => {
    viewState.showDiagrams = !!e.target.checked;
    viewState.isDirty = true;
    refreshSongView();
  });

  // Nashville numbers toggle
  document.getElementById("nashville-toggle")?.addEventListener("change", (e) => {
    viewState.nashville = !!e.target.checked;
    refreshSongView();
  });

  // Accidental spelling (Auto | Sharps | Flats)
  document.getElementById("accidental-select")?.addEventListener("change", (e) => {
    viewState.accidentalPref = e.target.value || "auto";
    viewState.isDirty = true;
    refreshSongView();
  });

  // Display Style (Chords Above | Inline | Lyrics Only | Chords Only)
  document.getElementById("display-style-select")?.addEventListener("change", (e) => {
    viewState.displayStyle = e.target.value || "above";
    refreshSongView();
  });

  // Guitar tuning: half step down changes the key the song sounds in
  const tuningSelect = document.getElementById("song-tuning-select");
  if (tuningSelect) {
    tuningSelect.innerHTML = TUNINGS.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
    tuningSelect.addEventListener("change", (e) => {
      const choice = TUNINGS.find((t) => t.id === e.target.value) || TUNINGS[0];
      // Keep a specific custom tuning if "Other" is already selected.
      if (choice.id !== getTuning(viewState.tuning).id) viewState.tuning = choice.value;
      viewState.isDirty = true;
      refreshSongView();
    });
  }

  // Vocal Comfort & Rating controls on the song bar
  document.getElementById("vocal-comfort-select")?.addEventListener("change", (e) => {
    viewState.vocalComfort = e.target.value || null;
    viewState.isDirty = true;
    refreshSongToolbar();
  });

  document.getElementById("vocal-rating-select")?.addEventListener("change", (e) => {
    viewState.vocalRating = parseInt(e.target.value, 10) || null;
    viewState.isDirty = true;
    refreshSongToolbar();
  });

  // Melody range: the pickers show the notes as sung in the key on screen now.
  const lowPick = document.getElementById("melody-low-select");
  const highPick = document.getElementById("melody-high-select");
  const noteOptions = `<option value="">—</option>` +
    Array.from({ length: NOTE_HIGHEST - NOTE_LOWEST + 1 }, (_, i) => NOTE_LOWEST + i)
      .map((m) => `<option value="${m}">${midiToNote(m)}</option>`).join("");
  if (lowPick) lowPick.innerHTML = noteOptions;
  if (highPick) highPick.innerHTML = noteOptions;
  const onMelodyPick = () => {
    if (!activeSong) return;
    const low = parseInt(lowPick.value, 10);
    const high = parseInt(highPick.value, 10);
    if (!lowPick.value && !highPick.value) {
      viewState.melody = null;
    } else if (!lowPick.value || !highPick.value) {
      return; // waiting for the other note
    } else if (high <= low) {
      toastError("Pick a highest note above the lowest.");
      refreshMelodyPickers();
      return;
    } else {
      viewState.melody = melodyFromSung(songAsShown(), low, high, "you");
    }
    viewState.isDirty = true;
    refreshSongToolbar();
  };
  lowPick?.addEventListener("change", onMelodyPick);
  highPick?.addEventListener("change", onMelodyPick);
  document.getElementById("find-melody-btn")?.addEventListener("click", async (e) => {
    if (!activeSong) return;
    const btn = e.currentTarget;
    const songId = activeSong.id;
    btn.disabled = true;
    btn.textContent = "Looking…";
    try {
      const res = await lookUpMelodyRanges([songAsShown()]);
      if (res.error) {
        toastError(res.error);
        return;
      }
      const found = res.melodies?.[0];
      if (!found) {
        toast("The AI doesn’t know this melody. Pick the lowest and highest notes yourself.");
        return;
      }
      if (!activeSong || activeSong.id !== songId) return;
      viewState.melody = melodyFromRecording(songAsShown(), found);
      viewState.isDirty = true;
      refreshSongToolbar();
      toast(`Melody runs ${rangeText(sungRange(songAsShown()))} in this key (AI estimate from the recording).`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Look up";
    }
  });

  // Key, capo and view choices save themselves, including when the app is put away mid-song.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAutosave();
  });
  window.addEventListener("pagehide", () => flushAutosave());

  // Permanently rewrite ChordPro in the current transposed key ("Save in this key" + Undo)
  document.getElementById("bake-transpose-key-btn")?.addEventListener("click", async () => {
    closeSheet("song-more-modal");
    await bakeTransposedKeyIntoChordPro();
  });

  // Print / Export PDF & Standalone HTML
  document.getElementById("print-sheet-btn")?.addEventListener("click", () => {
    closeSheet("song-more-modal");
    printCurrentSheet(activeSong, viewState);
  });
  document.getElementById("export-html-btn")?.addEventListener("click", () => {
    if (!activeSong) return;
    closeSheet("song-more-modal");
    downloadSelfContainedSongHTML(activeSong, viewState);
  });

  // Perform Song button
  document.getElementById("perform-song-btn")?.addEventListener("click", () => {
    if (!activeSong) return;
    flushAutosave();
    openPerformanceMode([activeSong], 0, viewState);
  });

  // Layer 2: Interactive On-Sheet Chord Alignment Mode ("🎯 Align Chords")
  document.getElementById("toggle-align-mode-btn")?.addEventListener("click", () => {
    closeSheet("song-more-modal");
    viewState.alignMode = !viewState.alignMode;
    refreshSongView();
  });
  document.getElementById("align-mode-done-btn")?.addEventListener("click", () => {
    viewState.alignMode = false;
    refreshSongView();
  });
  document.getElementById("align-mode-auto-fix-btn")?.addEventListener("click", async () => {
    if (!activeSong) return;
    const report = auditChordAlignment(activeSong.chordpro || "");
    if (report.autoFixCount === 0) {
      toast("✓ Sheet passed alignment quality check — no mechanical fixes needed!");
      return;
    }
    const previousSnapshot = JSON.parse(JSON.stringify(activeSong));
    activeSong = {
      ...activeSong,
      chordpro: report.fixedChordpro,
      updated_at: new Date().toISOString()
    };
    if (onSaveSongCallback) {
      await onSaveSongCallback(activeSong, { isUpdate: true });
    }
    refreshSongView();
    toastAction(`Auto-fixed ${report.autoFixCount} chord alignment issue${report.autoFixCount === 1 ? "" : "s"}`, "Undo", async () => {
      activeSong = previousSnapshot;
      if (onSaveSongCallback) await onSaveSongCallback(previousSnapshot, { isUpdate: true });
      refreshSongView();
    });
  });

  // Everything beyond key, capo and play lives in one "More" sheet
  document.getElementById("toggle-more-controls-btn")?.addEventListener("click", (e) => {
    openSheet("song-more-modal", e.currentTarget);
  });

  // Quick Reset Transpose when clicking the delta badge ("+2 st" -> "Original")
  document.getElementById("transpose-delta-badge")?.addEventListener("click", () => {
    if (viewState.semitoneDelta !== 0) {
      viewState.semitoneDelta = 0;
      viewState.isDirty = true;
      refreshSongView();
      toast("Reset transpose to original written key");
    }
  });

  // Edit Song button
  document.getElementById("edit-song-btn")?.addEventListener("click", (e) => {
    if (!activeSong) return;
    closeSheet("song-more-modal");
    openSongEditor(activeSong, document.getElementById("toggle-more-controls-btn") || e.currentTarget);
  });

  // Delete Song button
  document.getElementById("delete-song-btn")?.addEventListener("click", () => {
    if (!activeSong || !onDeleteSongCallback) return;
    cancelAutosave();
    closeSheet("song-more-modal");
    onDeleteSongCallback(activeSong);
  });

  // Sidebar Margin Note Modal Form
  const noteForm = document.getElementById("sidebar-note-form");
  if (noteForm) {
    noteForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const targetKey = document.getElementById("sidebar-note-target-key")?.value;
      const text = (document.getElementById("sidebar-note-text")?.value || "").trim();
      const kind = document.getElementById("sidebar-note-kind")?.value || "dynamic";
      if (!targetKey || !activeSong) return;
      if (text) {
        viewState.sidebarNotes[targetKey] = { text, kind };
      } else {
        delete viewState.sidebarNotes[targetKey];
      }
      closeSheet("sidebar-note-modal");
      await saveCurrentSettingsToSong({ silentMsg: text ? "Saved sidebar note" : "Removed sidebar note" });
    });
  }

  document.getElementById("sidebar-note-clear-btn")?.addEventListener("click", async () => {
    const targetKey = document.getElementById("sidebar-note-target-key")?.value;
    if (targetKey && activeSong) {
      delete viewState.sidebarNotes[targetKey];
      closeSheet("sidebar-note-modal");
      await saveCurrentSettingsToSong({ silentMsg: "Removed sidebar note" });
    }
  });

  // Resize listener (rAF-throttled) to keep 8.5x11 sheet scaled cleanly on viewport changes
  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      const stage = document.getElementById("song-stage-container");
      if (stage && viewState.pageMode !== "scroll") {
        scaleLetterPagesToViewport(stage);
      }
    });
  });

  // Event delegation on song-stage-container (bound once instead of re-querying on every render)
  const stageEl = document.getElementById("song-stage-container");
  if (stageEl) {
    stageEl.addEventListener("click", async (e) => {
      if (e.target.closest("[data-retry-load]")) {
        window.location.reload();
        return;
      }
      if (e.target.closest("[data-empty-add]")) {
        document.getElementById("open-import-btn")?.click();
        return;
      }
      const nudgeBtn = e.target.closest("[data-nudge-dir]");
      if (nudgeBtn && activeSong) {
        e.stopPropagation();
        const dir = parseInt(nudgeBtn.getAttribute("data-nudge-dir"), 10) || 1;
        const secIdx = parseInt(nudgeBtn.getAttribute("data-sec-idx"), 10);
        const lineIdx = parseInt(nudgeBtn.getAttribute("data-line-idx"), 10);
        const segIdx = parseInt(nudgeBtn.getAttribute("data-seg-idx"), 10);
        const prevPro = activeSong.chordpro || "";
        const nextPro = nudgeChordInChordPro(prevPro, secIdx, lineIdx, segIdx, dir);
        if (nextPro !== prevPro) {
          activeSong = {
            ...activeSong,
            chordpro: nextPro,
            updated_at: new Date().toISOString()
          };
          if (onSaveSongCallback) {
            await onSaveSongCallback(activeSong, { isUpdate: true });
          }
          refreshSongView();
        }
        return;
      }
      const noteBtn = e.target.closest("[data-edit-note]");
      if (noteBtn) {
        const targetKey = noteBtn.getAttribute("data-edit-note");
        const secLabel = noteBtn.getAttribute("data-sec-label") || "Section";
        openSidebarNoteEditor(targetKey, secLabel, noteBtn);
        return;
      }
      const chordEl = e.target.closest("[data-chord]");
      if (chordEl) {
        const ch = chordEl.getAttribute("data-chord");
        if (ch) openChordInspector(ch, chordEl);
      }
    });
  }

  initSongEditorEvents();
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(flushAutosave, AUTOSAVE_DELAY_MS);
}

function cancelAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  viewState.isDirty = false;
}

/** Saves any pending key/capo/view change right now and returns the saved song, if there was one. */
function flushAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  if (!activeSong || !viewState.isDirty || !onSaveSongCallback) return null;
  const updated = buildSongWithCurrentSettings();
  activeSong = updated;
  viewState.isDirty = false;
  Promise.resolve(onSaveSongCallback(updated, { isUpdate: true })).catch((err) => {
    console.error("Autosave failed:", err);
    toastError("Couldn’t save that change.");
  });
  return updated;
}

/** Shown when the library is empty, so the page never keeps displaying a deleted song. */
export function showEmptySongStage({ failed = false } = {}) {
  cancelAutosave();
  activeSong = null;
  document.body.classList.add("no-song");
  document.body.classList.remove("is-markup");
  const label = document.getElementById("mobile-active-song-label");
  if (label) label.textContent = failed ? "Couldn’t load songs" : "No songs yet";
  const stage = document.getElementById("song-stage-container");
  if (stage) {
    stage.className = "song-stage mode-scroll";
    // A failed load must never read as "your songs are gone".
    stage.innerHTML = failed
      ? `
      <div class="empty-stage">
        <h2>Couldn’t load your songs</h2>
        <p>They’re safe. Check your connection and try again.</p>
        <button type="button" class="solid-btn" data-retry-load="1">Try again</button>
      </div>
    `
      : `
      <div class="empty-stage">
        <h2>No songs yet</h2>
        <p>Paste in your first chord sheet to get started.</p>
        <button type="button" class="solid-btn" data-empty-add="1">＋ Add a song</button>
      </div>
    `;
  }
}

/**
 * Load a song row into the Song View and restore all of its saved per-song settings.
 * Any pending change to the previous song is saved first, unless an Undo is replacing it.
 */
export function openSongView(song, { discardPending = false } = {}) {
  if (!song) return;
  if (discardPending) {
    cancelAutosave();
  } else {
    const saved = flushAutosave();
    if (saved && saved.id === song.id) song = saved;
  }
  document.body.classList.remove("no-song");
  const isDifferentSong = activeSong?.id !== song.id;
  activeSong = song;
  saveLocal("last_song_id", song.id);
  // The phone song list hides the sheet, so close it before the sheet is measured.
  const libraryPane = document.getElementById("library-pane");
  if (libraryPane?.classList.contains("is-mobile-open")) {
    libraryPane.classList.remove("is-mobile-open");
    document.getElementById("mobile-library-toggle-btn")?.setAttribute("aria-expanded", "false");
    const libraryAction = document.getElementById("mobile-lib-action-text");
    if (libraryAction) libraryAction.textContent = "Songs ▾";
  }
  const prefs = song.layout_prefs || {};
  const parsed = parse(song.chordpro || "");
  const profile = getDeviceProfile();
  const defaultMode = profile.isPhone
    ? (prefs.phone_page_mode || "scroll")
    : (prefs.page_mode || "1-sheet");

  viewState = {
    semitoneDelta: Number(song.preferred_transpose || 0),
    capo: Number(song.capo ?? parsed.meta.capo ?? 0),
    pageMode: defaultMode,
    columns: prefs.columns || "auto",
    compactChorus: !!prefs.compact_chorus,
    hideTabs: !!prefs.hide_tabs,
    showDiagrams: prefs.show_diagrams === true,
    fontOffset: Number(prefs.font_offset || 0),
    accidentalPref: prefs.accidental_pref || "auto",
    displayStyle: prefs.display_style || "above",
    nashville: false,
    leftHanded: !!prefs.left_handed,
    tuning: song.tuning || parsed.meta.tuning || "E A D G B E",
    vocalRating: song.vocal_rating ?? null,
    vocalComfort: song.vocal_comfort ?? null,
    melody: prefs.melody || null,
    sidebarNotes: JSON.parse(JSON.stringify(prefs.sidebar_notes || {})),
    alignMode: false,
    isDirty: false
  };

  const mobileLabel = document.getElementById("mobile-active-song-label");
  if (mobileLabel) mobileLabel.textContent = song.title || "Select Song";

  refreshSongView();
  if (isDifferentSong) {
    const stage = document.getElementById("song-stage-container");
    if (stage) stage.scrollTop = 0;
    if (window.innerWidth <= 860) window.scrollTo(0, 0);
  }
}

export function refreshSongView() {
  if (!activeSong) return;
  const stage = document.getElementById("song-stage-container");
  if (!stage) return;
  document.body.classList.toggle("is-markup", !!viewState.alignMode);

  // Merge live sidebarNotes into a shallow song copy for rendering
  const tempSong = {
    ...activeSong,
    capo: viewState.capo,
    preferred_transpose: viewState.semitoneDelta,
    vocal_rating: viewState.vocalRating,
    vocal_comfort: viewState.vocalComfort,
    tuning: viewState.tuning,
    layout_prefs: {
      ...(activeSong.layout_prefs || {}),
      page_mode: viewState.pageMode,
      columns: viewState.columns,
      compact_chorus: viewState.compactChorus,
      hide_tabs: viewState.hideTabs,
      show_diagrams: viewState.showDiagrams,
      font_offset: viewState.fontOffset,
      accidental_pref: viewState.accidentalPref,
      sidebar_notes: viewState.sidebarNotes,
      melody: viewState.melody || undefined
    }
  };

  const fitInfo = renderAndFitSong(stage, tempSong, viewState);
  refreshSongToolbar(fitInfo);
}

function refreshSongToolbar(fitInfo = null) {
  if (!activeSong) return;
  const parsed = parse(activeSong.chordpro || "");
  const baseKey = normalizeKeyName(activeSong.key || parsed.meta.key || parsed.meta.inferredKey || "G");
  const isMinor = baseKey.endsWith("m");
  const currentShapesKey = transposeKey(baseKey, viewState.semitoneDelta, viewState.accidentalPref);
  const tuningInfo = getTuning(viewState.tuning);
  const showSounding = viewState.capo > 0 || tuningInfo.offset !== 0;
  const soundingKey = showSounding
    ? soundingKeyWithTuning(currentShapesKey, viewState.capo, viewState.tuning, viewState.accidentalPref)
    : currentShapesKey;

  // Populate Target Key dropdown
  const keySelect = document.getElementById("target-key-select");
  if (keySelect) {
    const keyList = isMinor ? ALL_MINOR_KEYS : ALL_MAJOR_KEYS;
    keySelect.innerHTML = keyList
      .map((k) => {
        const selected = normalizeKeyName(k) === normalizeKeyName(currentShapesKey) ? "selected" : "";
        return `<option value="${esc(k)}" ${selected}>${esc(k)}</option>`;
      })
      .join("");
  }

  const deltaBadge = document.getElementById("transpose-delta-badge");
  if (deltaBadge) {
    const d = viewState.semitoneDelta;
    deltaBadge.textContent = d === 0 ? "Original" : `${d > 0 ? "+" : ""}${d} ↺`;
    deltaBadge.setAttribute("aria-label", d === 0 ? "Original key" : "Back to the original key");
    deltaBadge.hidden = d === 0;
  }

  const capoSelect = document.getElementById("capo-select");
  if (capoSelect) capoSelect.value = String(viewState.capo);

  const soundingPill = document.getElementById("sounding-key-readout");
  if (soundingPill) {
    soundingPill.hidden = !showSounding;
    soundingPill.innerHTML = `Sounds in <strong>${esc(soundingKey)}</strong>`;
  }

  // Page mode buttons
  document.querySelectorAll("[data-page-mode]").forEach((btn) => {
    const m = btn.getAttribute("data-page-mode");
    btn.classList.toggle("is-active", m === viewState.pageMode);
    btn.setAttribute("aria-pressed", m === viewState.pageMode ? "true" : "false");
  });

  const colSelect = document.getElementById("columns-select");
  if (colSelect) colSelect.value = String(viewState.columns);

  const tabsBtn = document.getElementById("toggle-tabs-btn");
  if (tabsBtn) {
    const hasTab = /\{\s*(start_of_tab|sot)\b/i.test(activeSong.chordpro || "") || /^\s*[eBGDAE]\s*[|:][-\d]/m.test(activeSong.chordpro || "");
    tabsBtn.hidden = !hasTab;
    tabsBtn.querySelector(".label-long").textContent = viewState.hideTabs ? "Show tabs" : "Hide tabs";
    tabsBtn.title = viewState.hideTabs ? "Show guitar tab" : "Hide guitar tab";
    tabsBtn.setAttribute("aria-pressed", viewState.hideTabs ? "true" : "false");
    tabsBtn.classList.toggle("is-active", !!viewState.hideTabs);
  }

  const compactToggle = document.getElementById("compact-chorus-toggle");
  if (compactToggle) compactToggle.checked = !!viewState.compactChorus;

  const diagToggle = document.getElementById("show-diagrams-toggle");
  if (diagToggle) diagToggle.checked = !!viewState.showDiagrams;

  const accSelect = document.getElementById("accidental-select");
  if (accSelect) accSelect.value = viewState.accidentalPref;

  const comfortSelect = document.getElementById("vocal-comfort-select");
  if (comfortSelect) comfortSelect.value = viewState.vocalComfort ?? "";

  const ratingSelect = document.getElementById("vocal-rating-select");
  if (ratingSelect) ratingSelect.value = viewState.vocalRating == null ? "" : String(viewState.vocalRating);

  const tuningControl = document.getElementById("song-tuning-select");
  if (tuningControl) tuningControl.value = tuningInfo.id;

  refreshMelodyPickers();

  const columnsRow = document.getElementById("more-columns-row");
  if (columnsRow) columnsRow.hidden = viewState.pageMode === "scroll";

  const bakeBtn = document.getElementById("bake-transpose-key-btn");
  if (bakeBtn) {
    bakeBtn.hidden = viewState.semitoneDelta === 0;
  }

  const alignToggleBtn = document.getElementById("toggle-align-mode-btn");
  if (alignToggleBtn) {
    alignToggleBtn.classList.toggle("is-active", !!viewState.alignMode);
    alignToggleBtn.setAttribute("aria-pressed", viewState.alignMode ? "true" : "false");
  }
  const alignBanner = document.getElementById("song-align-mode-banner");
  if (alignBanner) {
    alignBanner.hidden = !viewState.alignMode;
  }

  renderSmartAdvisorBanner(parsed, currentShapesKey, soundingKey);

  if (viewState.isDirty) scheduleAutosave();
}

// Shows the melody as you'd sing it now, in the octave that suits your range.
function refreshMelodyPickers() {
  const lowPick = document.getElementById("melody-low-select");
  const highPick = document.getElementById("melody-high-select");
  const hint = document.getElementById("melody-hint");
  if (!lowPick || !highPick || !activeSong) return;
  const shown = songAsShown();
  let sung = sungRange(shown);
  const voice = getVocalRange(getLibrarySongsCallback ? getLibrarySongsCallback() : []);
  if (sung && voice) sung = { ...sung, ...rangeFit(sung, voice) };
  const inList = (m) => (m >= NOTE_LOWEST && m <= NOTE_HIGHEST ? String(m) : "");
  lowPick.value = sung ? inList(sung.low) : "";
  highPick.value = sung ? inList(sung.high) : "";
  if (hint) {
    const m = storedMelody(shown);
    const original = m?.recordingKey ? ` The original recording is in ${m.recordingKey}.` : "";
    hint.textContent = !m
      ? "Lowest and highest notes of the melody, as you sing it in this key. Look up asks the AI."
      : m.source === "ai"
        ? `AI estimate from the recording${m.confidence === "low" ? " (unsure)" : ""}.${original} Change either note if it’s off.`
        : `Set by you, for the key on screen.${original}`;
  }
}

function renderSmartAdvisorBanner(parsed, currentShapesKey, soundingKey) {
  const banner = document.getElementById("song-smart-advisor");
  if (!banner || !activeSong) return;

  const allSongs = getLibrarySongsCallback ? getLibrarySongsCallback() : [activeSong];
  const rec = getIdealVocalRangeRecommendations(songAsShown(), allSongs);
  // Capo ideas are about what you fret, so they ignore the guitar's tuning.
  const frettedKey = transposeKey(currentShapesKey, viewState.capo, viewState.accidentalPref);
  const capoSuggestions = suggestCapoPositions(parsed.allChords, frettedKey);
  // Past the 5th fret the guitar sounds thin and the neck gets cramped, so those aren't offered.
  const bestOpenCapo = capoSuggestions.find((c) => c.capo > 0 && c.capo <= 5 && c.score > 80);

  const tips = [];
  // A song outside your sweet-spot keys gets an offer to rewrite it in the nearest one, shown
  // alongside the easier-chords idea rather than instead of it.
  if (rec && !rec.isAlreadyIdeal && rec.pureTranspose) {
    const pt = rec.pureTranspose;
    const capoOpt = rec.easyCapo;
    const btns = [
      `<button type="button" class="advisor-apply-btn" id="apply-ideal-transpose-btn">Rewrite in ${esc(pt.targetShapesKey)}</button>`
    ];
    if (capoOpt) {
      btns.push(
        `<button type="button" class="advisor-apply-btn is-secondary" id="apply-ideal-capo-btn">${esc(capoOpt.label)}</button>`
      );
    }
    const move = (n) => `${Math.abs(n)} half step${Math.abs(n) === 1 ? "" : "s"} ${n < 0 ? "down" : "up"}`;
    const why = rec.felt
      ? `you marked this ${esc(rec.felt.label)}. ${esc(pt.targetShapesKey)} is ${esc(move(pt.semitoneShiftFromCurrent))}${rec.range?.after ? `, where you’d sing ${esc(rangeText(rec.range.after))}` : ""}.`
      : rec.range
      ? `the melody runs ${esc(rangeText(rec.range.sung))} here and your range is ${esc(rangeText(rec.range.voice))}.${rec.range.after ? ` In ${esc(pt.targetShapesKey)} you’d sing ${esc(rangeText(rec.range.after))}.` : ""}`
      : `this sounds in ${esc(soundingKey)}. Your sweet-spot keys are ${esc(rec.idealLabels.join(", "))}.`;
    tips.push(`<span><strong>Better for your voice:</strong> ${why} ${btns.join(" ")}</span>`);
  } else if (rec?.range?.wide) {
    tips.push(`<span><strong>Wide melody:</strong> it runs ${esc(rangeText(rec.range.sung))}, more than your ${esc(rangeText(rec.range.voice))} in any key.</span>`);
  }
  if (bestOpenCapo && bestOpenCapo.capo !== viewState.capo && viewState.capo === 0) {
    tips.push(
      `<span><strong>Easier chords:</strong> capo ${bestOpenCapo.capo} with ${esc(bestOpenCapo.shapesKey)} shapes keeps it in ${esc(soundingKey)}. <button type="button" class="advisor-apply-btn" id="apply-capo-tip-btn">Use capo ${bestOpenCapo.capo}</button></span>`
    );
  }

  // A better key for your voice waits under More: a dot on the button says so.
  const moreBtn = document.getElementById("toggle-more-controls-btn");
  if (moreBtn) {
    const hasVoiceTip = !!(rec && !rec.isAlreadyIdeal && rec.pureTranspose);
    moreBtn.classList.toggle("has-tip", hasVoiceTip);
    moreBtn.setAttribute("aria-label", hasVoiceTip ? "More (a better key for your voice)" : "More");
  }
  if (!tips.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `<div class="advisor-text">${tips.join(" • ")}</div>`;

  if (rec?.pureTranspose) {
    // Rewrites the sheet itself in the new key (with Undo), like "Rewrite in this key".
    document.getElementById("apply-ideal-transpose-btn")?.addEventListener("click", async () => {
      closeSheet("song-more-modal");
      await applyVoiceKey(rec);
    });
  }
  if (rec?.easyCapo) {
    document.getElementById("apply-ideal-capo-btn")?.addEventListener("click", () => {
      closeSheet("song-more-modal");
      viewState.semitoneDelta = rec.easyCapo.semitoneShiftFromWritten;
      viewState.capo = rec.easyCapo.capo;
      viewState.isDirty = true;
      refreshSongView();
      toast(`Applied ${rec.easyCapo.targetShapesKey} shapes + Capo ${rec.easyCapo.capo} → Sing in ${rec.easyCapo.targetSoundingKey}`);
    });
  }
  if (bestOpenCapo) {
    document.getElementById("apply-capo-tip-btn")?.addEventListener("click", () => {
      closeSheet("song-more-modal");
      viewState.semitoneDelta = ((viewState.semitoneDelta - bestOpenCapo.capo + 12 + 6) % 12) - 6;
      viewState.capo = bestOpenCapo.capo;
      viewState.isDirty = true;
      refreshSongView();
      toast(`Applied Capo ${bestOpenCapo.capo} (${bestOpenCapo.shapesKey} shapes → Sounds in ${soundingKey})`);
    });
  }
}

function openSidebarNoteEditor(targetKey, secLabel, triggerEl) {
  if (!activeSong) return;
  const parsed = parse(activeSong.chordpro || "");
  const secIdx = parseInt(targetKey.replace("sec-", ""), 10);
  const existingObj = viewState.sidebarNotes[targetKey];
  const fallbackNote = !isNaN(secIdx) && parsed.sections[secIdx] ? parsed.sections[secIdx].sidebarNote : "";
  const fallbackKind = !isNaN(secIdx) && parsed.sections[secIdx] ? parsed.sections[secIdx].sidebarKind : "dynamic";

  const textVal = chorusWording(existingObj?.text !== undefined ? existingObj.text : (fallbackNote || ""));
  const kindVal = existingObj?.kind || fallbackKind || "dynamic";

  const titleEl = document.getElementById("sidebar-note-modal-title");
  const keyInput = document.getElementById("sidebar-note-target-key");
  const textInput = document.getElementById("sidebar-note-text");
  const kindInput = document.getElementById("sidebar-note-kind");

  if (titleEl) titleEl.textContent = `Note for ${secLabel}`;
  if (keyInput) keyInput.value = targetKey;
  if (textInput) textInput.value = textVal;
  if (kindInput) kindInput.value = kindVal;

  openSheet("sidebar-note-modal", triggerEl);
  // Quick preset chips inside sidebar note modal
  document.querySelectorAll("[data-note-preset]").forEach((chip) => {
    chip.onclick = () => {
      if (textInput) textInput.value = chip.getAttribute("data-note-preset") || "";
      const k = chip.getAttribute("data-note-preset-kind");
      if (k && kindInput) kindInput.value = k;
      textInput?.focus();
    };
  });
}

function openChordInspector(chordName, triggerEl) {
  const parsed = parse(activeSong?.chordpro || "");
  const body = document.getElementById("chord-inspector-body");
  const title = document.getElementById("chord-inspector-title");
  if (!body || !title) return;
  title.textContent = `${chordName} — Guitar Voicing`;
  body.innerHTML = `
    <div class="inspector-diagram-wrap">
      ${renderChordDiagramSVG(chordName, { customDefines: parsed.meta.defines, leftHanded: viewState.leftHanded })}
    </div>
  `;
  openSheet("chord-inspector-modal", triggerEl);
}

function buildSongWithCurrentSettings() {
  const profile = getDeviceProfile();
  const prevPrefs = activeSong.layout_prefs || {};
  const nextPrefs = {
    ...prevPrefs,
    columns: viewState.columns,
    compact_chorus: viewState.compactChorus,
    hide_tabs: viewState.hideTabs,
    show_diagrams: viewState.showDiagrams,
    font_offset: viewState.fontOffset,
    accidental_pref: viewState.accidentalPref,
    sidebar_notes: JSON.parse(JSON.stringify(viewState.sidebarNotes))
  };
  if (viewState.melody) {
    nextPrefs.melody = viewState.melody;
    delete nextPrefs.melody_unknown;
  } else {
    delete nextPrefs.melody;
  }
  if (profile.isPhone) {
    nextPrefs.phone_page_mode = viewState.pageMode;
    nextPrefs.page_mode = prevPrefs.page_mode || "1-sheet";
  } else {
    nextPrefs.page_mode = viewState.pageMode;
  }
  return {
    ...activeSong,
    capo: viewState.capo,
    preferred_transpose: viewState.semitoneDelta,
    vocal_rating: viewState.vocalRating,
    vocal_comfort: viewState.vocalComfort,
    tuning: viewState.tuning,
    layout_prefs: nextPrefs,
    updated_at: new Date().toISOString()
  };
}

/**
 * Save the current settings with an Undo toast (used for section notes).
 */
export async function saveCurrentSettingsToSong({ silentMsg = null } = {}) {
  if (!activeSong || !onSaveSongCallback) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  const previousSnapshot = JSON.parse(JSON.stringify(activeSong));
  const updated = buildSongWithCurrentSettings();

  activeSong = updated;
  viewState.isDirty = false;
  await onSaveSongCallback(updated, { isUpdate: true });
  refreshSongView();

  toastAction(
    silentMsg || `Saved "${updated.title}"`,
    "Undo",
    async () => {
      cancelAutosave();
      activeSong = previousSnapshot;
      await onSaveSongCallback(previousSnapshot, { isUpdate: true });
      openSongView(previousSnapshot, { discardPending: true });
    }
  );
}

/**
 * Permanently transpose the stored ChordPro text to the currently displayed key ("Save in this key" + Undo).
 */
/**
 * One tap from My Keys → Bad fit: open the song and rewrite it in the key the app suggests for
 * your voice (with Undo).
 */
export async function rewriteInBetterKey(song) {
  if (!song) return;
  openSongView(song, { discardPending: true });
  const allSongs = getLibrarySongsCallback ? getLibrarySongsCallback() : [activeSong];
  const rec = getIdealVocalRangeRecommendations(songAsShown(), allSongs);
  if (!rec?.pureTranspose || rec.isAlreadyIdeal) {
    toast("This song already sits in a key that suits your voice.");
    return;
  }
  await applyVoiceKey(rec);
}

// Rewrites the sheet in the suggested key, or (when only the capo has to go) saves no capo, with
// Undo either way. A rating of how it felt in the old key no longer applies, so it's cleared.
async function applyVoiceKey(rec) {
  viewState.semitoneDelta = rec.pureTranspose.semitoneShiftFromWritten;
  viewState.capo = 0;
  if (viewState.semitoneDelta !== 0) {
    await bakeTransposedKeyIntoChordPro({ clearRating: !!rec.felt });
    return;
  }
  if (rec.felt) {
    viewState.vocalRating = null;
    viewState.vocalComfort = null;
  }
  await saveCurrentSettingsToSong({
    silentMsg: `Now in ${rec.pureTranspose.targetShapesKey}, no capo${rec.felt ? ". Rate it again once you’ve sung it" : ""}`
  });
}

async function bakeTransposedKeyIntoChordPro({ clearRating = false } = {}) {
  if (!activeSong || viewState.semitoneDelta === 0 || !onSaveSongCallback) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  const previousSnapshot = JSON.parse(JSON.stringify(activeSong));
  const parsed = parse(activeSong.chordpro || "");
  const baseKey = normalizeKeyName(activeSong.key || parsed.meta.key || parsed.meta.inferredKey || "G");
  const newKey = transposeKey(baseKey, viewState.semitoneDelta, viewState.accidentalPref);
  const newChordPro = transposeChordPro(activeSong.chordpro, viewState.semitoneDelta, newKey, viewState.accidentalPref);

  const updated = {
    ...activeSong,
    key: newKey,
    chordpro: newChordPro,
    preferred_transpose: 0,
    capo: viewState.capo,
    updated_at: new Date().toISOString()
  };
  // How it felt to sing was about the old key; Undo brings it back.
  if (clearRating) {
    updated.vocal_rating = null;
    updated.vocal_comfort = null;
    viewState.vocalRating = null;
    viewState.vocalComfort = null;
  }
  // The melody moves with the sheet, so you still sing the same notes.
  const melodyNow = storedMelody(songAsShown());
  if (melodyNow) {
    const { source, confidence, recordingKey } = melodyNow;
    viewState.melody = { low: melodyNow.low + viewState.semitoneDelta, high: melodyNow.high + viewState.semitoneDelta, key: newKey, source, confidence };
    if (recordingKey) viewState.melody.recording_key = recordingKey;
    updated.layout_prefs = { ...(updated.layout_prefs || {}), melody: viewState.melody };
  }

  activeSong = updated;
  viewState.semitoneDelta = 0;
  viewState.isDirty = false;
  await onSaveSongCallback(updated, { isUpdate: true });
  refreshSongView();

  toastAction(`Rewrote in ${newKey}${clearRating ? ". Rate it again once you’ve sung it" : ""}`, "Undo", async () => {
    cancelAutosave();
    activeSong = previousSnapshot;
    await onSaveSongCallback(previousSnapshot, { isUpdate: true });
    openSongView(previousSnapshot, { discardPending: true });
  });
}

// ============================================================================
// ChordPro Editor (with live preview + validation as you type)
// ============================================================================
let editingSongId = null;
let editingDraft = null;
let editorBaseline = "";
let editorHoldsImport = false;

const EDITOR_FIELD_IDS = ["edit-song-title", "edit-song-artist", "edit-song-key", "edit-song-capo", "edit-song-tempo", "edit-song-time", "edit-song-genre", "edit-song-tags", "edit-song-notes", "edit-song-chordpro"];

function editorSnapshot() {
  return JSON.stringify(EDITOR_FIELD_IDS.map((id) => document.getElementById(id)?.value ?? ""));
}

// An imported sheet counts as unsaved work even before the user touches it.
function editorHasUnsavedWork() {
  return editorHoldsImport || editorSnapshot() !== editorBaseline;
}

export function openSongEditor(songDraft = {}, triggerEl = null) {
  if (songDraft.id) {
    const saved = flushAutosave();
    if (saved && saved.id === songDraft.id) songDraft = saved;
  }
  editingSongId = songDraft.id || null;
  editingDraft = songDraft;
  editorHoldsImport = !songDraft.id && !!songDraft.source;
  const titleEl = document.getElementById("editor-modal-title");
  if (titleEl) titleEl.textContent = editingSongId ? `Edit "${songDraft.title}"` : "Check and save";

  document.getElementById("edit-song-title").value = songDraft.title || "";
  document.getElementById("edit-song-artist").value = songDraft.artist || "";
  document.getElementById("edit-song-key").value = songDraft.key || "G";
  document.getElementById("edit-song-capo").value = String(songDraft.capo || 0);
  const draftMeta = parse(songDraft.chordpro || "").meta;
  document.getElementById("edit-song-tempo").value = songDraft.tempo || draftMeta.tempo || "";
  const timeInput = document.getElementById("edit-song-time");
  const draftTime = songDraft.time_signature || draftMeta.time || "";
  if (draftTime && !Array.from(timeInput.options).some((o) => o.value === draftTime)) {
    timeInput.add(new Option(draftTime, draftTime));
  }
  timeInput.value = draftTime;
  document.getElementById("edit-song-tags").value = (songDraft.tags || []).join(", ");
  document.getElementById("edit-song-genre").value = getSongGenre(songDraft);
  document.getElementById("edit-song-notes").value = chorusWording(songDraft.notes || "");
  document.getElementById("edit-song-chordpro").value = chorusWordingInChordPro(songDraft.chordpro || "");
  editorBaseline = editorSnapshot();

  updateEditorLiveValidation();
  renderEditorVocalRangeTip();
  renderEditorAlignmentQualityCheck();
  openSheet("song-editor-modal", triggerEl);
}

function renderEditorAlignmentQualityCheck() {
  const qcBox = document.getElementById("editor-alignment-qc-box");
  const textarea = document.getElementById("edit-song-chordpro");
  if (!qcBox || !textarea) return;

  const text = textarea.value || "";
  if (!text.trim()) {
    qcBox.hidden = true;
    return;
  }

  const report = auditChordAlignment(text);
  qcBox.hidden = false;
  const aiCheckBtn = getCloud()
    ? `<button type="button" class="ghost-btn small-btn" id="editor-run-ai-qc-btn">Check timing with AI</button>`
    : "";

  if (report.issueCount === 0) {
    qcBox.className = "alignment-qc-card is-passed";
    qcBox.innerHTML = `
      <div class="qc-card-row">
        <div>
          <strong class="qc-card-title">✓ Chords line up</strong>
        </div>
        <div class="qc-card-actions">${aiCheckBtn}</div>
      </div>
    `;
  } else {
    qcBox.className = "alignment-qc-card has-issues";
    const itemsHtml = report.issues
      .slice(0, 5)
      .map(
        (it) => `
        <li class="qc-issue-item">
          <span class="qc-issue-sec">${esc(it.section)}:</span>
          <span>${esc(it.message)}</span>
        </li>
      `
      )
      .join("");
    qcBox.innerHTML = `
      <div class="qc-card-row">
        <div>
          <strong class="qc-card-title">${report.issueCount} chord${report.issueCount === 1 ? "" : "s"} could line up better</strong>
        </div>
        <div class="qc-card-actions">
          ${report.autoFixCount > 0 ? `<button type="button" class="solid-btn small-btn" id="editor-apply-qc-fixes-btn">Fix ${report.autoFixCount}</button>` : ""}
          ${aiCheckBtn}
        </div>
      </div>
      <ul class="qc-issue-list">${itemsHtml}</ul>
    `;
  }

  document.getElementById("editor-apply-qc-fixes-btn")?.addEventListener("click", () => {
    textarea.value = report.fixedChordpro;
    updateEditorLiveValidation();
    renderEditorAlignmentQualityCheck();
    toast(`Fixed ${report.autoFixCount} chord${report.autoFixCount === 1 ? "" : "s"}`);
  });

  document.getElementById("editor-run-ai-qc-btn")?.addEventListener("click", (e) => {
    runAiChordAlignmentCheck({
      title: document.getElementById("edit-song-title")?.value || "",
      artist: document.getElementById("edit-song-artist")?.value || "",
      key: document.getElementById("edit-song-key")?.value || "G",
      capo: parseInt(document.getElementById("edit-song-capo")?.value || "0", 10) || 0,
      chordpro: textarea.value,
      btn: e.currentTarget,
      onAligned: (alignedPro) => {
        textarea.value = alignedPro;
        updateEditorLiveValidation();
        renderEditorAlignmentQualityCheck();
      }
    });
  });
}

function renderEditorVocalRangeTip() {
  const tipBox = document.getElementById("editor-vocal-range-tip");
  const keyInput = document.getElementById("edit-song-key");
  const capoInput = document.getElementById("edit-song-capo");
  const chordproInput = document.getElementById("edit-song-chordpro");
  if (!tipBox || !chordproInput) return;

  const allSongs = getLibrarySongsCallback ? getLibrarySongsCallback() : [];
  const draft = {
    key: keyInput?.value?.trim() || "",
    capo: parseInt(capoInput?.value || "0", 10) || 0,
    preferred_transpose: 0,
    tuning: editingDraft?.tuning,
    layout_prefs: editingDraft?.layout_prefs,
    chordpro: chordproInput.value || ""
  };
  const rec = getIdealVocalRangeRecommendations(draft, allSongs);
  if (!rec || !rec.pureTranspose || rec.isAlreadyIdeal) {
    tipBox.hidden = true;
    return;
  }

  const pt = rec.pureTranspose;
  const capoOpt = rec.easyCapo;
  const idealStr = rec.idealLabels.join(", ");

  const statusHeadline = rec.range
    ? `The melody runs <strong>${esc(rangeText(rec.range.sung))}</strong>; your range is <strong>${esc(rangeText(rec.range.voice))}</strong>.`
    : `This sounds in <strong>${esc(rec.currentSoundingKey)}</strong>. Your sweet-spot keys are <strong>${esc(idealStr)}</strong>.`;

  const actionButtons = [];
  if (pt) {
    actionButtons.push(
      `<button type="button" class="solid-btn small-btn" id="editor-apply-ideal-transpose">Rewrite in ${esc(pt.targetShapesKey)}</button>`
    );
  }
  if (capoOpt) {
    actionButtons.push(
      `<button type="button" class="ghost-btn small-btn" id="editor-apply-ideal-capo">🎸 ${esc(capoOpt.label)}</button>`
    );
  }

  tipBox.hidden = false;
  tipBox.innerHTML = `
    <div class="vocal-tip-header">
      <span class="vocal-tip-title">Better for your voice</span>
    </div>
    <p class="vocal-tip-desc">${statusHeadline}</p>
    <div class="vocal-tip-actions">${actionButtons.join("")}</div>
  `;

  const applyEditorShift = (shiftSemitones, targetShapesKey, newCapo, toastMsg) => {
    const updatedPro = transposeChordPro(chordproInput.value, shiftSemitones, targetShapesKey);
    chordproInput.value = updatedPro;
    if (keyInput) keyInput.value = targetShapesKey;
    if (capoInput) capoInput.value = String(newCapo);
    updateEditorLiveValidation();
    renderEditorVocalRangeTip();
    toast(toastMsg);
  };

  if (pt) {
    document.getElementById("editor-apply-ideal-transpose")?.addEventListener("click", () => {
      applyEditorShift(
        pt.semitoneShiftFromWritten,
        pt.targetShapesKey,
        0,
        `Transposed sheet to ${pt.targetSoundingKey} (No Capo)`
      );
    });
  }
  if (capoOpt) {
    document.getElementById("editor-apply-ideal-capo")?.addEventListener("click", () => {
      applyEditorShift(
        capoOpt.semitoneShiftFromWritten,
        capoOpt.targetShapesKey,
        capoOpt.capo,
        `Set ${capoOpt.targetShapesKey} shapes + Capo ${capoOpt.capo} (Singing in ${capoOpt.targetSoundingKey})`
      );
    });
  }
}

// Keeps a {tempo: } or {time: } line in the sheet from disagreeing with the editor field.
function syncDirective(chordpro, name, value) {
  const line = new RegExp(`^[ \\t]*\\{${name}:[^}]*\\}[ \\t]*\\n?`, "im");
  if (!line.test(chordpro)) return chordpro;
  return chordpro.replace(line, value ? `{${name}: ${value}}\n` : "");
}

function initSongEditorEvents() {
  const genreSelect = document.getElementById("edit-song-genre");
  if (genreSelect) {
    genreSelect.innerHTML = GENRES.map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join("");
  }

  setSheetCloseGuard("song-editor-modal", () =>
    !editorHasUnsavedWork() || window.confirm("Discard your changes? They haven’t been saved.")
  );

  const textarea = document.getElementById("edit-song-chordpro");
  if (textarea) {
    textarea.addEventListener("input", () => {
      updateEditorLiveValidation();
      renderEditorAlignmentQualityCheck();
    });
  }

  const form = document.getElementById("song-editor-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = document.getElementById("edit-song-title").value.trim();
      const artist = document.getElementById("edit-song-artist").value.trim();
      const key = document.getElementById("edit-song-key").value.trim() || "G";
      const capo = parseInt(document.getElementById("edit-song-capo").value, 10) || 0;
      const tags = document.getElementById("edit-song-tags").value
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const notes = document.getElementById("edit-song-notes").value.trim();
      const genre = document.getElementById("edit-song-genre").value || "worship";
      const tempoValue = parseInt(document.getElementById("edit-song-tempo").value, 10);
      const tempo = tempoValue >= 20 && tempoValue <= 300 ? tempoValue : null;
      const timeSignature = document.getElementById("edit-song-time").value || null;
      const chordpro = syncDirective(
        syncDirective(document.getElementById("edit-song-chordpro").value.trim(), "tempo", tempo),
        "time",
        timeSignature
      );

      if (!title || !chordpro) {
        toastError("Title and ChordPro sheet are required.");
        return;
      }

      const existing = editingSongId && activeSong && activeSong.id === editingSongId ? activeSong : null;
      const previousSnapshot = existing ? JSON.parse(JSON.stringify(existing)) : null;

      const base = existing || editingDraft || {};
      const now = new Date().toISOString();
      // Start from the full song so fields without an editor input (tempo, time, tuning, source) survive.
      const songObj = {
        ...base,
        id: editingSongId || (crypto.randomUUID ? crypto.randomUUID() : "song-" + Date.now()),
        title,
        artist,
        key,
        capo,
        tempo,
        time_signature: timeSignature,
        preferred_transpose: base.preferred_transpose ?? 0,
        tags,
        notes,
        chordpro,
        is_favorite: !!base.is_favorite,
        vocal_rating: base.vocal_rating ?? null,
        vocal_comfort: base.vocal_comfort ?? null,
        layout_prefs: { ...(base.layout_prefs || {
          page_mode: "1-sheet",
          columns: "auto",
          compact_chorus: false,
          show_diagrams: false,
          font_offset: 0,
          accidental_pref: "auto",
          sidebar_notes: {}
        }), genre },
        created_at: base.created_at || now,
        updated_at: now
      };

      closeSheet("song-editor-modal", { force: true });
      if (onSaveSongCallback) {
        await onSaveSongCallback(songObj, { isUpdate: !!existing });
      }
      openSongView(songObj, { discardPending: true });

      if (previousSnapshot) {
        toastAction(`Saved "${songObj.title}"`, "Undo", async () => {
          cancelAutosave();
          await onSaveSongCallback(previousSnapshot, { isUpdate: true });
          openSongView(previousSnapshot, { discardPending: true });
        });
      } else {
        toast(`Saved "${songObj.title}"`);
      }
    });
  }
}

function updateEditorLiveValidation() {
  const textarea = document.getElementById("edit-song-chordpro");
  const statusEl = document.getElementById("editor-validation-status");
  if (!textarea || !statusEl) return;

  const text = textarea.value;
  const parsed = parse(text);
  const warnings = [];

  if (parsed.meta.unknownDirectives?.length) {
    warnings.push(`Unknown directive: ${parsed.meta.unknownDirectives[0]}`);
  }
  if (!parsed.sections.length) {
    warnings.push("Add at least one section or lyric line.");
  }

  if (warnings.length) {
    statusEl.className = "editor-validation is-warn";
    statusEl.textContent = warnings.join(" • ");
  } else {
    statusEl.className = "editor-validation is-ok";
    statusEl.textContent = `${parsed.sections.length} section${parsed.sections.length === 1 ? "" : "s"} · ${parsed.allChords.length} chord${parsed.allChords.length === 1 ? "" : "s"}`;
  }
}
