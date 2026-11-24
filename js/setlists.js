// Set Lists manager (js/setlists.js)
// Create, reorder, and perform set lists with per-gig key/transpose/capo overrides
// and offline caching toggle.

import {
  esc,
  getCloud,
  loadLocal,
  saveLocal,
  toast,
  toastAction,
  toastError
} from "./core.js";
import { openPerformanceMode } from "./perform.js";
import { transposeKey } from "./chords.js";
import { downloadSetlistHTML, printSetlistToPDF } from "./send.js";

let setlists = [];
let setlistItems = []; // [{ id, setlist_id, song_id, position, transpose, capo, notes }]
let activeSetlistId = null;

export function getSetlists() {
  return setlists;
}

export function getSetlistItems(setlistId = null) {
  if (!setlistId) return setlistItems;
  return setlistItems
    .filter((it) => it.setlist_id === setlistId)
    .sort((a, b) => a.position - b.position);
}

function reportSync(result) {
  if (result?.error) {
    console.error("Set list sync failed:", result.error);
    toastError("Couldn’t save that set list change to the cloud.");
  }
}

export async function loadSetlists() {
  const sb = getCloud();
  const cachedLists = loadLocal("setlists", []);
  const cachedItems = loadLocal("setlist_items", null);
  setlists = cachedLists;

  // Saved items are the user's: never re-merge the starter set over them.
  if (Array.isArray(cachedItems)) {
    setlistItems = cachedItems;
  } else {
    setlistItems = [];
  }

  if (!sb) return { setlists, setlistItems };

  try {
    const [listsRes, itemsRes] = await Promise.all([
      sb.from("cb_setlists").select("*").order("created_at", { ascending: false }),
      sb.from("cb_setlist_items").select("*").order("position", { ascending: true })
    ]);
    // Only replace the cached copy when both reads succeed, so a bad connection can't blank a set.
    if (!listsRes.error && !itemsRes.error) {
      setlists = listsRes.data || [];
      setlistItems = itemsRes.data || [];
      saveLocal("setlists", setlists);
      saveLocal("setlist_items", setlistItems);
    }
  } catch {
    // Offline fallback uses local cache
  }

  if (!setlists.some((x) => x.id === activeSetlistId)) {
    activeSetlistId = setlists[0]?.id || null;
  }
  return { setlists, setlistItems };
}

export async function createSetlist({ name, event_date = null, notes = "", offline = true }) {
  const newList = {
    id: crypto.randomUUID ? crypto.randomUUID() : "sl-" + Date.now(),
    name: name.trim(),
    event_date: event_date || null,
    notes: notes.trim(),
    offline: !!offline,
    created_at: new Date().toISOString()
  };
  setlists.unshift(newList);
  activeSetlistId = newList.id;
  saveLocal("setlists", setlists);

  const sb = getCloud();
  if (sb) {
    try {
      reportSync(await sb.from("cb_setlists").insert(newList));
    } catch (error) {
      reportSync({ error });
    }
  }
  toast(`Created set list "${newList.name}"`);
  return newList;
}

export async function addSongToSetlist(setlistId, song) {
  const items = getSetlistItems(setlistId);
  const nextPos = items.length ? Math.max(...items.map((i) => i.position)) + 1 : 1;
  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : "sli-" + Date.now(),
    setlist_id: setlistId,
    song_id: song.id,
    position: nextPos,
    transpose: song.preferred_transpose || 0,
    capo: song.capo || 0,
    notes: ""
  };
  setlistItems.push(entry);
  saveLocal("setlist_items", setlistItems);

  const sb = getCloud();
  if (sb) {
    try {
      reportSync(await sb.from("cb_setlist_items").insert(entry));
    } catch (error) {
      reportSync({ error });
    }
  }
  toast(`Added "${song.title}" to set list`);
  return entry;
}

export async function removeSetlistItem(itemId, onRender) {
  const idx = setlistItems.findIndex((i) => i.id === itemId);
  if (idx === -1) return;
  const [removed] = setlistItems.splice(idx, 1);
  saveLocal("setlist_items", setlistItems);

  const sb = getCloud();
  if (sb) {
    try {
      reportSync(await sb.from("cb_setlist_items").delete().eq("id", itemId));
    } catch (error) {
      reportSync({ error });
    }
  }
  if (onRender) onRender();

  toastAction("Removed song from set list", "Undo", async () => {
    setlistItems.splice(idx, 0, removed);
    saveLocal("setlist_items", setlistItems);
    if (sb) {
      try {
        reportSync(await sb.from("cb_setlist_items").insert(removed));
      } catch (error) {
        reportSync({ error });
      }
    }
    if (onRender) onRender();
  });
}

// Positions are unique per set, so the swap passes through a temporary slot.
async function syncSwappedPositions(first, second) {
  const sb = getCloud();
  if (!sb) return;
  try {
    for (const [id, position] of [[first.id, -1 - first.position], [second.id, second.position], [first.id, first.position]]) {
      const result = await sb.from("cb_setlist_items").update({ position }).eq("id", id);
      if (result.error) {
        reportSync(result);
        return;
      }
    }
  } catch (error) {
    reportSync({ error });
  }
}

