// Deterministic 8.5x11 Sheet Packing & Auto-Fit Engine (1-Sheet, 2-Sheet, and Scroll modes).
// Measures real DOM box heights inside a virtual 8.5x11" Letter canvas (816x1056 px at 96dpi)
// and binary-searches font size, line gap, section gap, and column count so 100% of the song
// fits onto the requested 1 or 2 sheets without clipping or overflow.

import { esc } from "./core.js";
import { soundingKeyFromShapes } from "./chords.js";
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
  const soundingKey = capo > 0 ? soundingKeyFromShapes(targetKey, capo) : targetKey;
  const headerNote = songRow.notes || parsed.meta.note || "";
  const tuning = songRow.tuning || parsed.meta.tuning || "E A D G B E";
  const isStandardTuning = /^(standard|e\s*a\s*d\s*g\s*b\s*e)$/i.test(String(tuning).trim());

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
          <div class="meta-pill">
            <span class="meta-pill-label">Sounds in</span>
            <strong class="meta-pill-val">${esc(soundingKey)}</strong>
          </div>
        ` : ""}
        ${isStandardTuning ? "" : `
          <div class="meta-pill">
            <span class="meta-pill-label">Tuning</span>
            <strong class="meta-pill-val">${esc(tuning)}</strong>
          </div>
        `}
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

  // Mode 2: 1-Sheet or 2-Sheet 8.5x11" Letter Layout
  const targetPages = pageMode === "2-sheet" ? 2 : 1;
  containerEl.className = `song-stage mode-sheet mode-${targetPages}-sheet`;

  // Split sections into 1 or 2 page buckets
  let pageBuckets = [sectionsToRender];
  if (targetPages === 2 && sectionsToRender.length >= 2) {
    // Split by approximate line count midpoint
    const totalLines = sectionsToRender.reduce((acc, s) => acc + Math.max(2, (s.sec.lines || []).length), 0);
    let running = 0;
    let splitIdx = Math.ceil(sectionsToRender.length / 2);
    for (let i = 0; i < sectionsToRender.length; i++) {
      running += Math.max(2, (sectionsToRender[i].sec.lines || []).length);
      if (running >= totalLines / 2 && i < sectionsToRender.length - 1) {
        splitIdx = i + 1;
        break;
      }
    }
    pageBuckets = [
      sectionsToRender.slice(0, splitIdx),
      sectionsToRender.slice(splitIdx)
    ];
  }

  // Render the fixed 816x1056px Letter page(s) inside responsive scaler wrappers
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
            <footer class="sheet-footer">
              <span>${esc(songRow.title || parsed.meta.title || "")}${capo > 0 ? ` • ${esc(targetKey)} shapes, capo ${capo} (sounds in ${esc(soundingKey)})` : ` • Key of ${esc(targetKey)}`}</span>
              <span>Page ${pIdx + 1} of ${pageBuckets.length}</span>
            </footer>
          </article>
        </div>
      `).join("")}
    </div>
  `;

  const pages = Array.from(containerEl.querySelectorAll(".sheet-page"));
  const fitResult = autoFitLetterPages(pages, {
    columnsPref,
    fontOffset,
    sectionCount: sectionsToRender.length
  });

  scaleLetterPagesToViewport(containerEl);
  return {
    pageMode,
    pages: pageBuckets.length,
    ...fitResult
  };
}

let fitGeneration = 0;

/**
 * Deterministic binary search over font size & spacing (and 1-column vs 2-column layout)
 * so every `.sheet-page` has `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth`.
 */
export function autoFitLetterPages(pageEls, { columnsPref = "auto", fontOffset = 0 } = {}) {
  if (!pageEls || !pageEls.length) return { fontPt: 12, columns: 1, fits: true };
  const myGen = ++fitGeneration;

  const applyVars = (cols, fontPt) => {
    // Derive line-gap, row-gap, and section-gap smoothly from fontPt so songs have
    // generous breathing space between lines and between verses/choruses while singing.
    const t = Math.max(0, Math.min(1, (fontPt - 7.5) / (13.8 - 7.5)));
    const lineGap = (1.04 + t * 0.24).toFixed(2);
    const rowGap = Math.round(2 + Math.pow(t, 0.85) * 6);
    const secGap = Math.round(6 + Math.pow(t, 0.8) * 20);
    const diagScale = (0.76 + t * 0.24).toFixed(2);

    for (const p of pageEls) {
      p.style.setProperty("--sheet-cols", String(cols));
      p.style.setProperty("--sheet-font-size", `${fontPt.toFixed(2)}pt`);
      p.style.setProperty("--sheet-line-gap", lineGap);
      p.style.setProperty("--sheet-row-gap", `${rowGap}px`);
      p.style.setProperty("--sheet-section-gap", `${secGap}px`);
      p.style.setProperty("--sheet-diag-scale", diagScale);
      p.classList.toggle("is-two-col", cols === 2);
    }
  };

  const checkPagesFit = (bottomBuffer = 0) => {
    for (const p of pageEls) {
      if (p.scrollHeight > p.clientHeight + 1) return false;
      const flow = p.querySelector(".sheet-sections-flow");
      const footer = p.querySelector(".sheet-footer");
      if (flow) {
        if (flow.scrollHeight > flow.clientHeight + 1) return false;
        if (flow.scrollWidth > flow.clientWidth + 2) return false;
        // Ensure no single lyric+chord line overflows or wraps its trailing chord inside its column
        const lines = flow.querySelectorAll(".lyric-line");
        for (const ln of lines) {
          if (ln.scrollWidth > ln.clientWidth + 2) return false;
          const lastPair = ln.lastElementChild;
          if (lastPair && lastPair.getBoundingClientRect().right > ln.getBoundingClientRect().right + 2) {
            return false;
          }
        }
        // Also verify every section and line box sits above the footer top
        if (footer) {
          const footerTop = footer.getBoundingClientRect().top;
          const secs = flow.querySelectorAll(".song-section");
          for (const sec of secs) {
            if (sec.getBoundingClientRect().bottom > footerTop + 1 - bottomBuffer) return false;
          }
        }
      }
    }
    return true;
  };

  const findBestFontForCols = (cols) => {
    let low = 7.0;
    let high = 13.8;
    let best = low;
    for (let iter = 0; iter < 8; iter++) {
      const mid = (low + high) / 2;
      applyVars(cols, mid);
      if (checkPagesFit()) {
        best = mid;
        low = mid;
      } else {
        high = mid;
      }
    }
    return best;
  };

  let chosenCols = 1;
  let chosenFont = 11.5;

  if (columnsPref === 1 || columnsPref === "1") {
    chosenCols = 1;
    chosenFont = findBestFontForCols(1);
  } else if (columnsPref === 2 || columnsPref === "2") {
    chosenCols = 2;
    chosenFont = findBestFontForCols(2);
  } else {
    // Auto: try 1 column first (keeps wider right-hand sidebar margin rail).
    // If 1 column forces the font below 10.2pt, compare with 2-column mode and pick whichever gives a more readable sheet.
    const font1 = findBestFontForCols(1);
    if (font1 >= 10.2) {
      chosenCols = 1;
      chosenFont = font1;
    } else {
      const font2 = findBestFontForCols(2);
      if (font2 > font1 + 0.6) {
        chosenCols = 2;
        chosenFont = font2;
      } else {
        chosenCols = 1;
        chosenFont = font1;
      }
    }
  }

  // Apply user's manual font nudge while still clamping if it would overflow (unless user explicitly nudged up)
  let finalFont = Math.max(6.8, Math.min(16.5, chosenFont + fontOffset * 0.6));
  applyVars(chosenCols, finalFont);
  // Step down if webfont metrics or rounding left a few pixels of overflow
  let stepGuard = 0;
  while (fontOffset <= 0 && !checkPagesFit() && finalFont > 6.5 && stepGuard < 12) {
    finalFont = Math.max(6.5, finalFont - 0.3);
    applyVars(chosenCols, finalFont);
    stepGuard++;
  }

  // Last-resort safety net: if a massive song still exceeds page height at 6.5pt in 1-col, switch to 2-col or compact diagrams
  if (!checkPagesFit() && chosenCols === 1 && columnsPref === "auto") {
    chosenCols = 2;
    finalFont = findBestFontForCols(2);
    applyVars(chosenCols, finalFont);
  }
  if (!checkPagesFit()) {
    for (const p of pageEls) {
      p.classList.add("is-ultra-compact");
    }
  } else if (checkPagesFit(16)) {
    // When a song has generous spare vertical white space on the sheet, expand both row spacing
    // and section spacing between verses and choruses so sections and lines are easy to distinguish.
    const tBase = Math.max(0, Math.min(1, (finalFont - 7.5) / (13.8 - 7.5)));
    const baseLineGap = 1.04 + tBase * 0.24;
    const baseRowGap = Math.round(2 + Math.pow(tBase, 0.85) * 6);
    const baseSecGap = Math.round(6 + Math.pow(tBase, 0.8) * 20);
    const maxRowGap = 12;
    const maxSecGap = 40;
    let sLow = 0;
    let sHigh = 1;
    let sBest = 0;
    for (let i = 0; i < 6; i++) {
      const mid = (sLow + sHigh) / 2;
      const trialRowGap = Math.round(baseRowGap + mid * (maxRowGap - baseRowGap));
      const trialSecGap = Math.round(baseSecGap + mid * (maxSecGap - baseSecGap));
      const trialLineGap = (baseLineGap + mid * 0.12).toFixed(2);
      for (const p of pageEls) {
        p.style.setProperty("--sheet-row-gap", `${trialRowGap}px`);
        p.style.setProperty("--sheet-section-gap", `${trialSecGap}px`);
        p.style.setProperty("--sheet-line-gap", trialLineGap);
      }
      if (checkPagesFit(16)) {
        sBest = mid;
        sLow = mid;
      } else {
        sHigh = mid;
      }
    }
    const finalRowGap = Math.round(baseRowGap + sBest * (maxRowGap - baseRowGap));
    const finalSecGap = Math.round(baseSecGap + sBest * (maxSecGap - baseSecGap));
    const finalLineGap = (baseLineGap + sBest * 0.12).toFixed(2);
    for (const p of pageEls) {
      p.style.setProperty("--sheet-row-gap", `${finalRowGap}px`);
      p.style.setProperty("--sheet-section-gap", `${finalSecGap}px`);
      p.style.setProperty("--sheet-line-gap", finalLineGap);
    }
  }

  // Re-fit deterministically once web fonts finish loading so late font swap never causes overflow
  if (typeof document !== "undefined" && document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (myGen !== fitGeneration) return;
      if (!pageEls[0]?.isConnected) return;
      let f = finalFont;
      let g = 0;
      while (fontOffset <= 0 && !checkPagesFit() && f > 6.5 && g < 12) {
        f = Math.max(6.5, f - 0.25);
        applyVars(chosenCols, f);
        g++;
      }
    }).catch(() => {});
  }

  return {
    fontPt: Number(finalFont.toFixed(1)),
    columns: chosenCols,
    fits: checkPagesFit()
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
