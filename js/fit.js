// Deterministic 8.5x11 Sheet Packing & Auto-Fit Engine (1-Sheet, 2-Sheet, and Scroll modes).
// Measures real DOM box heights inside a virtual 8.5x11" Letter canvas (816x1056 px at 96dpi)
// and binary-searches font size, line gap, section gap, and column count so 100% of the song
// fits onto the requested 1 or 2 sheets without clipping or overflow.

import { esc } from "./core.js";
import { soundingKeyWithTuning, getTuning } from "./chords.js";
import { chorusWording } from "./chordpro.js";
import { renderSongBodyHTML, renderChordDiagramSVG } from "./render.js";

// Standard US Letter at 96 CSS px/inch: 8.5in = 816px, 11in = 1056px.
export const LETTER_WIDTH_PX = 816;
export const LETTER_HEIGHT_PX = 1056;

/**
 * Render the song into `containerEl` in the requested pageMode:
 * - "1-sheet": Fits entire song + header + optional diagrams + sidebar notes onto ONE 8.5x11 sheet
 * - "2-sheet": Splits sections across TWO 8.5x11 sheets and fits both at a matching readable scale
 * - "scroll": Fluid responsive layout for narrow phone screens
 */
export function renderAndFitSong(containerEl, songRow, viewOpts = {}) {
  if (!containerEl || !songRow) return null;

  const prefs = songRow.layout_prefs || {};
  const pageMode = viewOpts.pageMode || prefs.page_mode || "1-sheet";
  const columnsPref = viewOpts.columns || prefs.columns || "auto";
  const showDiagrams = viewOpts.showDiagrams ?? (prefs.show_diagrams === true);
  const fontOffset = Number(viewOpts.fontOffset ?? prefs.font_offset ?? 0);
  const leftHanded = !!viewOpts.leftHanded;

  const bodyModel = renderSongBodyHTML(songRow, viewOpts);
  const { parsed, targetKey, distinctChords, sectionsToRender, renderSection } = bodyModel;

  const capo = Number(viewOpts.capo ?? songRow.capo ?? parsed.meta.capo ?? 0);
  const tuning = getTuning(songRow.tuning || parsed.meta.tuning);
  const showSounding = capo > 0 || tuning.offset !== 0;
  const soundingKey = showSounding ? soundingKeyWithTuning(targetKey, capo, tuning.value) : targetKey;
  const headerNote = chorusWording(songRow.notes || parsed.meta.note || "");

  const diagramsHtml = showDiagrams && distinctChords.length > 0 && viewOpts.displayStyle !== "lyrics_only"
    ? `
      <div class="sheet-diagrams-strip" aria-label="Chord diagrams">
        ${distinctChords
          .map((ch) => renderChordDiagramSVG(ch, { customDefines: parsed.meta.defines, leftHanded }))
          .join("")}
      </div>
    `
    : "";

  const buildSheetHeaderHTML = (pageNum = 1, totalPages = 1) => `
    <header class="sheet-header">
      <div class="sheet-title-block">
        <div class="sheet-title-row">
          <h2 class="sheet-title">${esc(songRow.title || parsed.meta.title || "Untitled Song")}</h2>
          ${totalPages > 1 ? `<span class="sheet-page-badge">Page ${pageNum} of ${totalPages}</span>` : ""}
        </div>
        ${(songRow.artist || parsed.meta.artist) ? `<p class="sheet-artist">${esc(songRow.artist || parsed.meta.artist)}</p>` : ""}
        ${headerNote && pageNum === 1 ? `<p class="sheet-header-note">${esc(headerNote)}</p>` : ""}
      </div>
      <div class="sheet-meta-pills">
        <div class="meta-pill is-primary">
          <span class="meta-pill-label">Key</span>
          <strong class="meta-pill-val">${esc(targetKey)}</strong>
        </div>
        ${capo > 0 ? `
          <div class="meta-pill is-accent">
            <span class="meta-pill-label">Capo</span>
            <strong class="meta-pill-val">Fret ${capo}</strong>
          </div>
        ` : ""}
        ${tuning.id === "standard" ? "" : `
          <div class="meta-pill is-accent">
            <span class="meta-pill-label">Tuning</span>
            <strong class="meta-pill-val">${esc(tuning.display)}</strong>
          </div>
        `}
        ${showSounding ? `
          <div class="meta-pill">
            <span class="meta-pill-label">Sounds in</span>
            <strong class="meta-pill-val">${esc(soundingKey)}</strong>
          </div>
        ` : ""}
        ${(songRow.tempo || parsed.meta.tempo) ? `
          <div class="meta-pill">
            <span class="meta-pill-label">Tempo</span>
            <strong class="meta-pill-val">${esc(songRow.tempo || parsed.meta.tempo)} BPM</strong>
          </div>
        ` : ""}
      </div>
    </header>
  `;

  // Mode 1: Continuous responsive scroll (phone reading)
  if (pageMode === "scroll") {
    containerEl.className = "song-stage mode-scroll";
    containerEl.style.removeProperty("--sheet-scale");
    const baseFontPt = Math.max(10, Math.min(20, 14 + fontOffset));
    containerEl.innerHTML = `
      <article class="scroll-sheet" style="--sheet-font-size: ${baseFontPt}pt;">
        ${buildSheetHeaderHTML(1, 1)}
        ${diagramsHtml}
        <div class="sheet-sections-flow">
          ${sectionsToRender.map(renderSection).join("")}
        </div>
      </article>
    `;
    return { pageMode: "scroll", pages: 1, fontPt: baseFontPt, columns: 1 };
  }

  // Mode 2: Letter pages. A long song continues onto another page instead of being squeezed.
  const minPages = pageMode === "2-sheet" ? 2 : 1;
  // Tab is learned, not sung from, so a tab-heavy song may run longer.
  const hasTab = sectionsToRender.some((item) => (item.sec.lines || []).some((l) => l.tab !== undefined));
  const maxPages = Math.max(minPages, Math.min(hasTab ? MAX_TAB_SHEET_PAGES : MAX_SHEET_PAGES, sectionsToRender.length));
  containerEl.className = `song-stage mode-sheet mode-${minPages}-sheet`;

  let pageBuckets = [];
  let fitResult = null;
  const tryLayout = (buckets) => {
    pageBuckets = buckets;
    containerEl.innerHTML = `
      <div class="sheets-deck" id="sheets-deck">
        ${pageBuckets.map((bucket, pIdx) => `
          <div class="sheet-scaler">
            <article class="sheet-page" data-page-index="${pIdx + 1}">
              ${buildSheetHeaderHTML(pIdx + 1, pageBuckets.length)}
              ${pIdx === 0 ? diagramsHtml : ""}
              <div class="sheet-sections-flow">
                ${bucket.map(renderSection).join("")}
              </div>
            </article>
          </div>
        `).join("")}
      </div>
    `;
    fitResult = autoFitLetterPages(Array.from(containerEl.querySelectorAll(".sheet-page")), {
      columnsPref,
      fontOffset,
      canCollapse: !viewOpts.alignMode,
      // Redraw once after web fonts load; a song that still can't fit must not redraw forever.
      onOverflow: viewOpts.refitAfterFonts ? null : () => renderAndFitSong(containerEl, songRow, { ...viewOpts, refitAfterFonts: true })
    });
    return fitResult.fits;
  };
  // Before adding a page, try other page breaks: counting by lines can overload one page (a
  // repeated chorus counts in full but may print as "Repeat Chorus").
  outer: for (let count = minPages; count <= maxPages; count++) {
    for (const buckets of pageBreakOptions(sectionsToRender, count)) {
      if (tryLayout(buckets)) break outer;
    }
  }

  scaleLetterPagesToViewport(containerEl);
  return {
    pageMode,
    pages: pageBuckets.length,
    ...fitResult
  };
}

