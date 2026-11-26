// Main Application Entry & Song Library Controller (js/library.js)
// Coordinates:
// - Auth Gate (House Index account required; see initAuthAndLoadData)
// - Song Library list, search (title/artist/tags/lyrics), sort, tag & vocal-key filters
// - Song View, Import Modal, Vocal Key Analytics Modal, Set Lists Modal, and Guide Modal
// - Full delete + Undo (restoring song, shares, and set-list entries)

import {
  APP_VERSION,
  esc,
  getSupabase,
  getCloud,
  GENRES,
  getSongGenre,
  setCurrentUserId,
  loadLocal,
  saveLocal,
  toast,
  toastAction,
  toastError,
  openSheet,
  closeSheet,
  setupGlobalEscapeAndBackdrop,
  queueOfflineWrite,
  flushOfflineQueue,
  updateOfflineBanner
} from "./core.js";
import {
  getSongEffectiveKeys,
  renderAnalyticsDashboardHTML,
  getPinnedIdealKeys,
  setPinnedIdealKeys
} from "./analytics.js";
import {
  applyDeviceBodyAttributes,
  getDeviceProfile,
  setDeviceOverride
} from "./device.js";
import { initSongController, openSongView, openSongEditor, getActiveSong, showEmptySongStage, applyMelodyToOpenSong, rewriteInBetterKey } from "./song.js";
import { initImportModal, lookUpMelodyRanges } from "./ai.js";
import { REVISIONS } from "./revisions.js";
import { melodyFromRecording, storedMelody, songsMissingMelody, getVocalRange, setManualVocalRange } from "./melody.js";
import { initPerformanceControls } from "./perform.js";
import { loadSetlists, renderSetlistsSheetHTML, getSetlistItems } from "./setlists.js";

let songs = [];
let searchQuery = "";
let sortMode = "az"; // "az" | "key" | "artist" | "fit" | "recent"
let filterTag = "";
let filterGenre = "";
let filterKey = "";
let filterCapo = "any"; // "any" | "none" | "capo"
let filterFavoritesOnly = false;
let filterBestVocalFit = false;
let filterDrawerOpen = false;
let songsLoadFailed = false;

export function getSongs() {
  return songs;
}

export async function loadSongs() {
  const cloud = getCloud();
  songsLoadFailed = false;
  if (cloud) {
    // Signed in: Supabase is the source of truth. The per-account cache covers a bad connection.
    const cachedCloud = loadLocal("songs", null);
    let result = { data: null, error: new Error("not loaded") };
    try {
      result = await cloud.from("cb_songs").select("*").order("title", { ascending: true });
    } catch (error) {
      result = { data: null, error };
    }
    if (!result.error && Array.isArray(result.data)) {
      songs = result.data;
      saveLocal("songs", songs);
    } else {
      console.error("Couldn't load songs:", result.error);
      songs = Array.isArray(cachedCloud) ? cachedCloud : [];
      songsLoadFailed = !Array.isArray(cachedCloud);
      if (!songsLoadFailed) toast("Showing your saved copy. Couldn’t reach the cloud.");
    }
    return songs;
  }

  // Signed out: whatever this browser already holds. Song lyrics are never shipped in the public code.
  const cached = loadLocal("songs", null);
  songs = Array.isArray(cached) ? cached : [];
  return songs;
}

