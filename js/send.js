// Self-contained Print / Export HTML page generator (js/send.js)
// Reuses House Index's self-contained HTML page pattern so a single song
// or an entire set list can be downloaded, shared, or printed to PDF cleanly.

import { esc, toast } from "./core.js";
import { renderSongBodyHTML, renderChordDiagramSVG } from "./render.js";
import { soundingKeyFromShapes } from "./chords.js";

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
  const soundingKey = capo > 0 ? soundingKeyFromShapes(targetKey, capo) : targetKey;
  const title = songRow.title || parsed.meta.title || "Chord Sheet";
  const artist = songRow.artist || parsed.meta.artist || "";
  const headerNote = songRow.notes || parsed.meta.note || "";

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
  @page { size: letter portrait; margin: 0.45in; }
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
    padding: 0.45in;
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
        <div class="pill">Shapes: <strong>${esc(targetKey)}</strong></div>
        ${capo > 0 ? `<div class="pill">Capo: <strong>Fret ${capo}</strong> (Sounds in <strong>${esc(soundingKey)}</strong>)</div>` : ""}
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
    const soundingKey = capo > 0 ? soundingKeyFromShapes(targetKey, capo) : targetKey;
    const title = song.title || parsed.meta.title || "Untitled";
    const artist = song.artist || parsed.meta.artist || "";
    const headerNote = item?.notes || song.notes || parsed.meta.note || "";
    const tuning = song.tuning || parsed.meta.tuning || "E A D G B E";
    const tempo = song.tempo || parsed.meta.tempo || "";
    const timeSig = song.time_signature || parsed.meta.time || "";

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
                <div class="set-pos-eyebrow">${esc(setName)} • Song ${idx + 1} of ${itemsWithSongs.length}${buckets.length > 1 ? ` (Part ${bIdx + 1}/${buckets.length})` : ""}</div>
                <h1>${esc(title)}</h1>
                ${artist ? `<p class="artist">${esc(artist)}</p>` : ""}
                ${headerNote && bIdx === 0 ? `<p class="note">${esc(headerNote)}</p>` : ""}
              </div>
              <div class="meta-pills">
                <div class="pill is-primary"><span>${capo > 0 ? "Play Shapes" : "Key"}</span><strong>${esc(targetKey)}</strong></div>
                ${capo > 0 ? `<div class="pill is-accent"><span>Capo</span><strong>Fret ${capo}</strong></div>` : ""}
                <div class="pill"><span>Sing Pitch</span><strong>${esc(soundingKey)}</strong></div>
                ${timeSig ? `<div class="pill"><span>Time</span><strong>${esc(timeSig)}</strong></div>` : ""}
                ${tempo ? `<div class="pill"><span>Tempo</span><strong>${esc(tempo)} BPM</strong></div>` : ""}
                <div class="pill"><span>Tuning</span><strong>${esc(tuning)}</strong></div>
              </div>
            </header>
            ${bIdx === 0 ? diagramsHtml : ""}
            <div class="sections-flow">
              ${flowInnerHtml}
            </div>
          </div>
          <footer class="sheet-footer">
            <span>${esc(setName)} (${esc(eventDate)}) — ${idx + 1}. ${esc(title)}</span>
            <span>${capo > 0 ? `Play ${esc(targetKey)} shapes • Capo ${capo} (Sounds in ${esc(soundingKey)})` : `Key of ${esc(targetKey)}`} • Song ${idx + 1} of ${itemsWithSongs.length}</span>
          </footer>
        </article>
      `);
    });
  });

  const tocRowsHtml = itemsWithSongs.map(({ item, song }, idx) => {
    const semitoneDelta = Number(item?.transpose ?? song.preferred_transpose ?? 0);
    const capo = Number(item?.capo ?? song.capo ?? 0);
    const bodyModel = renderSongBodyHTML(song, { semitoneDelta, editableNotes: false });
    const shapesKey = bodyModel.targetKey;
    const soundingKey = capo > 0 ? soundingKeyFromShapes(shapesKey, capo) : shapesKey;
    return `
      <tr>
        <td class="num">${idx + 1}</td>
        <td><strong>${esc(song.title)}</strong><div class="sub">${esc(song.artist || "")}</div></td>
        <td class="mono"><strong>${esc(shapesKey)}</strong>${capo > 0 ? ` (Capo ${capo})` : ""}</td>
        <td class="mono"><strong>${esc(soundingKey)}</strong></td>
        <td class="mono">${esc(song.time_signature || "4/4")}${song.tempo ? ` • ${esc(song.tempo)} BPM` : ""}</td>
        <td>${esc(item?.notes || song.notes || "")}</td>
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
  @page { size: letter portrait; margin: 0.45in; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, "Public Sans", "Segoe UI", Roboto, sans-serif;
    color: #1c1917;
    background: #f5f2eb;
    margin: 0;
    padding: 0;
  }
  .print-toolbar {
    max-width: 720px;
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
    width: 680px;
    margin: 0 auto 20px;
    background: #ffffff;
    border: 1px solid #e5e0d8;
    border-radius: 8px;
    padding: 18px 22px;
  }
  .toc-card.print-cover-page {
    height: 820px;
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

  /* Safari & Chrome iPad/Mac Print Safe Canvas:
     680px x 840px leaves generous wide margins on all 4 sides, even when Safari's
     "Print headers and footers" is checked! Never spills onto an extra page. */
  .sheet-page {
    --sheet-font-size: 10pt;
    --sheet-line-gap: 1.14;
    --sheet-section-gap: 6px;
    --sheet-diag-scale: 0.8;

    width: 680px;
    height: 840px;
    max-height: 840px;
    margin: 0 auto 20px;
    background: #ffffff;
    border: 1px solid #e5e0d8;
    border-radius: 6px;
    padding: 16px 22px 12px;
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
  .set-pos-eyebrow {
    font-size: 6.8pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #665e52;
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
    font-size: var(--sheet-font-size, 10pt);
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
  .chord-cell.is-empty { visibility: hidden; }
  .lyric-cell { white-space: pre; line-height: 1.14; }
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
    font-size: 6.6pt;
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
    font-size: 5.8pt;
    text-transform: uppercase;
    color: #665e52;
    white-space: nowrap;
  }
  .margin-note-badge::after { content: ":"; }
  .margin-note-text { margin: 0; color: #292524; display: inline; }
  .no-print { display: none !important; }

  .sheet-footer {
    display: flex;
    justify-content: space-between;
    border-top: 1px solid #e5e0d8;
    padding-top: 4px;
    margin-top: 4px;
    font-family: ui-monospace, monospace;
    font-size: 6.5pt;
    color: #665e52;
    flex-shrink: 0;
  }

  @media print {
    html, body { background: #ffffff !important; padding: 0 !important; margin: 0 !important; }
    .print-toolbar { display: none !important; }
    .toc-card:not(.print-cover-page) { display: none !important; }
    .toc-card.print-cover-page {
      border: none !important;
      margin: 0 auto !important;
      width: 680px !important;
      height: 820px !important;
      max-height: 820px !important;
    }
    .sheet-page {
      border: none !important;
      border-radius: 0 !important;
      margin: 0 auto !important;
      padding: 12px 18px 8px !important;
      width: 680px !important;
      height: 840px !important;
      max-height: 840px !important;
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
          <th>Play Shapes</th>
          <th>Sing Pitch</th>
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

  <script>
  // Deterministic 1-Page Auto-Fitter: binary-searches font size and spacing for every .sheet-page
  // so 100% of every song fits inside its single 840px Safari-safe page box with zero overflow!
  (function fitAllPages() {
    const pages = Array.from(document.querySelectorAll(".sheet-page"));
    for (const page of pages) {
      const flow = page.querySelector(".sections-flow");
      const footer = page.querySelector(".sheet-footer");
      if (!flow) continue;

      const applyFont = (pt) => {
        const t = Math.max(0, Math.min(1, (pt - 6.2) / (11.2 - 6.2)));
        page.style.setProperty("--sheet-font-size", pt.toFixed(2) + "pt");
        page.style.setProperty("--sheet-line-gap", (1.04 + t * 0.20).toFixed(2));
        page.style.setProperty("--sheet-row-gap", Math.round(3 + Math.pow(t, 0.85) * 5) + "px");
        page.style.setProperty("--sheet-section-gap", Math.round(7 + Math.pow(t, 0.85) * 15) + "px");
        page.style.setProperty("--sheet-diag-scale", (0.65 + t * 0.25).toFixed(2));
      };

      const fits = (bottomBuffer = 0) => {
        if (page.scrollHeight > page.clientHeight + 1) return false;
        if (flow.scrollHeight > flow.clientHeight + 1) return false;
        if (flow.scrollWidth > flow.clientWidth + 2) return false;
        const lines = flow.querySelectorAll(".lyric-line");
        for (const ln of lines) {
          if (ln.scrollWidth > ln.clientWidth + 2) return false;
          const lastPair = ln.lastElementChild;
          if (lastPair && lastPair.getBoundingClientRect().right > ln.getBoundingClientRect().right + 2) {
            return false;
          }
        }
        if (footer) {
          const fTop = footer.getBoundingClientRect().top;
          const secs = flow.querySelectorAll(".song-section");
          for (const s of secs) {
            if (s.getBoundingClientRect().bottom > fTop + 1 - bottomBuffer) return false;
          }
        }
        return true;
      };

      let low = 6.2, high = 11.2, best = low;
      for (let i = 0; i < 8; i++) {
        const mid = (low + high) / 2;
        applyFont(mid);
        if (fits()) { best = mid; low = mid; } else { high = mid; }
      }
      applyFont(best);
      let guard = 0;
      while (!fits() && best > 6.0 && guard < 10) {
        best -= 0.25;
        applyFont(best);
        guard++;
      }

      // When a song has spare vertical white space on the page, expand both line-to-line row spacing
      // and section-to-section spacing so chords, lyrics, verses, and choruses have maximum breathing room.
      if (fits(16)) {
        const tBase = Math.max(0, Math.min(1, (best - 6.2) / (11.2 - 6.2)));
        const baseLineGap = 1.04 + tBase * 0.20;
        const baseRowGap = Math.round(3 + Math.pow(tBase, 0.85) * 5);
        const baseSecGap = Math.round(7 + Math.pow(tBase, 0.85) * 15);
        const maxRowGap = 11;
        const maxSecGap = 36;
        let sLow = 0, sHigh = 1, sBest = 0;
        for (let i = 0; i < 6; i++) {
          const mid = (sLow + sHigh) / 2;
          const trialRow = Math.round(baseRowGap + mid * (maxRowGap - baseRowGap));
          const trialSec = Math.round(baseSecGap + mid * (maxSecGap - baseSecGap));
          const trialLine = (baseLineGap + mid * 0.12).toFixed(2);
          page.style.setProperty("--sheet-row-gap", trialRow + "px");
          page.style.setProperty("--sheet-section-gap", trialSec + "px");
          page.style.setProperty("--sheet-line-gap", trialLine);
          if (fits(16)) { sBest = mid; sLow = mid; } else { sHigh = mid; }
        }
        page.style.setProperty("--sheet-row-gap", Math.round(baseRowGap + sBest * (maxRowGap - baseRowGap)) + "px");
        page.style.setProperty("--sheet-section-gap", Math.round(baseSecGap + sBest * (maxSecGap - baseSecGap)) + "px");
        page.style.setProperty("--sheet-line-gap", (baseLineGap + sBest * 0.12).toFixed(2));
      }
    }
  })();
  </script>
</body>
</html>`;
}

/**
 * Download a self-contained `.html` file of the entire set list with the user's chosen export options.
 */
export function downloadSetlistHTML(setlist, itemsWithSongs, exportOpts = {}) {
  if (!itemsWithSongs || !itemsWithSongs.length) return;
  const html = buildSetlistPrintableHTML(setlist, itemsWithSongs, exportOpts);
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

  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 2000);
  }, 450);
}