/** The balanced split first, then for two pages every other break, closest to balanced first. */
function pageBreakOptions(sections, count) {
  const first = splitSectionsIntoPages(sections, count);
  if (count !== 2 || sections.length < 3) return [first];
  const firstBreak = first[0].length;
  const others = [];
  for (let b = 1; b < sections.length; b++) {
    if (b !== firstBreak) others.push(b);
  }
  others.sort((a, c) => Math.abs(a - firstBreak) - Math.abs(c - firstBreak));
  return [first, ...others.slice(0, 4).map((b) => [sections.slice(0, b), sections.slice(b)])];
}

/** Divides whole sections across pages by approximate length. */
function splitSectionsIntoPages(sections, count) {
  const pageCount = Math.min(count, Math.max(1, sections.length));
  if (pageCount <= 1) return [sections];
  // A tab block is one "line" holding many rows; count its rows so pages split evenly.
  const rows = (sec) => (sec.lines || []).reduce((n, l) => n + (l.tab !== undefined ? String(l.tab).split("\n").length : 1), 0);
  const weights = sections.map((s) => Math.max(2, rows(s.sec)) + 1 + (s.sec.sidebarNote ? 1 : 0));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const pages = [];
  let start = 0;
  let running = 0;
  for (let page = 1; page < pageCount; page++) {
    const target = (total * page) / pageCount;
    let end = start + 1;
    running += weights[start];
    while (end < sections.length - (pageCount - page) + 1 && running + weights[end] / 2 < target) {
      running += weights[end];
      end++;
    }
    pages.push(sections.slice(start, end));
    start = end;
  }
  pages.push(sections.slice(start));
  return pages;
}