export async function saveSong(songObj, { isUpdate = false } = {}) {
  const idx = songs.findIndex((s) => s.id === songObj.id);
  if (idx >= 0) {
    songs[idx] = songObj;
  } else {
    songs.unshift(songObj);
  }
  saveLocal("songs", songs);
  renderLibrarySidebar();

  const sb = getCloud();
  if (!sb) return;
  if (idx < 0 && !storedMelody(songObj)) queueMelodyLookup(songObj.id);
  try {
    if (isUpdate && idx >= 0) {
      const { error } = await sb.from("cb_songs").update(songObj).eq("id", songObj.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from("cb_songs").insert(songObj);
      if (error) throw error;
    }
  } catch {
    queueOfflineWrite({ type: isUpdate ? "update_song" : "insert_song", row: songObj });
  }
}

function openWhatsNew() {
  const body = document.getElementById("whats-new-body");
  if (!body) return;
  const day = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  body.innerHTML = `<ol class="revision-list">${REVISIONS.map((r) => `
    <li class="revision-item">
      <div class="revision-head"><strong>v${esc(r.version)}</strong><span class="revision-date">${esc(day(r.date))}</span>${r.version === APP_VERSION ? `<span class="revision-current">You have this</span>` : ""}</div>
      <ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
    </li>`).join("")}</ol>`;
  openSheet("whats-new-modal");
}

// A new song's melody range is looked up a moment after it is added, in one call for a whole
// set list, without holding anything up.
let melodyAutoLookupDone = false;
const melodyQueue = new Set();
let melodyTimer = null;
function queueMelodyLookup(id) {
  melodyQueue.add(id);
  clearTimeout(melodyTimer);
  melodyTimer = setTimeout(() => {
    const ids = new Set(melodyQueue);
    melodyQueue.clear();
    findMelodyRanges(songs.filter((s) => ids.has(s.id)), { quiet: true });
  }, 2500);
}

/** Look up and save the melody range of each song. Resolves to { found, unknown, error }. */
export async function findMelodyRanges(list, { quiet = false } = {}) {
  const targets = list.filter((s) => s?.id && s.title);
  if (!targets.length) return { found: 0, unknown: 0 };
  const res = await lookUpMelodyRanges(targets);
  let found = 0;
  for (const m of res.melodies || []) {
    const cur = songs.find((s) => s.id === m.id);
    if (!cur) continue;
    const melody = melodyFromRecording(cur, m);
    const prefs = { ...(cur.layout_prefs || {}), melody };
    delete prefs.melody_unknown;
    await saveSong({ ...cur, layout_prefs: prefs }, { isUpdate: true });
    // The open song keeps its own copy, so its next save keeps the range too.
    applyMelodyToOpenSong(cur.id, melody);
    found++;
  }
  // Songs the AI doesn't know aren't asked about again automatically. A song that already has a
  // range keeps it; it's only marked so the refresh doesn't ask again.
  for (const id of res.unknownIds || []) {
    const cur = songs.find((s) => s.id === id);
    if (!cur) continue;
    const prefs = { ...(cur.layout_prefs || {}) };
    if (storedMelody(cur)) prefs.melody = { ...prefs.melody, original_unknown: true };
    else prefs.melody_unknown = true;
    await saveSong({ ...cur, layout_prefs: prefs }, { isUpdate: true });
    if (prefs.melody) applyMelodyToOpenSong(cur.id, prefs.melody);
  }
  const unknown = (res.unknownIds || []).length;
  if (res.error) {
    if (!quiet) toastError(res.error);
    else console.warn("Melody lookup:", res.error);
  } else if (!quiet) {
    toast(`Found the melody range for ${found} song${found === 1 ? "" : "s"}${unknown ? `. The AI doesn’t know ${unknown}; set those under More` : ""}.`);
  }
  return { found, unknown, error: res.error || null };
}

export async function deleteSongWithUndo(songObj) {
  const idx = songs.findIndex((s) => s.id === songObj.id);
  if (idx === -1) return;
  const [removed] = songs.splice(idx, 1);
  // Capture cascaded setlist items so Undo restores everything (SPEC 2.4)
  const cascadedItems = getSetlistItems().filter((it) => it.song_id === songObj.id);
  saveLocal("songs", songs);

  const sb = getCloud();
  if (sb) {
    try {
      const { error } = await sb.from("cb_songs").delete().eq("id", songObj.id);
      if (error) throw error;
    } catch (error) {
      console.error("Delete failed:", error);
      toastError("Couldn’t delete that from the cloud. It may come back.");
    }
  }

  renderLibrarySidebar();
  if (songs.length > 0) {
    openSongView(songs[0], { discardPending: true });
  } else {
    showEmptySongStage();
  }

  toastAction(`Deleted "${removed.title}"`, "Undo", async () => {
    songs.splice(idx, 0, removed);
    saveLocal("songs", songs);
    if (sb) {
      try {
        const restored = await sb.from("cb_songs").insert(removed);
        if (restored.error) throw restored.error;
        for (const item of cascadedItems) {
          const relinked = await sb.from("cb_setlist_items").insert(item);
          if (relinked.error) throw relinked.error;
        }
      } catch (error) {
        console.error("Undo failed:", error);
        toastError("Couldn’t restore that in the cloud.");
      }
    }
    renderLibrarySidebar();
    openSongView(removed, { discardPending: true });
  });
}

// ============================================================================
// Library List, Search, Sort & Filter Rendering
// ============================================================================
function parseSearchTokens(rawQuery) {
  const tokens = (rawQuery || "").trim().split(/\s+/).filter(Boolean);
  const filters = { key: "", sing: "", capo: null, tag: "", words: [] };
  for (const t of tokens) {
    const low = t.toLowerCase();
    if (low.startsWith("key:")) {
      filters.key = low.slice(4);
    } else if (low.startsWith("sing:")) {
      filters.sing = low.slice(5);
    } else if (low.startsWith("capo:")) {
      const n = parseInt(low.slice(5), 10);
      if (!isNaN(n)) filters.capo = n;
    } else if (low.startsWith("#") && low.length > 1) {
      filters.tag = low.slice(1);
    } else {
      filters.words.push(low);
    }
  }
  return filters;
}

function findLyricSnippet(chordproText, phrase) {
  if (!phrase || !chordproText) return "";
  const lines = String(chordproText).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("{")) continue;
    const plain = trimmed.replace(/\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
    if (plain.toLowerCase().includes(phrase)) {
      return plain.length > 52 ? plain.slice(0, 49) + "…" : plain;
    }
  }
  return "";
}

function getGroupLabelForSong(song, keys, mode) {
  if (mode === "key") {
    return `Sing in ${keys.soundingKey}`;
  }
  if (mode === "artist") {
    return (song.artist || "Unknown Artist").trim();
  }
  if (mode === "fit") {
    const r = Number(song.vocal_rating || 0);
    if (r >= 5 || song.vocal_comfort === "sweet_spot") return "Money keys";
    if (r >= 4) return "Good fit";
    return "Other Keys";
  }
  if (mode === "recent") {
    return "Recently Updated";
  }
  const ch = (song.title || "?").trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}

