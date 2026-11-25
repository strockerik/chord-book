// Self-contained Print / Export HTML page generator (js/send.js)
// Reuses House Index's self-contained HTML page pattern so a single song
// or an entire set list can be downloaded, shared, or printed to PDF cleanly.

import { esc, toast } from "./core.js";
import { renderSongBodyHTML, renderChordDiagramSVG } from "./render.js";
import { soundingKeyWithTuning, getTuning } from "./chords.js";
import { chorusWording } from "./chordpro.js";
import { fitLadder, collapseRepeatedChoruses, STANDARD_SHEET_PT, MIN_SHEET_PT } from "./fit.js";

/**
 * Trigger standard browser print using our Safari-safe 680x840px 1-Page print engine,
 * so single-song "Print / PDF" also has wide margins and never spills onto a 2nd page in Safari!
 */
export function printCurrentSheet(songRow, viewOpts = {}) {
  if (!songRow) {
    window.print();
    return;
  }
  printSetlistToPDF(
    { name: songRow.title || "Chord Sheet", event_date: new Date().toISOString().slice(0, 10), notes: "" },
    [{
      item: {
        position: 1,
        transpose: viewOpts.semitoneDelta ?? songRow.preferred_transpose ?? 0,
        capo: viewOpts.capo ?? songRow.capo ?? 0,
        notes: songRow.notes || ""
      },
      song: songRow
    }],
    {
      pagesPerSong: viewOpts.pageMode === "2-sheet" ? "2-sheet" : "1-sheet",
      includeDiagrams: !!viewOpts.showDiagrams,
      includeNotes: true,
      compactChorus: !!viewOpts.compactChorus,
      includeIndexCover: false
    }
  );
}

/**
 * Export a song (with its current transpose, capo, sidebar notes, and chord diagrams)
 * as a standalone, self-contained, print-ready `.html` file.
 */