let fitGeneration = 0;

// Every sheet starts here. Extra room stays as white space; text never grows to fill it.
export const STANDARD_SHEET_PT = 11;
// Read while playing and singing: text stops here, then the song continues on another page.
export const MIN_SHEET_PT = 10.5;
export const MAX_SHEET_PAGES = 4;
export const MAX_TAB_SHEET_PAGES = 8;

/**
 * Finds the first layout that fits, in order of least change to how the sheet reads:
 * standard size -> two columns -> snugger spacing -> repeated choruses once -> wrapped lines -> slightly smaller text.
 * If none of that fits, it reports so and the song gets another page.
 * Also embedded in downloaded packets, so it must not reference anything outside itself.
 */
export function fitLadder({ targetPt, minPt, columnChoices, setType, setLayout, fits, collapseRepeats }) {
  const spacings = [
    { line: 1.22, row: 7, section: 18 },
    { line: 1.16, row: 5, section: 13 }
  ];
  const tryAt = (pt, wrapChoices) => {
    for (const spacing of spacings) {
      for (const wrap of wrapChoices) {
        for (const cols of columnChoices) {
          setType(pt, spacing);
          setLayout(cols, wrap);
          if (fits()) return { pt, cols, wrap, fits: true };
        }
      }
    }
    return null;
  };

  let found = tryAt(targetPt, [false]);
  if (!found && collapseRepeats && collapseRepeats()) found = tryAt(targetPt, [false]);
  if (!found) found = tryAt(targetPt, [true]);
  for (let pt = targetPt - 0.25; !found && pt >= minPt - 0.001; pt -= 0.25) {
    found = tryAt(pt, [false, true]);
  }
  if (found) return found;

  const lastCols = columnChoices[columnChoices.length - 1];
  setType(minPt, spacings[1]);
  setLayout(lastCols, true);
  return { pt: minPt, cols: lastCols, wrap: true, fits: false };
}

/**
 * Sizes tab so the widest tab block fills the page width, between 7.5pt and 10pt (a little under
 * the 11pt lyrics, so it never dominates the sheet). Every tab block in the song gets that one size, so the sheet stays consistent.
 */