export function renderLibrarySidebar() {
  const listEl = document.getElementById("song-library-list");
  const countEl = document.getElementById("song-library-count");
  const tagChipsEl = document.getElementById("library-tag-chips");
  const filterDrawerEl = document.getElementById("library-filter-drawer");
  const clearSearchBtn = document.getElementById("library-search-clear");
  if (!listEl) return;

  if (clearSearchBtn) {
    clearSearchBtn.hidden = !searchQuery.trim();
  }

  // Collect distinct tags and sounding keys with counts
  const tagCounts = new Map();
  const keyCounts = new Map();
  const genreCounts = new Map();
  songs.forEach((s) => {
    const genre = getSongGenre(s);
    genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
    (s.tags || []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1));
    const sk = getSongEffectiveKeys(s).soundingKey;
    keyCounts.set(sk, (keyCounts.get(sk) || 0) + 1);
  });

  const activeFilterCount = (filterFavoritesOnly ? 1 : 0) + (filterBestVocalFit ? 1 : 0)
    + (filterGenre ? 1 : 0) + (filterTag ? 1 : 0) + (filterKey ? 1 : 0) + (filterCapo !== "any" ? 1 : 0);

  if (tagChipsEl) {
    tagChipsEl.innerHTML = `
      <button type="button" class="filter-chip ${filterDrawerOpen || activeFilterCount > 0 ? "is-active" : ""}" id="toggle-filter-drawer-btn" aria-expanded="${filterDrawerOpen ? "true" : "false"}">
        Filter${activeFilterCount ? ` (${activeFilterCount})` : ""} ▾
      </button>
      ${filterGenre ? `<button type="button" class="filter-chip is-active" data-clear-genre="1">${esc(GENRES.find((g) => g.id === filterGenre)?.label || "")} ×</button>` : ""}
      ${filterFavoritesOnly ? `<button type="button" class="filter-chip is-active" data-clear-fav="1">★ Favorites ×</button>` : ""}
      ${filterBestVocalFit ? `<button type="button" class="filter-chip is-active" data-clear-vocal="1">Sweet spot ×</button>` : ""}
      ${filterKey ? `<button type="button" class="filter-chip is-active" data-clear-key="1">Key: ${esc(filterKey)} ×</button>` : ""}
      ${filterCapo !== "any" ? `<button type="button" class="filter-chip is-active" data-clear-capo="1">${filterCapo === "none" ? "No capo" : "Capo"} ×</button>` : ""}
      ${filterTag ? `<button type="button" class="filter-chip is-active" data-clear-tag="1">#${esc(filterTag)} ×</button>` : ""}
    `;

    tagChipsEl.querySelector("#toggle-filter-drawer-btn")?.addEventListener("click", () => {
      filterDrawerOpen = !filterDrawerOpen;
      renderLibrarySidebar();
    });
    const clearers = {
      "[data-clear-genre]": () => { filterGenre = ""; },
      "[data-clear-fav]": () => { filterFavoritesOnly = false; },
      "[data-clear-vocal]": () => { filterBestVocalFit = false; },
      "[data-clear-key]": () => { filterKey = ""; },
      "[data-clear-capo]": () => { filterCapo = "any"; },
      "[data-clear-tag]": () => { filterTag = ""; }
    };
    Object.entries(clearers).forEach(([selector, clear]) => {
      tagChipsEl.querySelector(selector)?.addEventListener("click", () => {
        clear();
        renderLibrarySidebar();
      });
    });
  }

  // Sort and every filter live in one drawer, closed by default
  if (filterDrawerEl) {
    filterDrawerEl.hidden = !filterDrawerOpen;
    if (filterDrawerOpen) {
      const sortedKeys = Array.from(keyCounts.keys()).sort();
      // Genre and Capo have their own filters, so their matching tags would only repeat them.
      const sortedTags = Array.from(tagCounts.keys())
        .filter((t) => !/^capo-\d+$/i.test(t) && t.toLowerCase() !== "worship")
        .sort();
      const sortOptions = [["az", "A–Z"], ["key", "Singing key"], ["artist", "Artist"], ["fit", "Best vocal fit"], ["recent", "Recently saved"]];
      filterDrawerEl.innerHTML = `
        <div class="filter-drawer-section">
          <label class="filter-drawer-label" for="library-sort">Sort</label>
          <select id="library-sort" class="input-select">
            ${sortOptions.map(([v, label]) => `<option value="${v}" ${sortMode === v ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>
        <div class="filter-drawer-section">
          <span class="filter-drawer-label">Genre</span>
          <div class="filter-drawer-pills">
            ${GENRES.map((g) => `<button type="button" class="mini-filter-pill ${filterGenre === g.id ? "is-active" : ""}" data-pick-genre="${g.id}" aria-pressed="${filterGenre === g.id ? "true" : "false"}">${esc(g.label)} (${genreCounts.get(g.id) || 0})</button>`).join("")}
          </div>
        </div>
        <div class="filter-drawer-section">
          <span class="filter-drawer-label">Show</span>
          <div class="filter-drawer-pills">
            <button type="button" class="mini-filter-pill ${filterFavoritesOnly ? "is-active" : ""}" data-pick-fav="1">★ Favorites</button>
            <button type="button" class="mini-filter-pill ${filterBestVocalFit ? "is-active" : ""}" data-pick-vocal="1">Sweet spot</button>
            <button type="button" class="mini-filter-pill ${filterCapo === "none" ? "is-active" : ""}" data-pick-capo="none">No capo</button>
            <button type="button" class="mini-filter-pill ${filterCapo === "capo" ? "is-active" : ""}" data-pick-capo="capo">Capo</button>
          </div>
        </div>
        <div class="filter-drawer-section">
          <span class="filter-drawer-label">Singing key</span>
          <div class="filter-drawer-pills">
            ${sortedKeys.map((k) => `<button type="button" class="mini-filter-pill ${filterKey === k ? "is-active" : ""}" data-pick-key="${esc(k)}">${esc(k)} (${keyCounts.get(k)})</button>`).join("")}
          </div>
        </div>
        <div class="filter-drawer-section">
          <span class="filter-drawer-label">Tags</span>
          <div class="filter-drawer-pills">
            ${sortedTags.map((t) => `<button type="button" class="mini-filter-pill ${filterTag === t ? "is-active" : ""}" data-pick-tag="${esc(t)}">#${esc(t)} (${tagCounts.get(t)})</button>`).join("")}
          </div>
        </div>
      `;

      filterDrawerEl.querySelector("#library-sort")?.addEventListener("change", (e) => {
        sortMode = e.target.value || "az";
        renderLibrarySidebar();
      });
      filterDrawerEl.querySelectorAll("[data-pick-genre]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.getAttribute("data-pick-genre");
          filterGenre = filterGenre === val ? "" : val;
          renderLibrarySidebar();
        });
      });
      filterDrawerEl.querySelector("[data-pick-fav]")?.addEventListener("click", () => {
        filterFavoritesOnly = !filterFavoritesOnly;
        renderLibrarySidebar();
      });
      filterDrawerEl.querySelector("[data-pick-vocal]")?.addEventListener("click", () => {
        filterBestVocalFit = !filterBestVocalFit;
        renderLibrarySidebar();
      });
      filterDrawerEl.querySelectorAll("[data-pick-key]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.getAttribute("data-pick-key");
          filterKey = filterKey === val ? "" : val;
          renderLibrarySidebar();
        });
      });
      filterDrawerEl.querySelectorAll("[data-pick-capo]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.getAttribute("data-pick-capo");
          filterCapo = filterCapo === val ? "any" : val;
          renderLibrarySidebar();
        });
      });
      filterDrawerEl.querySelectorAll("[data-pick-tag]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const val = btn.getAttribute("data-pick-tag");
          filterTag = filterTag === val ? "" : val;
          renderLibrarySidebar();
        });
      });
    }
  }

  const parsedSearch = parseSearchTokens(searchQuery);
  const textPhrase = parsedSearch.words.join(" ");

  const filtered = songs.filter((s) => {
    const eff = getSongEffectiveKeys(s);
    if (filterGenre && getSongGenre(s) !== filterGenre) return false;
    if (filterFavoritesOnly && !s.is_favorite) return false;
    if (filterBestVocalFit && s.vocal_comfort !== "sweet_spot" && (s.vocal_rating || 0) < 4) return false;
    if (filterTag && !(s.tags || []).includes(filterTag)) return false;
    if (filterKey && eff.soundingKey !== filterKey) return false;
    if (filterCapo === "none" && eff.capo > 0) return false;
    if (filterCapo === "capo" && eff.capo === 0) return false;

    if (parsedSearch.key && eff.shapesKey.toLowerCase() !== parsedSearch.key && (s.key || "").toLowerCase() !== parsedSearch.key) return false;
    if (parsedSearch.sing && eff.soundingKey.toLowerCase() !== parsedSearch.sing) return false;
    if (parsedSearch.capo !== null && eff.capo !== parsedSearch.capo) return false;
    if (parsedSearch.tag && !(s.tags || []).some((t) => t.toLowerCase() === parsedSearch.tag)) return false;

    if (!textPhrase) return true;
    const hay = `${s.title || ""} ${s.artist || ""} ${(s.tags || []).join(" ")} ${eff.shapesKey} ${eff.soundingKey} ${s.chordpro || ""}`.toLowerCase();
    return hay.includes(textPhrase);
  });

  filtered.sort((a, b) => {
    if (sortMode === "recent") {
      return String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""));
    }
    if (sortMode === "key") {
      const ka = getSongEffectiveKeys(a).soundingKey;
      const kb = getSongEffectiveKeys(b).soundingKey;
      return ka.localeCompare(kb) || a.title.localeCompare(b.title);
    }
    if (sortMode === "artist") {
      return (a.artist || "").localeCompare(b.artist || "") || a.title.localeCompare(b.title);
    }
    if (sortMode === "fit") {
      return (b.vocal_rating || 0) - (a.vocal_rating || 0) || a.title.localeCompare(b.title);
    }
    return (a.title || "").localeCompare(b.title || "");
  });

  if (countEl) {
    countEl.textContent = `${filtered.length} song${filtered.length === 1 ? "" : "s"}`;
  }

  const currentActive = getActiveSong();

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="library-empty">
        <p>No songs match that search or filter.</p>
        <button type="button" class="ghost-btn" id="empty-reset-btn">Clear Filters</button>
        <button type="button" class="ghost-btn" id="empty-import-btn">＋ Add a song</button>
      </div>
    `;
    listEl.querySelector("#empty-reset-btn")?.addEventListener("click", () => {
      searchQuery = "";
      const inp = document.getElementById("library-search");
      if (inp) inp.value = "";
      filterGenre = "";
      filterTag = "";
      filterKey = "";
      filterCapo = "any";
      filterFavoritesOnly = false;
      filterBestVocalFit = false;
      renderLibrarySidebar();
    });
    listEl.querySelector("#empty-import-btn")?.addEventListener("click", (e) => {
      openSheet("import-sheet-modal", e.currentTarget);
    });
    return;
  }

  // Render grouped list with sticky headers when useful
  let lastGroup = null;
  const rowsHtml = [];

  for (const s of filtered) {
    const k = getSongEffectiveKeys(s);
    const isSelected = currentActive && currentActive.id === s.id;
    const grp = getGroupLabelForSong(s, k, sortMode);

    if (grp !== lastGroup) {
      rowsHtml.push(`<div class="library-group-header">${esc(grp)}</div>`);
      lastGroup = grp;
    }

    const lyricSnippet = textPhrase && !(s.title || "").toLowerCase().includes(textPhrase) && !(s.artist || "").toLowerCase().includes(textPhrase)
      ? findLyricSnippet(s.chordpro, textPhrase)
      : "";

    const keyLabel = k.capo > 0
      ? `${k.shapesKey} · Capo ${k.capo}`
      : (k.transpose !== 0 ? `${k.writtenKey}→${k.soundingKey}` : k.shapesKey);

    rowsHtml.push(`
      <div class="song-list-card ${isSelected ? "is-selected" : ""}" data-song-id="${esc(s.id)}">
        <button type="button" class="song-card-select" data-select-song="${esc(s.id)}">
          <div class="song-card-top">
            <strong class="song-card-title">${esc(s.title)}</strong>
          </div>
          <div class="song-card-bottom">
            <span class="song-card-artist">${esc(s.artist || "Unknown artist")}</span>
            <span class="song-card-key-pill" title="Shapes: ${esc(k.shapesKey)}${k.capo ? ` (Capo ${k.capo} → Sing ${k.soundingKey})` : ""}">
              ${esc(keyLabel)}
            </span>
          </div>
          ${lyricSnippet ? `<div class="song-card-lyric-hit">“${esc(lyricSnippet)}”</div>` : ""}
        </button>
        <button type="button" class="song-fav-btn ${s.is_favorite ? "is-fav" : ""}" data-toggle-fav="${esc(s.id)}" aria-label="Favorite ${esc(s.title)}" aria-pressed="${s.is_favorite ? "true" : "false"}">
          ${s.is_favorite ? "★" : "☆"}
        </button>
      </div>
    `);
  }

  listEl.innerHTML = rowsHtml.join("");

  listEl.querySelectorAll("[data-select-song]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-select-song");
      const song = songs.find((s) => s.id === id);
      if (song) {
        openSongView(song);
        renderLibrarySidebar();
      }
    });
  });

  listEl.querySelectorAll("[data-toggle-fav]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-toggle-fav");
      const song = songs.find((s) => s.id === id);
      if (song) {
        song.is_favorite = !song.is_favorite;
        await saveSong(song, { isUpdate: true });
      }
    });
  });
}