export function renderSetlistsSheetHTML(allSongs = [], { onOpenSong, onRefresh }) {
  const container = document.getElementById("setlists-sheet-body");
  if (!container) return;

  if (!activeSetlistId && setlists.length) {
    activeSetlistId = setlists[0].id;
  }
  const currentList = setlists.find((s) => s.id === activeSetlistId) || setlists[0] || null;
  const songsById = new Map(allSongs.map((s) => [s.id, s]));
  // Entries for a deleted song are kept so its Undo can restore them, but they don't count or show.
  const items = currentList ? getSetlistItems(currentList.id).filter((it) => songsById.has(it.song_id)) : [];

  container.innerHTML = `
    <div class="setlists-layout">
      <div class="setlists-toolbar">
        <select id="setlist-picker" class="input-select" aria-label="Choose set list" ${setlists.length ? "" : "hidden"}>
          ${setlists.map((sl) => `<option value="${esc(sl.id)}" ${sl.id === currentList?.id ? "selected" : ""}>${esc(sl.name)}</option>`).join("")}
        </select>
        ${currentList && items.length ? `<button type="button" class="solid-btn" id="perform-setlist-btn">▶ Play set</button>` : ""}
        <button type="button" class="ghost-btn" id="new-setlist-toggle-btn">+ New</button>
        ${currentList && items.length ? `<button type="button" class="ghost-btn" id="toggle-setlist-export-btn" aria-expanded="false">Print or send</button>` : ""}
      </div>

      ${currentList && items.length ? `
      <div id="setlist-export-panel" class="inline-card-form setlist-export-panel" hidden>
        <div class="export-panel-head">
          <strong>Print or send this set</strong>
          <span class="export-page-summary" id="setlist-export-page-summary">${items.length} song${items.length === 1 ? "" : "s"}</span>
        </div>
        <div class="export-options-grid">
          <div>
            <label class="field-label" for="export-pages-per-song">Pages per song</label>
            <select id="export-pages-per-song" class="input-select">
              <option value="1-sheet" selected>1 page when it fits</option>
              <option value="2-sheet">2 pages</option>
              <option value="saved">Each song’s saved layout</option>
            </select>
          </div>
          <div class="export-checkboxes-row">
            <label class="checkbox-pill">
              <input type="checkbox" id="export-include-diagrams" />
              <span>Chord Diagrams</span>
            </label>
            <label class="checkbox-pill">
              <input type="checkbox" id="export-include-notes" checked />
              <span>Notes</span>
            </label>
            <label class="checkbox-pill">
              <input type="checkbox" id="export-compact-chorus" />
              <span>Hide repeated choruses</span>
            </label>
            <label class="checkbox-pill">
              <input type="checkbox" id="export-include-cover" />
              <span>Cover page</span>
            </label>
          </div>
        </div>
        <div class="sheet-panel-actions">
          <button type="button" class="solid-btn" id="print-setlist-pdf-btn">Print / Save PDF</button>
          <button type="button" class="ghost-btn" id="export-setlist-html-btn">Download as a page</button>
        </div>
      </div>
      ` : ""}

      <form id="new-setlist-form" class="inline-card-form" hidden>
        <div class="form-row">
          <input type="text" id="new-setlist-name" class="input-text" placeholder="Set list name" aria-label="Set list name" required />
          <button type="submit" class="solid-btn">Create</button>
        </div>
      </form>

      ${currentList ? `
        <div class="setlist-items-box">
          ${items.length === 0 ? `<p class="empty-hint">No songs here yet. Add one below.</p>` : ""}
          <ol class="setlist-ordered-list">
            ${items.map((it, idx) => {
              const song = songsById.get(it.song_id);
              const shownKey = transposeKey(song.key || "G", song.preferred_transpose || 0, "auto");
              return `
                <li class="setlist-item-row" data-item-id="${esc(it.id)}">
                  <span class="setlist-pos-num">${idx + 1}</span>
                  <button type="button" class="setlist-song-info" data-open-set-song="${esc(song.id)}">
                    <strong>${esc(song.title)}</strong>
                    <span class="setlist-song-meta">Key of ${esc(shownKey)}${song.capo ? ` · Capo ${esc(song.capo)}` : ""}</span>
                  </button>
                  <div class="setlist-item-actions">
                    <button type="button" class="ghost-btn small-btn" data-move-up="${esc(it.id)}" ${idx === 0 ? "disabled" : ""} aria-label="Move ${esc(song.title)} up">↑</button>
                    <button type="button" class="ghost-btn small-btn" data-move-down="${esc(it.id)}" ${idx === items.length - 1 ? "disabled" : ""} aria-label="Move ${esc(song.title)} down">↓</button>
                    <button type="button" class="ghost-btn small-btn" data-remove-item="${esc(it.id)}" aria-label="Remove ${esc(song.title)} from set">×</button>
                  </div>
                </li>
              `;
            }).join("")}
          </ol>

          <div class="setlist-add-song-row">
            <select id="setlist-add-song-select" class="input-select" aria-label="Add song to set list">
              <option value="">+ Add a song…</option>
              ${allSongs.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join("")}
            </select>
          </div>
        </div>
      ` : ""}
    </div>
  `;

  // Event listeners
  container.querySelector("#setlist-picker")?.addEventListener("change", (e) => {
    activeSetlistId = e.target.value;
    renderSetlistsSheetHTML(allSongs, { onOpenSong, onRefresh });
  });

  const newBtn = container.querySelector("#new-setlist-toggle-btn");
  const newForm = container.querySelector("#new-setlist-form");
  if (newBtn && newForm) {
    newBtn.addEventListener("click", () => {
      newForm.hidden = !newForm.hidden;
      if (!newForm.hidden) container.querySelector("#new-setlist-name")?.focus();
    });
    newForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = container.querySelector("#new-setlist-name")?.value || "";
      if (!name.trim()) return;
      await createSetlist({ name });
      renderSetlistsSheetHTML(allSongs, { onOpenSong, onRefresh });
    });
  }

  container.querySelector("#setlist-add-song-select")?.addEventListener("change", async (e) => {
    const song = songsById.get(e.target.value);
    if (!song || !currentList) return;
    await addSongToSetlist(currentList.id, song);
    renderSetlistsSheetHTML(allSongs, { onOpenSong, onRefresh });
  });

  container.querySelector("#perform-setlist-btn")?.addEventListener("click", () => {
    const orderedSongs = items.map((it) => songsById.get(it.song_id)).filter(Boolean);
    if (orderedSongs.length) {
      openPerformanceMode(orderedSongs, 0);
    }
  });

  const readExportOptions = () => ({
    pagesPerSong: container.querySelector("#export-pages-per-song")?.value || "1-sheet",
    includeDiagrams: container.querySelector("#export-include-diagrams") ? !!container.querySelector("#export-include-diagrams").checked : false,
    includeNotes: container.querySelector("#export-include-notes") ? !!container.querySelector("#export-include-notes").checked : true,
    compactChorus: container.querySelector("#export-compact-chorus") ? !!container.querySelector("#export-compact-chorus").checked : false,
    includeIndexCover: container.querySelector("#export-include-cover") ? !!container.querySelector("#export-include-cover").checked : false
  });

  const updateExportSummary = () => {
    const opts = readExportOptions();
    const summaryEl = container.querySelector("#setlist-export-page-summary");
    const pdfBtn = container.querySelector("#print-setlist-pdf-btn");
    if (!summaryEl) return;
    summaryEl.textContent = `${items.length} song${items.length === 1 ? "" : "s"}${opts.includeIndexCover ? " + cover" : ""}`;
    if (pdfBtn) {
      pdfBtn.textContent = "Print / Save PDF";
    }
  };

  container.querySelectorAll("#export-pages-per-song, #export-include-cover").forEach((el) => {
    el.addEventListener("change", updateExportSummary);
  });

  container.querySelector("#toggle-setlist-export-btn")?.addEventListener("click", (e) => {
    const panel = container.querySelector("#setlist-export-panel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
  });

  container.querySelector("#print-setlist-pdf-btn")?.addEventListener("click", () => {
    const itemsWithSongs = items.map((item) => ({ item, song: songsById.get(item.song_id) })).filter((x) => x.song);
    if (itemsWithSongs.length && currentList) {
      printSetlistToPDF(currentList, itemsWithSongs, readExportOptions());
    }
  });

  container.querySelector("#export-setlist-html-btn")?.addEventListener("click", () => {
    const itemsWithSongs = items.map((item) => ({ item, song: songsById.get(item.song_id) })).filter((x) => x.song);
    if (itemsWithSongs.length && currentList) {
      downloadSetlistHTML(currentList, itemsWithSongs, readExportOptions());
    }
  });

  container.querySelectorAll("[data-open-set-song]").forEach((el) => {
    el.addEventListener("click", () => {
      const sid = el.getAttribute("data-open-set-song");
      if (sid && onOpenSong) onOpenSong(sid);
    });
  });

  container.querySelectorAll("[data-remove-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeSetlistItem(btn.getAttribute("data-remove-item"), () => {
        renderSetlistsSheetHTML(allSongs, { onOpenSong, onRefresh });
      });
    });
  });

  container.querySelectorAll("[data-move-up], [data-move-down]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-move-up") || btn.getAttribute("data-move-down");
      const dir = btn.hasAttribute("data-move-up") ? -1 : 1;
      const list = getSetlistItems(currentList.id).filter((x) => songsById.has(x.song_id));
      const idx = list.findIndex((x) => x.id === id);
      const swapIdx = idx + dir;
      if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return;
      const tmp = list[idx].position;
      list[idx].position = list[swapIdx].position;
      list[swapIdx].position = tmp;
      saveLocal("setlist_items", setlistItems);
      syncSwappedPositions(list[idx], list[swapIdx]);
      renderSetlistsSheetHTML(allSongs, { onOpenSong, onRefresh });
    });
  });
}