export function fitTabsToWidth(pages) {
  const blocks = pages.flatMap((p) => Array.from(p.querySelectorAll(".tab-block")));
  if (!blocks.length) return;
  let best = Infinity;
  for (const pre of blocks) {
    pre.style.fontSize = "";
    const page = pre.closest(".sheet-page");
    const scale = page ? page.getBoundingClientRect().width / page.offsetWidth || 1 : 1;
    const style = getComputedStyle(pre);
    const available = pre.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const used = (pre.querySelector("code") || pre).getBoundingClientRect().width / scale;
    if (available > 0 && used > 0) best = Math.min(best, parseFloat(style.fontSize) * (available / used) * 0.98);
  }
  if (!Number.isFinite(best)) return;
  const px = `${Math.max(7.5 * 4 / 3, Math.min(10 * 4 / 3, best)).toFixed(2)}px`;
  for (const pre of blocks) pre.style.fontSize = px;
}

/**
 * In two columns, the section that ends a column gets no gap below it, so the gap never counts
 * against the page and Safari can't carry it to the top of the next column.
 */
export function markColumnEnds(page) {
  const sections = Array.from(page.querySelectorAll(".sheet-sections-flow > .song-section"));
  if (!page.classList.contains("is-two-col")) {
    for (const s of sections) s.classList.remove("is-column-end");
    return;
  }
  // Twice, because dropping a gap can move a section to the other column.
  for (let pass = 0; pass < 2; pass++) {
    sections.forEach((s, i) => {
      const next = sections[i + 1];
      const ends = !next || next.getBoundingClientRect().left - s.getBoundingClientRect().left > 4;
      s.classList.toggle("is-column-end", ends);
    });
  }
}

/**
 * When a song won't fit, prints an exact repeat of any part once: "Repeat Chorus",
 * "Repeat Pre-Chorus", "Repeat Instrumental". A part that changes (a chorus in a new key, new
 * words) is not a repeat. Tab is left alone. Also embedded in downloaded packets, so it must not
 * reference anything outside itself.
 */
export function collapseRepeatedChoruses(pages) {
  const seen = new Set();
  let changed = false;
  for (const page of pages) {
    for (const section of page.querySelectorAll(".song-section:not(.type-tab)")) {
      const lines = section.querySelector(".section-lines");
      const rows = lines ? Array.from(lines.querySelectorAll(".lyric-line")) : [];
      if (!rows.length) continue;
      const label = (section.querySelector(".section-label")?.textContent || "").replace(/\s*\(\d+x\)\s*$/i, "").trim();
      const kind = section.classList.contains("is-chorus") ? "Chorus" : label.replace(/\s*\d+$/, "");
      const signature = kind + "\n" + rows.map((row) => row.textContent).join("\n");
      if (seen.has(signature)) {
        const reminder = page.ownerDocument.createElement("div");
        reminder.className = "song-comment";
        reminder.textContent = "Repeat " + kind;
        lines.replaceChildren(reminder);
        changed = true;
      } else {
        seen.add(signature);
      }
    }
  }
  return changed;
}

/**
 * Fits every `.sheet-page` at the standard text size, using the steps in fitLadder only when needed.
 */