// ============================================================================
// Boot & Auth Initialization
// ============================================================================
async function bootApp() {
  // The boot guard (js/boot-guard.js) offers a fresh reload if this never runs.
  window.__cbBooted = true;
  const verEl = document.getElementById("app-version-pill");
  if (verEl) {
    verEl.textContent = `v${APP_VERSION}`;
    verEl.addEventListener("click", () => {
      closeSheet("account-modal");
      openWhatsNew();
    });
  }
  // After an update, say so once and offer the list of changes.
  const seenVersion = loadLocal("seen_version", null);
  if (seenVersion !== APP_VERSION) {
    saveLocal("seen_version", APP_VERSION);
    if (seenVersion) setTimeout(() => toastAction(`Updated to v${APP_VERSION}`, "What’s new", openWhatsNew), 1500);
  }

  setupGlobalEscapeAndBackdrop();
  initPerformanceControls();

  initSongController({
    onSaveSong: saveSong,
    onDeleteSong: deleteSongWithUndo,
    getLibrarySongs: () => songs
  });

  initImportModal({
    onImportReady: (draft) => {
      openSongEditor(draft);
    },
    onImportMany: async (drafts) => {
      const now = new Date().toISOString();
      const added = [];
      for (const draft of drafts) {
        const song = {
          id: crypto.randomUUID ? crypto.randomUUID() : "song-" + Date.now() + "-" + added.length,
          title: draft.title,
          artist: draft.artist || "",
          key: draft.key || "G",
          capo: draft.capo || 0,
          preferred_transpose: 0,
          tempo: draft.tempo || null,
          time_signature: draft.time_signature || null,
          tuning: draft.tuning || "E A D G B E",
          tags: [],
          source: draft.source || null,
          notes: draft.notes || "",
          chordpro: draft.chordpro,
          is_favorite: false,
          vocal_rating: null,
          vocal_comfort: null,
          layout_prefs: { sidebar_notes: {}, ...(draft.layout_prefs || {}) },
          created_at: now,
          updated_at: now
        };
        await saveSong(song);
        added.push(song);
      }
      if (added[0]) openSongView(added[0], { discardPending: true });
    }
  });

  // Search, Clear & Compact Density controls
  document.getElementById("library-search")?.addEventListener("input", (e) => {
    searchQuery = e.target.value || "";
    renderLibrarySidebar();
  });

  document.getElementById("library-search-clear")?.addEventListener("click", () => {
    searchQuery = "";
    const inp = document.getElementById("library-search");
    if (inp) {
      inp.value = "";
      inp.focus();
    }
    renderLibrarySidebar();
  });

  // Device profile awareness (Phone vs Tablet vs Desktop)
  let lastDeviceKind = applyDeviceBodyAttributes().kind;
  window.addEventListener("resize", () => {
    const nextKind = applyDeviceBodyAttributes().kind;
    if (nextKind !== lastDeviceKind) {
      lastDeviceKind = nextKind;
      const cur = getActiveSong();
      if (cur) openSongView(cur);
    }
  });

  document.getElementById("device-override-select")?.addEventListener("change", (e) => {
    const mode = e.target.value || "auto";
    const profile = setDeviceOverride(mode);
    lastDeviceKind = profile.kind;
    const cur = getActiveSong();
    if (cur) openSongView(cur);
    toast(`Switched layout to ${profile.label}`);
  });

  // Mobile Library Drawer Toggle
  document.getElementById("mobile-library-toggle-btn")?.addEventListener("click", (e) => {
    const libPane = document.getElementById("library-pane");
    const btn = e.currentTarget;
    const actionTxt = document.getElementById("mobile-lib-action-text");
    if (!libPane) return;
    const isOpen = libPane.classList.toggle("is-mobile-open");
    btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (actionTxt) actionTxt.textContent = isOpen ? "Close ▴" : "Songs ▾";
    if (isOpen) {
      window.scrollTo(0, 0);
    } else {
      window.dispatchEvent(new Event("resize")); // the sheet was hidden, so re-fit it
    }
  });

  // Desktop Keyboard Shortcuts ('/' to search, '[' / ']' to transpose)
  document.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
    if (!document.getElementById("perform-overlay")?.hidden) return;
    if (document.querySelector(".modal-sheet:not([hidden])")) return;

    if (e.key === "/") {
      e.preventDefault();
      const libPane = document.getElementById("library-pane");
      if (libPane && !libPane.classList.contains("is-mobile-open") && window.innerWidth <= 860) {
        document.getElementById("mobile-library-toggle-btn")?.click();
      }
      document.getElementById("library-search")?.focus();
    } else if (e.key === "[") {
      e.preventDefault();
      document.getElementById("transpose-down-btn")?.click();
    } else if (e.key === "]") {
      e.preventDefault();
      document.getElementById("transpose-up-btn")?.click();
    }
  });

  // Header & Toolbar Buttons
  document.getElementById("open-import-btn")?.addEventListener("click", (e) => {
    openSheet("import-sheet-modal", e.currentTarget);
  });

  document.getElementById("new-blank-song-btn")?.addEventListener("click", () => {
    const opener = document.getElementById("open-import-btn");
    closeSheet("import-sheet-modal");
    openSongEditor({
      title: "",
      artist: "",
      key: "G",
      capo: 0,
      chordpro: `{title: New Song}\n{key: G}\n\n{start_of_verse: Verse 1}\n[G]Write your lyrics with [C]chords in [D]brackets\n{end_of_verse}`
    }, opener);
  });

  document.getElementById("nav-analytics-btn")?.addEventListener("click", (e) => {
    const renderAnalyticsModal = () => {
      const body = document.getElementById("analytics-sheet-body");
      if (!body) return;
      body.innerHTML = renderAnalyticsDashboardHTML(songs);
      body.querySelectorAll("[data-open-song]").forEach((row) => {
        const open = () => {
          const sid = row.getAttribute("data-open-song");
          const s = songs.find((x) => x.id === sid);
          if (s) {
            closeSheet("analytics-modal");
            openSongView(s);
            renderLibrarySidebar();
          }
        };
        row.addEventListener("click", open);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        });
      });
      body.querySelectorAll("[data-rewrite-song]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const s = songs.find((x) => x.id === btn.getAttribute("data-rewrite-song"));
          if (!s) return;
          closeSheet("analytics-modal");
          await rewriteInBetterKey(s);
          renderLibrarySidebar();
        });
      });
      const lowPick = body.querySelector("#vocal-range-low");
      const highPick = body.querySelector("#vocal-range-high");
      const onRangePick = () => {
        const low = parseInt(lowPick.value, 10);
        const high = parseInt(highPick.value, 10);
        if (!lowPick.value || !highPick.value) {
          // "Auto" on either goes back to the range your songs show.
          if (!lowPick.value && !highPick.value) setManualVocalRange(null);
          else {
            // One note picked: fill the other from your songs, or wait for it.
            const auto = getVocalRange(songs);
            if (auto && auto.from === "songs") setManualVocalRange({ low: lowPick.value ? low : auto.low, high: highPick.value ? high : auto.high });
            else return;
          }
        } else if (high <= low) {
          toastError("Pick a highest note above the lowest.");
          return;
        } else {
          setManualVocalRange({ low, high });
        }
        renderAnalyticsModal();
        const active = getActiveSong();
        if (active) openSongView(active);
      };
      lowPick?.addEventListener("change", onRangePick);
      highPick?.addEventListener("change", onRangePick);
      body.querySelector("#find-melody-ranges-btn")?.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = "Looking up…";
        await findMelodyRanges(songsMissingMelody(songs));
        renderAnalyticsModal();
      });
      body.querySelectorAll("[data-toggle-ideal-key]").forEach((chip) => {
        chip.addEventListener("click", () => {
          const key = chip.getAttribute("data-toggle-ideal-key");
          const cur = getPinnedIdealKeys(songs);
          let next;
          if (cur.includes(key)) {
            if (cur.length <= 1) {
              toastError("Keep at least one ideal singing key selected.");
              return;
            }
            next = cur.filter((k) => k !== key);
          } else {
            next = [...cur, key];
          }
          setPinnedIdealKeys(next);
          renderAnalyticsModal();
          const active = getActiveSong();
          if (active) openSongView(active);
        });
      });
    };
    renderAnalyticsModal();
    openSheet("analytics-modal", e.currentTarget);
    // Songs without a melody range get one looked up, once per visit, so they can be checked
    // against your range.
    const missing = songsMissingMelody(songs);
    if (getCloud() && missing.length && !melodyAutoLookupDone) {
      melodyAutoLookupDone = true;
      const btn = document.getElementById("find-melody-ranges-btn");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Looking up melody ranges…";
      }
      findMelodyRanges(missing, { quiet: true }).then((r) => {
        if (!document.getElementById("analytics-modal")?.hidden) renderAnalyticsModal();
        if (r.found) toast(`Found the melody range for ${r.found} song${r.found === 1 ? "" : "s"}.`);
      });
    }
  });

  document.getElementById("nav-setlists-btn")?.addEventListener("click", async (e) => {
    const trigger = e.currentTarget;
    await loadSetlists();
    renderSetlistsSheetHTML(songs, {
      onOpenSong: (sid) => {
        const s = songs.find((x) => x.id === sid);
        if (s) {
          closeSheet("setlists-modal");
          openSongView(s);
          renderLibrarySidebar();
        }
      }
    });
    openSheet("setlists-modal", trigger);
  });

  document.getElementById("nav-guide-btn")?.addEventListener("click", (e) => {
    openSheet("guide-modal", e.currentTarget);
  });

  document.getElementById("nav-account-btn")?.addEventListener("click", (e) => {
    openSheet("account-modal", e.currentTarget);
  });

  // Close buttons on modal sheets
  document.querySelectorAll("[data-close-sheet]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeSheet(btn.getAttribute("data-close-sheet"));
    });
  });

  // Backup JSON Export inside Account sheet
  document.getElementById("export-json-backup-btn")?.addEventListener("click", () => {
    const payload = {
      exported_at: new Date().toISOString(),
      version: APP_VERSION,
      songs
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chord-book-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Backup downloaded");
  });

  // Online / Offline listeners
  window.addEventListener("online", () => {
    flushOfflineQueue();
  });
  window.addEventListener("offline", updateOfflineBanner);
  updateOfflineBanner();

  // Register Service Worker
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Auth setup
  await initAuthAndLoadData();
}