export function downloadSelfContainedSongHTML(songRow, viewOpts = {}) {
  const bodyModel = renderSongBodyHTML(songRow, { ...viewOpts, editableNotes: false });
  const { parsed, targetKey, distinctChords, sectionsToRender, renderSection } = bodyModel;
  const capo = Number(viewOpts.capo ?? songRow.capo ?? parsed.meta.capo ?? 0);
  const tuningInfo = getTuning(viewOpts.tuning || songRow.tuning || parsed.meta.tuning);
  const showSounding = capo > 0 || tuningInfo.offset !== 0;
  const soundingKey = showSounding ? soundingKeyWithTuning(targetKey, capo, tuningInfo.value) : targetKey;
  const title = songRow.title || parsed.meta.title || "Chord Sheet";
  const artist = songRow.artist || parsed.meta.artist || "";
  const headerNote = chorusWording(songRow.notes || parsed.meta.note || "");

  const diagramsHtml = distinctChords.length
    ? `<div class="diagrams">${distinctChords.map((c) => renderChordDiagramSVG(c, { customDefines: parsed.meta.defines })).join("")}</div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}${artist ? " — " + esc(artist) : ""} (Chord Sheet)</title>
<style>
  @page { size: letter portrait; margin: 0.3in; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Public Sans", "Segoe UI", Roboto, sans-serif;
    color: #1c1917;
    background: #faf8f5;
    margin: 0;
    padding: 24px;
  }
  .page {
    max-width: 8.5in;
    margin: 0 auto;
    background: #fff;
    padding: 0.3in;
    border: 1px solid #e5e0d8;
    border-radius: 8px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2px solid #1c1917;
    padding-bottom: 10px;
    margin-bottom: 12px;
    gap: 16px;
  }
  h1 { margin: 0; font-size: 22pt; font-family: Georgia, serif; }
  .artist { margin: 2px 0 0; color: #57534e; font-size: 11pt; }
  .note { margin: 4px 0 0; color: #9a3412; font-size: 9.5pt; font-style: italic; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill {
    border: 1px solid #d6d0c4;
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 9pt;
    background: #f5f2eb;
  }
  .diagrams {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e0d8;
  }
  .chord-card {
    background: #faf8f5;
    border: 1px solid #e5e0d8;
    border-radius: 6px;
    padding: 4px;
    text-align: center;
  }
  .chord-card-name { font-family: monospace; font-weight: 700; font-size: 9pt; }
  main { font-size: ${STANDARD_SHEET_PT}pt; }
  .song-section {
    display: grid;
    grid-template-columns: 1fr 190px;
    gap: 16px;
    margin-bottom: 12px;
    break-inside: avoid;
  }
  .section-label {
    margin: 0 0 6px;
    font-family: -apple-system, BlinkMacSystemFont, "Public Sans", "Segoe UI", Roboto, sans-serif;
    font-size: 12pt;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #0f172a;
    border-bottom: 2px solid #cbd5e1;
    padding-bottom: 2px;
    display: inline-block;
  }
  .song-section.is-chorus .section-label {
    font-size: 12.5pt;
    color: #78350f;
    background: #fef3c7;
    border: 1.5px solid #f59e0b;
    border-bottom-width: 2.5px;
    padding: 2px 10px;
    border-radius: 5px;
  }
  .song-section.type-bridge .section-label,
  .song-section.type-tag .section-label,
  .song-section.type-intro .section-label,
  .song-section.type-outro .section-label,
  .song-section.type-instrumental .section-label {
    color: #0f766e;
    border-bottom-color: #5eead4;
  }
  .verse-chorus-reminder {
    display: inline-block;
    margin-top: 7px;
    padding: 2px 10px;
    font-family: -apple-system, BlinkMacSystemFont, "Public Sans", "Segoe UI", Roboto, sans-serif;
    font-weight: 900;
    font-size: 10.5pt;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #78350f;
    background: #fef3c7;
    border-left: 3.5px solid #d97706;
    border-radius: 4px;
  }
  .lyric-line {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    line-height: 1.25;
    margin-bottom: 7px;
  }
  .cl-pair {
    display: inline-flex;
    flex-direction: column;
    vertical-align: bottom;
  }
  .chord-cell {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 700;
    color: #9a3412;
    font-size: 0.92em;
    padding-right: 4px;
    background: none;
    border: none;
    text-align: left;
  }
  .lyric-cell { white-space: pre; }
  .lyric-cell.has-word-break { display: flex; align-self: stretch; }
  .syllable-dash { flex: 1 0 auto; text-align: center; }
  .cl-word { display: inline-flex; align-items: flex-end; white-space: nowrap; }
  .cl-pair.is-word-tail .chord-cell { width: 0; padding: 0; overflow: hidden; }
  .section-sidebar-rail {
    border-left: 1.5px solid #e5e0d8;
    padding-left: 10px;
    font-size: 8.5pt;
  }
  .margin-note-card {
    background: #fef3c7;
    border-left: 3px solid #d97706;
    padding: 5px 8px;
    border-radius: 4px;
    margin-bottom: 6px;
  }
  .margin-note-badge {
    font-weight: 700;
    font-size: 7.5pt;
    text-transform: uppercase;
    color: #92400e;
    display: block;
  }
  .margin-note-text { margin: 2px 0 0; color: #292524; }
  @media print {
    body { background: #fff; padding: 0; }
    .page { border: none; padding: 0; max-width: none; }
  }
</style>
</head>
<body>
  <div class="page">
    <header>
      <div>
        <h1>${esc(title)}</h1>
        ${artist ? `<p class="artist">${esc(artist)}</p>` : ""}
        ${headerNote ? `<p class="note">${esc(headerNote)}</p>` : ""}
      </div>
      <div class="meta">
        <div class="pill">Key: <strong>${esc(targetKey)}</strong></div>
        ${capo > 0 ? `<div class="pill">Capo: <strong>Fret ${capo}</strong></div>` : ""}
        ${tuningInfo.id === "standard" ? "" : `<div class="pill">Tuning: <strong>${esc(tuningInfo.display)}</strong></div>`}
        ${showSounding ? `<div class="pill">Sounds in: <strong>${esc(soundingKey)}</strong></div>` : ""}
      </div>
    </header>
    ${diagramsHtml}
    <main>
      ${sectionsToRender.map(renderSection).join("")}
    </main>
  </div>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chord-sheet";
  a.href = url;
  a.download = `${slug}-${targetKey}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Downloaded print-ready sheet (${a.download})`);
}

/**
 * Build a self-contained, print-ready HTML document containing an entire Set List.
 * Runs the real DOM binary-search auto-fitter inside the exported document so that:
 * - In "1-sheet" mode (DEFAULT): every song is guaranteed to fit onto 1 single 8.5x11" page
 *   (4 songs = 4 pages total, or 5 if includeIndexCover is checked).
 * - In "2-sheet" mode: each song uses up to 2 pages.
 */
export function buildSetlistPrintableHTML(setlist, itemsWithSongs, exportOpts = {}) {
  const setName = setlist?.name || "Set List";
  const eventDate = setlist?.event_date || new Date().toISOString().slice(0, 10);
  const setNotes = setlist?.notes || "";

  const pagesPerSong = exportOpts.pagesPerSong || "1-sheet"; // "1-sheet" (default) | "2-sheet" | "saved"
  const includeDiagrams = !!exportOpts.includeDiagrams;
  const includeNotes = exportOpts.includeNotes !== false;
  const includeIndexCover = !!exportOpts.includeIndexCover;
  const compactChorus = !!exportOpts.compactChorus;

  const pagesHtml = [];

  itemsWithSongs.forEach(({ item, song }, idx) => {
    const semitoneDelta = Number(item?.transpose ?? song.preferred_transpose ?? 0);
    const capo = Number(item?.capo ?? song.capo ?? 0);
    const prefs = song.layout_prefs || {};
    const effectiveMode = pagesPerSong === "saved" ? (prefs.page_mode || "1-sheet") : pagesPerSong;

    const songCopy = includeNotes
      ? song
      : { ...song, layout_prefs: { ...prefs, sidebar_notes: {} } };

    const bodyModel = renderSongBodyHTML(songCopy, {
      semitoneDelta,
      accidentalPref: prefs.accidental_pref || "auto",
      compactChorus: compactChorus || !!prefs.compact_chorus,
      editableNotes: false
    });
    const { parsed, targetKey, distinctChords, sectionsToRender, renderSection } = bodyModel;
    const tuningInfo = getTuning(song.tuning || parsed.meta.tuning);
    const showSounding = capo > 0 || tuningInfo.offset !== 0;
    const soundingKey = showSounding ? soundingKeyWithTuning(targetKey, capo, tuningInfo.value) : targetKey;
    const title = song.title || parsed.meta.title || "Untitled";
    const artist = song.artist || parsed.meta.artist || "";
    const headerNote = chorusWording(item?.notes || song.notes || parsed.meta.note || "");
    const tempo = song.tempo || parsed.meta.tempo || "";

    const diagramsHtml = includeDiagrams && distinctChords.length
      ? `<div class="diagrams">${distinctChords.map((c) => renderChordDiagramSVG(c, { customDefines: parsed.meta.defines })).join("")}</div>`
      : "";

    // Split into 1 bucket (default 1-sheet per song!) or 2 buckets if 2-sheet mode was explicitly chosen
    let buckets = [sectionsToRender];
    if (effectiveMode === "2-sheet" && sectionsToRender.length >= 2) {
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
      buckets = [sectionsToRender.slice(0, splitIdx), sectionsToRender.slice(splitIdx)];
    }

    buckets.forEach((bucket, bIdx) => {
      const totalLines = bucket.reduce((acc, s) => acc + (s.sec.lines?.length || 0), 0);
      const useTwoCols = bucket.length >= 3 || totalLines >= 14;

      let flowInnerHtml;
      if (useTwoCols && bucket.length >= 2) {
        // Deterministically split sections into left & right flex/grid columns by line weight
        // (avoids Safari/WebKit's CSS column-count print spillover bug!)
        const weights = bucket.map((s) => Math.max(2, (s.sec.lines?.length || 0) + (s.sec.sidebarNote ? 2 : 0)));
        const totalW = weights.reduce((a, b) => a + b, 0);
        let accW = 0;
        let splitAt = Math.ceil(bucket.length / 2);
        for (let i = 0; i < bucket.length - 1; i++) {
          accW += weights[i];
          if (accW >= totalW * 0.48) {
            splitAt = i + 1;
            break;
          }
        }
        const leftSecs = bucket.slice(0, splitAt);
        const rightSecs = bucket.slice(splitAt);
        flowInnerHtml = `
          <div class="two-col-grid">
            <div class="two-col-left">${leftSecs.map(renderSection).join("")}</div>
            <div class="two-col-right">${rightSecs.map(renderSection).join("")}</div>
          </div>
        `;
      } else {
        flowInnerHtml = bucket.map(renderSection).join("");
      }

      pagesHtml.push(`
        <article class="sheet-page ${useTwoCols ? "is-two-col" : ""}${includeNotes ? "" : " hide-sidebar-notes"}" data-song-idx="${idx + 1}">
          <div class="sheet-top">
            <header class="sheet-header">
              <div class="title-col">
                <h1>${esc(title)}</h1>
                <p class="byline">${artist ? `<span class="artist">${esc(artist)}</span>` : ""}${headerNote && bIdx === 0 ? `<span class="note">${esc(headerNote)}</span>` : ""}</p>
              </div>
              <div class="meta-pills">
                ${itemsWithSongs.length > 1 ? `<div class="pill"><span>Song</span><strong>${idx + 1}/${itemsWithSongs.length}</strong></div>` : ""}
                <div class="pill page-pill" hidden><span>Page</span><strong></strong></div>
                <div class="pill is-primary"><span>Key</span><strong>${esc(targetKey)}</strong></div>
                ${capo > 0 ? `<div class="pill is-accent"><span>Capo</span><strong>Fret ${capo}</strong></div>` : ""}
                ${tuningInfo.id === "standard" ? "" : `<div class="pill is-accent"><span>Tuning</span><strong>${esc(tuningInfo.display)}</strong></div>`}
                ${showSounding ? `<div class="pill"><span>Sounds in</span><strong>${esc(soundingKey)}</strong></div>` : ""}
                ${tempo ? `<div class="pill"><span>Tempo</span><strong>${esc(tempo)} BPM</strong></div>` : ""}
              </div>
            </header>
            ${bIdx === 0 ? diagramsHtml : ""}
            <div class="sections-flow">
              ${flowInnerHtml}
            </div>
          </div>
          </article>
      `);
    });
  });

  const tocRowsHtml = itemsWithSongs.map(({ item, song }, idx) => {
    const semitoneDelta = Number(item?.transpose ?? song.preferred_transpose ?? 0);
    const capo = Number(item?.capo ?? song.capo ?? 0);
    const bodyModel = renderSongBodyHTML(song, { semitoneDelta, editableNotes: false });
    const shapesKey = bodyModel.targetKey;
    const tocTuning = song.tuning || bodyModel.parsed.meta.tuning;
    const soundingKey = capo > 0 || getTuning(tocTuning).offset ? soundingKeyWithTuning(shapesKey, capo, tocTuning) : shapesKey;
    return `
      <tr>
        <td class="num">${idx + 1}</td>
        <td><strong>${esc(song.title)}</strong><div class="sub">${esc(song.artist || "")}</div></td>
        <td class="mono"><strong>${esc(shapesKey)}</strong>${capo > 0 ? ` (Capo ${capo})` : ""}</td>
        <td class="mono"><strong>${esc(soundingKey)}</strong></td>
        <td class="mono">${esc(song.time_signature || "4/4")}${song.tempo ? ` • ${esc(song.tempo)} BPM` : ""}</td>
        <td>${esc(chorusWording(item?.notes || song.notes || ""))}</td>
      </tr>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(setName)} — Set List Chord Packet (${itemsWithSongs.length} Songs)</title>