export function autoFitLetterPages(pageEls, { columnsPref = "auto", fontOffset = 0, canCollapse = true, onOverflow = null } = {}) {
  if (!pageEls || !pageEls.length) return { fontPt: STANDARD_SHEET_PT, columns: 1, fits: true };
  const myGen = ++fitGeneration;

  const setType = (pt, spacing) => {
    for (const p of pageEls) {
      p.style.setProperty("--sheet-font-size", `${pt.toFixed(2)}pt`);
      p.style.setProperty("--sheet-line-gap", String(spacing.line));
      p.style.setProperty("--sheet-row-gap", `${spacing.row}px`);
      p.style.setProperty("--sheet-section-gap", `${spacing.section}px`);
      p.style.setProperty("--sheet-diag-scale", "1");
    }
  };

  const setLayout = (cols, wrap) => {
    for (const p of pageEls) {
      p.style.setProperty("--sheet-cols", String(cols));
      p.classList.toggle("is-two-col", cols === 2);
      p.classList.toggle("is-wrap-lines", wrap);
    }
  };

  const checkPagesFit = () => {
    fitTabsToWidth(pageEls);
    for (const p of pageEls) {
      markColumnEnds(p);
      if (p.scrollHeight > p.clientHeight + 1) return false;
      const flow = p.querySelector(".sheet-sections-flow");
      if (flow) {
        if (flow.scrollHeight > flow.clientHeight + 1) return false;
        if (flow.scrollWidth > flow.clientWidth + 2) return false;
        for (const ln of flow.querySelectorAll(".lyric-line")) {
          if (ln.scrollWidth > ln.clientWidth + 2) return false;
          const lastPair = ln.lastElementChild;
          if (lastPair && lastPair.getBoundingClientRect().right > ln.getBoundingClientRect().right + 2) {
            return false;
          }
        }
      }
    }
    return true;
  };

  const columnChoices = columnsPref === 1 || columnsPref === "1"
    ? [1]
    : (columnsPref === 2 || columnsPref === "2" ? [2] : [1, 2]);
  // A− / A+ on a song moves it off the standard on purpose.
  const targetPt = Math.max(8, Math.min(14, STANDARD_SHEET_PT + fontOffset * 0.5));
  const runFit = () => {
    const result = fitLadder({
      targetPt,
      minPt: Math.min(MIN_SHEET_PT, targetPt),
      columnChoices,
      setType,
      setLayout,
      fits: checkPagesFit,
      collapseRepeats: canCollapse ? () => collapseRepeatedChoruses(pageEls) : null
    });
    for (const p of pageEls) p.classList.toggle("is-ultra-compact", !result.fits);
    return result;
  };

  const result = runFit();

  // Web fonts can change line widths after the first measure.
  if (typeof document !== "undefined" && document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (myGen !== fitGeneration || !pageEls[0]?.isConnected) return;
      if (!checkPagesFit() && !runFit().fits && onOverflow) onOverflow();
    }).catch(() => {});
  }

  return {
    fontPt: Number(result.pt.toFixed(2)),
    columns: result.cols,
    fits: result.fits
  };
}

/**
 * Scale the fixed 816x1056px `.sheet-page` on screen so it fits any phone, tablet, or desktop viewport width
 * without horizontal scrolling, while keeping its exact 8.5x11" geometry internally.
 */
export function scaleLetterPagesToViewport(containerEl) {
  if (!containerEl) return;
  const scalers = Array.from(containerEl.querySelectorAll(".sheet-scaler"));
  if (!scalers.length) return;

  // Measure inside the padding so the page is never clipped by its scroll pane.
  const stageStyle = getComputedStyle(containerEl);
  const paddingX = parseFloat(stageStyle.paddingLeft) + parseFloat(stageStyle.paddingRight);
  if (!containerEl.clientWidth) return; // hidden behind the phone song list
  const availWidth = Math.max(300, containerEl.clientWidth - paddingX);
  const scale = Math.min(1, availWidth / LETTER_WIDTH_PX);

  for (const scaler of scalers) {
    const page = scaler.querySelector(".sheet-page");
    if (!page) continue;
    page.style.transform = scale < 0.999 ? `scale(${scale.toFixed(4)})` : "none";
    page.style.transformOrigin = "top left";
    scaler.style.width = `${Math.round(LETTER_WIDTH_PX * scale)}px`;
    scaler.style.height = `${Math.round(LETTER_HEIGHT_PX * scale)}px`;
  }
}