const LAST_USER_KEY = "cb:last_user";
function rememberLastUser(user) {
  try {
    if (user?.id) localStorage.setItem(LAST_USER_KEY, JSON.stringify({ id: user.id, email: user.email || "" }));
  } catch { /* storage off */ }
}
function recallLastUser() {
  try {
    const u = JSON.parse(localStorage.getItem(LAST_USER_KEY) || "null");
    return u?.id ? u : null;
  } catch {
    return null;
  }
}
function forgetLastUser() {
  try { localStorage.removeItem(LAST_USER_KEY); } catch { /* storage off */ }
}
function isLocalDevServer() {
  return ["127.0.0.1", "localhost"].includes(location.hostname);
}

async function initAuthAndLoadData() {
  const sb = getSupabase();
  const authGate = document.getElementById("auth-gate");
  const appShell = document.getElementById("app-shell");
  const accountEmailEl = document.getElementById("account-user-email");

  const signInOutBtn = document.getElementById("account-signout-btn");
  const moveLocalBtn = document.getElementById("account-move-local-btn");

  // Songs added while signed out on this device, not yet in this account.
  const localOnlySongs = () => {
    let local = [];
    try {
      local = JSON.parse(localStorage.getItem("cb:local:songs") || "[]");
    } catch {
      local = [];
    }
    const inAccount = new Set(songs.map((s) => (s.title || "").trim().toLowerCase()));
    return local.filter((s) => !String(s.id).startsWith("seed-") && !inAccount.has((s.title || "").trim().toLowerCase()));
  };

  const refreshMoveLocalBtn = () => {
    if (!moveLocalBtn) return;
    const count = getCloud() ? localOnlySongs().length : 0;
    moveLocalBtn.hidden = count === 0;
    moveLocalBtn.textContent = `Add ${count} song${count === 1 ? "" : "s"} from this device`;
  };

  moveLocalBtn?.addEventListener("click", async () => {
    const cloud = getCloud();
    if (!cloud) return;
    let added = 0;
    for (const song of localOnlySongs()) {
      const { user_id: _owner, ...fields } = song;
      const row = { ...fields, id: crypto.randomUUID() };
      const { error } = await cloud.from("cb_songs").insert(row);
      if (error) {
        console.error("Couldn't copy song:", error);
        toastError(`Couldn’t add "${song.title}".`);
        break;
      }
      songs.push(row);
      added += 1;
    }
    saveLocal("songs", songs);
    renderLibrarySidebar();
    refreshMoveLocalBtn();
    if (added) toast(`Added ${added} song${added === 1 ? "" : "s"} to your account`);
  });

  const enterAppAs = async (user) => {
    setCurrentUserId(user?.id || "local");
    const signedIn = !!getCloud();
    document.body.classList.toggle("no-cloud", !signedIn);
    if (signInOutBtn) signInOutBtn.textContent = signedIn ? "Sign out" : "Sign in";
    if (accountEmailEl) {
      accountEmailEl.textContent = signedIn && user?.email ? user.email : "Saved on this device";
    }
    if (authGate) authGate.hidden = true;
    if (appShell) appShell.hidden = false;

    await loadSongs();
    await loadSetlists();
    renderLibrarySidebar();
    if (songs.length > 0) {
      // Come back to the song you were on, even if the phone reloaded the app.
      const lastSongId = loadLocal("last_song_id", null);
      openSongView(songs.find((s) => s.id === lastSongId) || songs[0], { discardPending: true });
      renderLibrarySidebar();
    } else {
      showEmptySongStage({ failed: songsLoadFailed });
    }
    refreshMoveLocalBtn();
    if (signedIn) flushOfflineQueue();
  };

  // Sign-in form handler
  const signInForm = document.getElementById("auth-signin-form");
  if (signInForm) {
    signInForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!sb) {
        const noCloudErr = document.getElementById("auth-error-msg");
        if (noCloudErr) {
          noCloudErr.textContent = "Sign-in isn’t available right now. Try again in a moment.";
          noCloudErr.hidden = false;
        }
        return;
      }
      const email = document.getElementById("auth-email")?.value?.trim() || "";
      const password = document.getElementById("auth-password")?.value || "";
      const errEl = document.getElementById("auth-error-msg");
      if (errEl) errEl.hidden = true;

      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        if (errEl) {
          errEl.textContent = error.message || "Sign-in failed.";
          errEl.hidden = false;
        }
        return;
      }
      rememberLastUser(data?.user);
      await enterAppAs(data?.user);
    });
  }

  // Sign Out button in Account modal
  document.getElementById("account-signout-btn")?.addEventListener("click", async () => {
    if (sb) {
      try { await sb.auth.signOut(); } catch { /* ignore */ }
    }
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "WIPE_USER_CACHE" });
    }
    closeSheet("account-modal");
    forgetLastUser();
    setCurrentUserId("local");
    document.body.classList.add("no-cloud");
    if (authGate) authGate.hidden = false;
    if (appShell) appShell.hidden = true;
  });

  // Check existing Supabase session
  let sessionUnreachable = !navigator.onLine;
  if (sb) {
    try {
      const { data, error } = await sb.auth.getSession();
      if (data?.session?.user) {
        rememberLastUser(data.session.user);
        await enterAppAs(data.session.user);
        return;
      }
      // An expired session can't be renewed without a connection.
      if (error && /fetch|network|retryable/i.test(`${error.name} ${error.message}`)) sessionUnreachable = true;
    } catch {
      sessionUnreachable = true;
    }
  }

  // Only House Index members use the Chord Book. With no connection (a gig with no signal), the
  // person last signed in on this device still gets their saved songs; signing out ends that.
  const lastUser = recallLastUser();
  if ((sessionUnreachable || !sb) && lastUser) {
    await enterAppAs(lastUser);
    return;
  }
  setCurrentUserId("local");
  // The test suites run a device-only book on this computer; the live site never offers one.
  if (isLocalDevServer() && loadLocal("use_local_book", false)) {
    await enterAppAs({ id: "local" });
    return;
  }
  document.body.classList.add("no-cloud");
  if (appShell) appShell.hidden = true;
  if (authGate) authGate.hidden = false;
}

document.addEventListener("DOMContentLoaded", bootApp);