<style>
  @page { size: letter portrait; margin: 0.3in; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, "Public Sans", "Segoe UI", Roboto, sans-serif;
    color: #1c1917;
    background: #f5f2eb;
    margin: 0;
    padding: 0;
  }
  .print-toolbar {
    max-width: 736px;
    margin: 16px auto;
    background: #1c1917;
    color: #faf8f5;
    padding: 10px 16px;
    border-radius: 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .print-toolbar button {
    background: #9a3412;
    color: #fff;
    border: none;
    padding: 8px 14px;
    border-radius: 6px;
    font-weight: 700;
    cursor: pointer;
  }
  .toc-card {
    width: 736px;
    margin: 0 auto 20px;
    background: #ffffff;
    border: 1px solid #e5e0d8;
    border-radius: 8px;
    padding: 18px 22px;
  }
  .toc-card.print-cover-page {
    height: 916px;
    page-break-after: always;
    break-after: page;
  }
  .toc-card h2 { margin: 0 0 4px; font-family: Georgia, serif; font-size: 15pt; }
  .toc-sub { margin: 0 0 12px; color: #57534e; font-size: 9pt; }
  table.toc-table { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.toc-table th, table.toc-table td {
    text-align: left;
    padding: 5px 7px;
    border-bottom: 1px solid #e5e0d8;
  }
  table.toc-table th {
    font-size: 7.2pt;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #665e52;
    background: #faf8f5;
  }
  table.toc-table td.num, table.toc-table td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table.toc-table .sub { font-size: 7.8pt; color: #665e52; }

  /* Letter is 816 x 1056px. This leaves slim margins plus room for Safari's print headers and footers. */
  .sheet-page {
    --sheet-font-size: ${STANDARD_SHEET_PT}pt;
    --sheet-line-gap: 1.14;
    --sheet-section-gap: 6px;
    --sheet-diag-scale: 0.8;

    width: 736px;
    height: 936px;
    max-height: 936px;
    margin: 0 auto 20px;
    background: #ffffff;
    border: 1px solid #e5e0d8;
    border-radius: 6px;
    padding: 14px 20px 10px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    page-break-after: always;
    break-after: page;
    page-break-inside: avoid;
    break-inside: avoid;
    overflow: hidden;
  }
  .sheet-page:last-of-type {
    page-break-after: auto;
    break-after: auto;
  }
  .sheet-top {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sheet-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    border-bottom: 2px solid #1c1917;
    padding-bottom: 4px;
    margin-bottom: 6px;
    flex-shrink: 0;
  }
  .sheet-header h1 { margin: 1px 0 0; font-size: 15pt; font-family: Georgia, serif; line-height: 1.1; color: #0f172a; }
  .artist { margin: 1px 0 0; color: #57534e; font-size: 8.5pt; font-weight: 600; }
  .note { margin: 2px 0 0; color: #57534e; font-size: 7.2pt; font-style: italic; }
  .meta-pills { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .pill {
    border: 1px solid #d6d0c4;
    border-radius: 4px;
    padding: 2px 5px;
    background: #f5f2eb;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .pill.is-primary { background: #fdf2ec; border-color: #fdba74; }
  .pill.is-accent { background: #fef3c7; border-color: #fcd34d; }
  .pill span { font-size: 5.5pt; text-transform: uppercase; color: #665e52; }
  .pill strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 7.8pt; }

  .diagrams {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 5px;
    padding-bottom: 4px;
    border-bottom: 1px solid #e5e0d8;
    flex-shrink: 0;
  }
  .chord-card {
    background: #faf8f5;
    border: 1px solid #e5e0d8;
    border-radius: 4px;
    padding: 2px 3px;
    text-align: center;
  }
  .chord-card-name { font-family: ui-monospace, monospace; font-weight: 700; font-size: 6.8pt; color: #9a3412; }
  .chord-svg { height: calc(52px * var(--sheet-diag-scale, 0.8)); width: auto; display: block; }

  /* Table-based 2-column grid (100% immune to Safari/WebKit CSS multi-column print bug!) */
  .sections-flow {
    flex: 1;
    min-height: 0;
    font-size: var(--sheet-font-size, ${STANDARD_SHEET_PT}pt);
    line-height: var(--sheet-line-gap, 1.14);
    overflow: hidden;
  }
  .two-col-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
    height: 100%;
  }
  .two-col-left {
    padding-right: 6px;
    min-width: 0;
  }
  .two-col-right {
    border-left: 1px solid #e5e0d8;
    padding-left: 12px;
    min-width: 0;
  }
  .song-section {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 165px;
    gap: 10px;
    margin-bottom: var(--sheet-section-gap, 14px);
    break-inside: avoid;
  }
  .section-main-col {
    min-width: 0;
  }
  .sheet-page.is-two-col .song-section,
  .sheet-page.hide-sidebar-notes .song-section {
    grid-template-columns: minmax(0, 1fr);
    gap: 3px;
  }
  .sheet-page.hide-sidebar-notes .section-sidebar-rail {
    display: none !important;
  }
  .song-section.is-chorus .section-main-col {
    border-left: 3px solid #d97706;
    padding-left: 9px;
  }
  .verse-chorus-reminder {
    display: inline-block;
    margin-top: 6px;
    padding: 2px 9px;
    font-family: -apple-system, BlinkMacSystemFont, "Public Sans", "Segoe UI", Roboto, sans-serif;
    font-weight: 900;
    font-size: 1.04em;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #78350f;
    background: #fef3c7;
    border-left: 3.5px solid #d97706;
    border-radius: 4px;
  }
  .section-header-row {
    margin-bottom: 4px;
  }
  .section-label {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Public Sans", "Segoe UI", Roboto, sans-serif;
    font-size: 1.14em;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    line-height: 1.15;
    color: #0f172a;
    border-bottom: 2px solid #cbd5e1;
    padding-bottom: 1.5px;
    display: inline-block;
  }
  .song-section.is-chorus .section-label {
    font-size: 1.18em;
    color: #78350f;
    background: #fef3c7;
    border: 1.5px solid #f59e0b;
    border-bottom-width: 2px;
    padding: 1.5px 8px;
    border-radius: 4px;
  }
  .song-section.type-bridge .section-label,
  .song-section.type-tag .section-label,
  .song-section.type-intro .section-label,
  .song-section.type-outro .section-label,
  .song-section.type-instrumental .section-label {
    color: #0f766e;
    border-bottom-color: #5eead4;
  }
  .lyric-line {
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-end;
    margin-bottom: var(--sheet-row-gap, 5px);
  }
  .cl-pair {
    display: inline-flex;
    flex-direction: column;
    vertical-align: bottom;
  }
  .cl-pair.is-chord-only { min-width: 1.8em; margin-right: 0.25em; }
  .cl-pair.is-chord-only:last-child { min-width: auto; margin-right: 0; padding-left: 2px; }
  .chord-cell {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 700;
    color: #9a3412;
    font-size: 0.88em;
    line-height: 1.02;
    padding: 0 3px 0 0;
    margin: 0 0 1px;
    background: none;
    border: none;
    text-align: left;
  }
  .chord-cell.is-empty { visibility: hidden; width: 0; overflow: visible; }
  .lyric-cell { white-space: pre; line-height: 1.14; }
  .sheet-page.is-wrap-lines .lyric-line { flex-wrap: wrap; }
  .lyric-cell.has-word-break { display: flex; align-self: stretch; }
  .syllable-dash { flex: 1 0 auto; text-align: center; }
  .cl-word { display: inline-flex; align-items: flex-end; white-space: nowrap; }
  .cl-pair.is-word-tail .chord-cell { width: 0; padding: 0; overflow: hidden; }

  .section-sidebar-rail {
    border-left: 1px solid #e5e0d8;
    padding-left: 8px;
  }
  .sheet-page.is-two-col .section-sidebar-rail {
    border-left: none;
    padding-left: 0;
    margin-top: 2px;
  }
  .margin-note-card {
    background: #fef9c3;
    border-left: 2.5px solid #d97706;
    padding: 2px 7px;
    border-radius: 4px;
    margin-bottom: 2px;
    font-size: 8pt;
    line-height: 1.18;
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    width: fit-content;
    max-width: 100%;
  }
  .margin-note-card.kind-key { background: #dbeafe; border-left-color: #2563eb; }
  .margin-note-card.kind-cue { background: #dcfce7; border-left-color: #16a34a; }
  .margin-note-card-head { display: inline; }
  .margin-note-badge {
    font-family: ui-monospace, monospace;
    font-weight: 700;
    font-size: 6.8pt;
    text-transform: uppercase;
    color: #665e52;
    white-space: nowrap;
  }
  .margin-note-badge::after { content: ":"; }
  .margin-note-text { margin: 0; color: #292524; display: inline; }
  .no-print { display: none !important; }

  /* Slim header: the page belongs to the song */
  .title-col { flex: 1; min-width: 0; }
  .byline { margin: 1px 0 0; font-size: 8.5pt; line-height: 1.25; }
  .byline .artist, .byline .note { display: inline; margin: 0; font-size: inherit; }
  .byline .artist + .note::before { content: " · "; font-style: normal; }
  .meta-pills { flex-wrap: nowrap; flex-shrink: 0; }
  .pill { flex-direction: row; align-items: baseline; gap: 3px; padding: 1px 5px; white-space: nowrap; }
  .pill span { font-size: 6pt; }
  .page-pill[hidden] { display: none; }
  .sheet-page.is-continued .note, .sheet-page.is-continued .diagrams { display: none; }

  @media print {
    html, body { background: #ffffff !important; padding: 0 !important; margin: 0 !important; }
    .print-toolbar { display: none !important; }
    .toc-card:not(.print-cover-page) { display: none !important; }
    .toc-card.print-cover-page {
      border: none !important;
      margin: 0 auto !important;
      width: 736px !important;
      height: 916px !important;
      max-height: 916px !important;
    }
    .sheet-page {
      border: none !important;
      border-radius: 0 !important;
      margin: 0 auto !important;
      padding: 0 !important;
      width: 736px !important;
      height: 936px !important;
      max-height: 936px !important;
      overflow: hidden !important;
    }
  }
</style>
</head>
<body>
  <div class="print-toolbar">
    <div>
      <strong>${esc(setName)}</strong> — ${pagesHtml.length} Page${pagesHtml.length === 1 ? "" : "s"} (${itemsWithSongs.length} Songs • 1-Page 8.5×11" Sheets)
    </div>
    <div>
      <button type="button" onclick="window.print()">🖨 Print / Save as PDF</button>
    </div>
  </div>

  <section class="toc-card${includeIndexCover ? " print-cover-page" : ""}">
    <h2>${esc(setName)} — Set List Index</h2>
    <p class="toc-sub">${esc(eventDate)}${setNotes ? " • " + esc(setNotes) : ""}</p>
    <table class="toc-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Song</th>
          <th>Key</th>
          <th>Sounds in</th>
          <th>Time / Tempo</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        ${tocRowsHtml}
      </tbody>
    </table>
  </section>

  ${pagesHtml.join("\n")}

  ${exportOpts.embedFit ? `<script>
  ${fitLadder.toString()}
  ${collapseRepeatedChoruses.toString()}
  (${fitPrintPages.toString()})(document, fitLadder, collapseRepeatedChoruses, ${STANDARD_SHEET_PT}, ${MIN_SHEET_PT});
  </script>` : ""}
</body>
</html>`;
}

/**
 * Fits each printed page with the same rules as the on-screen sheet.
 * Also embedded in downloaded packets, so everything it uses is passed in.
 */
function fitPrintPages(doc, ladder, collapse, targetPt, minPt) {
  const songs = new Map();
  for (const page of doc.querySelectorAll(".sheet-page")) {
    const key = page.dataset.songIdx;
    if (!songs.has(key)) songs.set(key, []);
    songs.get(key).push(page);
  }

  for (const songPages of songs.values()) {
    const sections = songPages.flatMap((page) => Array.from(page.querySelectorAll(".song-section")));
    const minPages = songPages.length;
    const maxPages = Math.max(minPages, Math.min(4, sections.length));
    const weights = sections.map((section) => Math.max(2, section.querySelectorAll(".lyric-line").length) + 1);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

    const splitForPages = (count) => {
      const buckets = [];
      let start = 0;
      let running = 0;
      for (let page = 1; page < count; page++) {
        const target = (totalWeight * page) / count;
        let end = start + 1;
        running += weights[start];
        while (end < sections.length - (count - page) + 1 && running + weights[end] / 2 < target) {
          running += weights[end];
          end++;
        }
        buckets.push(sections.slice(start, end));
        start = end;
      }
      buckets.push(sections.slice(start));
      return buckets;
    };

    const layoutPage = (page, pageSections, cols, wrap) => {
      const flow = page.querySelector(".sections-flow");
      page.classList.toggle("is-two-col", cols === 2);
      page.classList.toggle("is-wrap-lines", wrap);
      flow.textContent = "";
      if (cols === 1 || pageSections.length < 2) {
        pageSections.forEach((section) => flow.appendChild(section));
        return;
      }
      const grid = doc.createElement("div");
      const left = doc.createElement("div");
      const right = doc.createElement("div");
      grid.className = "two-col-grid";
      left.className = "two-col-left";
      right.className = "two-col-right";
      grid.append(left, right);
      flow.appendChild(grid);
      pageSections.forEach((section) => left.appendChild(section));
      const heights = pageSections.map((section) => section.getBoundingClientRect().height);
      const total = heights.reduce((sum, height) => sum + height, 0);
      let running = 0;
      let bestSplit = 1;
      let bestTallest = Infinity;
      for (let i = 0; i < pageSections.length - 1; i++) {
        running += heights[i];
        const tallest = Math.max(running, total - running);
        if (tallest < bestTallest) {
          bestTallest = tallest;
          bestSplit = i + 1;
        }
      }
      pageSections.slice(bestSplit).forEach((section) => right.appendChild(section));
    };

    const pageFits = (page) => {
      const flow = page.querySelector(".sections-flow");
      if (page.scrollHeight > page.clientHeight + 1) return false;
      if (flow.scrollHeight > flow.clientHeight + 1 || flow.scrollWidth > flow.clientWidth + 2) return false;
      for (const line of flow.querySelectorAll(".lyric-line")) {
        if (line.scrollWidth > line.clientWidth + 2) return false;
        const last = line.lastElementChild;
        if (last && last.getBoundingClientRect().right > line.getBoundingClientRect().right + 2) return false;
      }
      return true;
    };

    const group = [...songPages];
    let result = null;
    for (let count = minPages; count <= maxPages; count++) {
      while (group.length < count) {
        const extra = group[group.length - 1].cloneNode(true);
        extra.querySelector(".sections-flow").textContent = "";
        group[group.length - 1].after(extra);
        group.push(extra);
      }
      const buckets = splitForPages(count);
      group.forEach((page, i) => {
        page.classList.toggle("is-continued", i > 0);
        const pill = page.querySelector(".page-pill");
        if (pill) {
          pill.hidden = group.length < 2;
          pill.querySelector("strong").textContent = (i + 1) + "/" + group.length;
        }
      });
      // Tab gets the full page width, never a column, sized so its longest line fills it.
      const hasTab = group.some((page) => page.querySelector(".tab-block"));
      // One size for every tab block in the song: the widest block fills the page width.
      const sizeTabs = () => {
        const blocks = group.flatMap((page) => Array.from(page.querySelectorAll(".tab-block")));
        let best = Infinity;
        for (const pre of blocks) {
          pre.style.fontSize = "";
          const style = doc.defaultView.getComputedStyle(pre);
          const available = pre.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const used = (pre.querySelector("code") || pre).getBoundingClientRect().width;
          if (available > 0 && used > 0) best = Math.min(best, parseFloat(style.fontSize) * (available / used) * 0.98);
        }
        if (!Number.isFinite(best)) return;
        const px = Math.max(8 * 4 / 3, Math.min(15 * 4 / 3, best)).toFixed(2) + "px";
        for (const pre of blocks) pre.style.fontSize = px;
      };
      result = ladder({
        targetPt,
        minPt,
        columnChoices: hasTab ? [1] : [1, 2],
        setType: (pt, spacing) => {
          for (const page of group) {
            page.style.setProperty("--sheet-font-size", pt.toFixed(2) + "pt");
            page.style.setProperty("--sheet-line-gap", String(spacing.line));
            page.style.setProperty("--sheet-row-gap", spacing.row + "px");
            page.style.setProperty("--sheet-section-gap", spacing.section + "px");
          }
        },
        setLayout: (cols, wrap) => group.forEach((page, i) => layoutPage(page, buckets[i], cols, wrap)),
        fits: () => { sizeTabs(); return group.every(pageFits); },
        collapseRepeats: () => collapse(group)
      });
      if (result.fits) break;
    }
    group.forEach((page) => {
      page.dataset.fitPt = result.pt.toFixed(2);
      page.dataset.fitCols = String(result.cols);
      page.dataset.fits = String(result.fits);
    });
  }
}

/**
 * Download a self-contained `.html` file of the entire set list with the user's chosen export options.
 */
export function downloadSetlistHTML(setlist, itemsWithSongs, exportOpts = {}) {
  if (!itemsWithSongs || !itemsWithSongs.length) return;
  const html = buildSetlistPrintableHTML(setlist, itemsWithSongs, { ...exportOpts, embedFit: true });
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = String(setlist?.name || "setlist").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "setlist";
  a.href = url;
  a.download = `${slug}-1page-chord-sheets.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Downloaded set list HTML packet (${a.download})`);
}

/**
 * Open the set list print packet in a print dialog to save directly as a multi-page 8.5x11" PDF.
 */
export function printSetlistToPDF(setlist, itemsWithSongs, exportOpts = {}) {
  if (!itemsWithSongs || !itemsWithSongs.length) return;
  const html = buildSetlistPrintableHTML(setlist, itemsWithSongs, exportOpts);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "816px";
  iframe.style.height = "1056px";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  // The app's security policy blocks scripts inside this frame, so fit the pages from here.
  fitPrintPages(doc, fitLadder, collapseRepeatedChoruses, STANDARD_SHEET_PT, MIN_SHEET_PT);

  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 2000);
  }, 450);
}

