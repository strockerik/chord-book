// Song -> HTML renderer:
// 1. Chords-over-lyrics inline-block columns (never absolute pixel positioning)
// 2. SVG guitar chord diagram generator (with left-handed support)
// 3. Right-hand Sidebar Margin Notes rail + inline "+ Note" triggers
// 4. Optional repeated-chorus compaction for 1-sheet / 2-sheet fitting

import { esc } from "./core.js";
import {
  parseChord,
  transposeChord,
  transposeKey,
  toNashville,
  getChordVoicing
} from "./chords.js";
import { parse, chorusWording } from "./chordpro.js";

/**
 * Render an SVG guitar chord diagram for `chordName`.
 */
export function renderChordDiagramSVG(chordName, { customDefines = {}, leftHanded = false } = {}) {
  const voicing = getChordVoicing(chordName, customDefines);
  if (!voicing || !Array.isArray(voicing.frets)) {
    return `
      <div class="chord-card chord-card-unknown" data-chord="${esc(chordName)}">
        <div class="chord-card-name">${esc(chordName)}</div>
        <div class="chord-card-placeholder">No diagram</div>
      </div>
    `;
  }

  const frets = leftHanded ? [...voicing.frets].reverse() : voicing.frets;
  const baseFret = voicing.baseFret || 1;
  const width = 76;
  const height = 92;
  const padX = 13;
  const padTop = 22;
  const stringGap = 10;
  const fretGap = 14;
  const numStrings = 6;
  const numFrets = 4;

  const lines = [];
  // Nut or top line
  if (baseFret === 1) {
    lines.push(`<line x1="${padX - 1}" y1="${padTop}" x2="${padX + stringGap * 5 + 1}" y2="${padTop}" stroke="currentColor" stroke-width="3" />`);
  } else {
    lines.push(`<line x1="${padX}" y1="${padTop}" x2="${padX + stringGap * 5}" y2="${padTop}" stroke="currentColor" stroke-width="1.2" />`);
    lines.push(`<text x="${padX - 4}" y="${padTop + fretGap * 0.75}" font-size="9" text-anchor="end" fill="currentColor" font-family="IBM Plex Mono, monospace">${baseFret}fr</text>`);
  }

  // Fret lines
  for (let f = 1; f <= numFrets; f++) {
    const y = padTop + f * fretGap;
    lines.push(`<line x1="${padX}" y1="${y}" x2="${padX + stringGap * 5}" y2="${y}" stroke="currentColor" stroke-opacity="0.35" stroke-width="1" />`);
  }

  // String lines
  for (let s = 0; s < numStrings; s++) {
    const x = padX + s * stringGap;
    lines.push(`<line x1="${x}" y1="${padTop}" x2="${x}" y2="${padTop + numFrets * fretGap}" stroke="currentColor" stroke-opacity="0.55" stroke-width="1" />`);
  }

  // Barres
  if (Array.isArray(voicing.barres)) {
    for (const b of voicing.barres) {
      const fromS = leftHanded ? 5 - b.to : b.from;
      const toS = leftHanded ? 5 - b.from : b.to;
      const x1 = padX + Math.min(fromS, toS) * stringGap;
      const x2 = padX + Math.max(fromS, toS) * stringGap;
      const y = padTop + (b.fret - 0.5) * fretGap;
      lines.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="currentColor" stroke-width="6" stroke-linecap="round" />`);
    }
  }

  // Dots and open/muted markers
  for (let s = 0; s < numStrings; s++) {
    const x = padX + s * stringGap;
    const f = frets[s];
    if (f < 0) {
      // Muted X
      lines.push(`<text x="${x}" y="${padTop - 5}" font-size="9" text-anchor="middle" fill="currentColor" font-family="IBM Plex Mono, monospace">×</text>`);
    } else if (f === 0) {
      // Open O
      lines.push(`<circle cx="${x}" cy="${padTop - 8}" r="3" fill="none" stroke="currentColor" stroke-width="1.3" />`);
    } else {
      const clampedF = Math.min(numFrets, Math.max(1, f));
      const y = padTop + (clampedF - 0.5) * fretGap;
      lines.push(`<circle cx="${x}" cy="${y}" r="3.8" fill="currentColor" />`);
    }
  }

  return `
    <button type="button" class="chord-card" data-chord="${esc(chordName)}" title="Chord diagram: ${esc(chordName)}">
      <div class="chord-card-name">${esc(chordName)}</div>
      <svg class="chord-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-label="${esc(chordName)} chord diagram">
        ${lines.join("")}
      </svg>
    </button>
  `;
}

/**
 * Transform a chord token according to current view settings:
 * - semitoneDelta: integer transpose shift
 * - targetKey: key string for spelling
 * - accidentalPref: "auto" | "sharps" | "flats"
 * - nashville: boolean
 */
export function formatDisplayChord(chordStr, { semitoneDelta = 0, targetKey = "G", accidentalPref = "auto", nashville = false } = {}) {
  if (!chordStr) return "";
  const parsed = parseChord(chordStr);
  if (!parsed) return chordStr;
  const transposed = semitoneDelta !== 0 || accidentalPref !== "auto"
    ? transposeChord(chordStr, semitoneDelta, targetKey, accidentalPref)
    : chordStr;
  if (nashville) {
    return toNashville(transposed, targetKey);
  }
  return transposed;
}

/**
 * Render one song section (left column: section header + chords-over-lyrics; right column: sidebar margin rail).
 */
// Chords are monospace at 0.9em with 4px of padding; lyric widths are approximated by letter shape.
function estimateChordWidthEm(chord) {
  return chord.length * 0.54 + 0.3;
}

function estimateLyricWidthEm(text) {
  let width = 0;
  for (const ch of text) {
    if (/[ijlt'’.,:;!|]/.test(ch)) width += 0.28;
    else if (/[frI ]/.test(ch)) width += 0.36;
    else if (/[mwMW]/.test(ch)) width += 0.86;
    else width += 0.56;
  }
  return width;
}

export function renderSectionHTML(sec, secIdx, opts = {}) {
  const {
    semitoneDelta = 0,
    targetKey = "G",
    accidentalPref = "auto",
    nashville = false,
    displayStyle = "above", // "above" | "inline" | "lyrics_only" | "chords_only"
    sidebarNotesMap = {},
    editableNotes = true,
    alignMode = false
  } = opts;

  const secKey = `sec-${secIdx}`;
  const customNoteObj = sidebarNotesMap[secKey];
  // A chorus written out again keeps its chords and words but not its margin note.
  const noteText = sec.isRepeatCopy
    ? ""
    : chorusWording(customNoteObj?.text !== undefined ? customNoteObj.text : (sec.sidebarNote || ""));
  const noteKind = customNoteObj?.kind || sec.sidebarKind || "general";

  const KIND_LABELS = {
    dynamic: "Dynamic",
    key: "Key / Capo",
    cue: "Guitar Cue",
    general: "Note"
  };

  const linesHtml = [];
  (sec.lines || []).forEach((line, lineIdx) => {
    if (line.blank) {
      linesHtml.push(`<div class="lyric-blank"></div>`);
      return;
    }
    if (line.tab !== undefined) {
      linesHtml.push(`<pre class="tab-block"><code>${esc(line.tab)}</code></pre>`);
      return;
    }
    if (line.comment !== undefined) {
      linesHtml.push(`<div class="song-comment">${esc(line.comment)}</div>`);
      return;
    }
    if (!line.segments) return;

    if (displayStyle === "lyrics_only") {
      const lyricOnly = line.segments.map((s) => s.lyric || "").join("").trim();
      if (lyricOnly) {
        linesHtml.push(`<div class="lyric-line is-lyrics-only">${esc(lyricOnly)}</div>`);
      }
      return;
    }

    if (displayStyle === "chords_only") {
      const chordsOnly = line.segments
        .filter((s) => s.chord)
        .map((s) => formatDisplayChord(s.chord, { semitoneDelta, targetKey, accidentalPref, nashville }));
      if (chordsOnly.length) {
        linesHtml.push(
          `<div class="lyric-line is-chords-only">${chordsOnly
            .map((c) => `<span class="chord-pill" data-chord="${esc(c)}">${esc(c)}</span>`)
            .join(" ")}</div>`
        );
      }
      return;
    }

    if (displayStyle === "inline") {
      const inlineParts = line.segments.map((seg) => {
        const dispChord = seg.chord
          ? formatDisplayChord(seg.chord, { semitoneDelta, targetKey, accidentalPref, nashville })
          : "";
        const chordHtml = dispChord
          ? `<button type="button" class="inline-chord" data-chord="${esc(dispChord)}">[${esc(dispChord)}]</button>`
          : "";
        return `${chordHtml}<span class="inline-lyric">${esc(seg.lyric || "")}</span>`;
      });
      linesHtml.push(`<div class="lyric-line is-inline" data-line="${secIdx}-${lineIdx}">${inlineParts.join("")}</div>`);
      return;
    }

    // Default: "above" — inline-block columns where each {chord, lyric} pair stays together across line wraps
    // A chord-only line ending in a count ("[D]   [G] (x2)") shows the count beside the chords,
    // not as a lyric underneath.
    let repeatMark = "";
    const lyricOnly = line.segments.map((s) => s.lyric || "").join("").trim();
    const count = line.segments.some((s) => s.chord) && lyricOnly.match(/^\(?\s*(?:x\s*(\d+)|(\d+)\s*x)\s*\)?$/i);
    if (count) {
      repeatMark = `×${count[1] || count[2]}`;
      line = { ...line, segments: line.segments.map((s) => ({ ...s, lyric: s.chord ? "   " : "" })).filter((s) => s.chord) };
    }
    const hasAnyLyric = line.segments.some((s) => (s.lyric || "").trim().length > 0);
    // Build the line from pieces so it can only wrap between whole words, never inside one.
    const pieces = [];
    line.segments.forEach((seg, segIdx) => {
      const dispChord = seg.chord
        ? formatDisplayChord(seg.chord, { semitoneDelta, targetKey, accidentalPref, nashville })
        : "";
      const rawLyric = seg.lyric || "";
      const lyricToHtml = (text) => (text
        ? esc(text).replace(/ $/g, "&nbsp;").replace(/^ /g, "&nbsp;")
        : (dispChord ? "&nbsp;" : ""));
      const chordOnlyClass = dispChord && !rawLyric.trim() ? " is-chord-only" : "";
      const chordCell = dispChord
        ? (alignMode && hasAnyLyric
            ? `<span class="chord-align-pill" data-sec-idx="${secIdx}" data-line-idx="${lineIdx}" data-seg-idx="${segIdx}">` +
              `<button type="button" class="chord-nudge-btn no-print" data-nudge-dir="-1" data-sec-idx="${secIdx}" data-line-idx="${lineIdx}" data-seg-idx="${segIdx}" title="Nudge ${esc(dispChord)} left 1 word/syllable" aria-label="Nudge ${esc(dispChord)} left">◀</button>` +
              `<button type="button" class="chord-cell" data-chord="${esc(dispChord)}">${esc(dispChord)}</button>` +
              `<button type="button" class="chord-nudge-btn no-print" data-nudge-dir="1" data-sec-idx="${secIdx}" data-line-idx="${lineIdx}" data-seg-idx="${segIdx}" title="Nudge ${esc(dispChord)} right 1 word/syllable" aria-label="Nudge ${esc(dispChord)} right">▶</button>` +
              `</span>`
            : `<button type="button" class="chord-cell" data-chord="${esc(dispChord)}">${esc(dispChord)}</button>`)
        : `<span class="chord-cell is-empty" aria-hidden="true">&nbsp;</span>`;

      const nextLyric = line.segments[segIdx + 1]?.lyric || "";
      const splitsWord = /[\p{L}\p{M}'’]$/u.test(rawLyric) && /^[\p{L}\p{M}'’]/u.test(nextLyric);
      // A sheet can also write the break itself: "crea - " + "tion".
      const heldSyllable = /[\p{L}\p{M}'’]\s*-\s*$/u.test(rawLyric) && /^[\p{L}\p{M}'’]/u.test(nextLyric);
      const continuesWord = splitsWord || heldSyllable;
      // "the Al" + "mighty": the unfinished word travels with the chord that completes it.
      const unfinished = continuesWord
        ? rawLyric.match(heldSyllable ? /^(.*\s)(\S+\s*-\s*)$/su : /^(.*\s)(\S+)$/su)
        : null;
      const leadText = unfinished ? unfinished[1] : rawLyric;

      // When a chord is wider than its syllable it pushes the word apart, so mark the break: a-bide.
      const needsDash = splitsWord && !unfinished && !!dispChord && estimateChordWidthEm(dispChord) > estimateLyricWidthEm(rawLyric) + 0.08;
      const leadCell = hasAnyLyric
        ? (needsDash
            ? `<span class="lyric-cell has-word-break">${lyricToHtml(leadText)}<span class="syllable-dash">-</span></span>`
            : `<span class="lyric-cell">${lyricToHtml(leadText)}</span>`)
        : "";
      // A chord held after the last word stays with that word if the line wraps.
      const nextSeg = line.segments[segIdx + 1];
      const nextIsHeldChord = hasAnyLyric && !!rawLyric.trim() && !!nextSeg?.chord && !(nextSeg.lyric || "").trim();
      const joinsNext = !unfinished && (continuesWord || nextIsHeldChord);
      // A long stretch of words is split into one piece per word, so a line that has to wrap can
      // break between any two words, not only where a chord starts. The chord stays on its word.
      const words = hasAnyLyric ? leadText.match(/\S+\s*/g) : null;
      if (words && words.length > 1 && !needsDash && /^\S/.test(leadText)) {
        const emptyChord = `<span class="chord-cell is-empty" aria-hidden="true">&nbsp;</span>`;
        words.forEach((word, w) => {
          pieces.push({
            html: `<span class="cl-pair${w === 0 ? chordOnlyClass : ""}">${w === 0 ? chordCell : emptyChord}<span class="lyric-cell">${lyricToHtml(word)}</span></span>`,
            joinsNext: w === words.length - 1 ? joinsNext : false
          });
        });
      } else {
        pieces.push({
          html: `<span class="cl-pair${chordOnlyClass}">${chordCell}${leadCell}</span>`,
          joinsNext
        });
      }
      if (unfinished) {
        pieces.push({
          html: `<span class="cl-pair is-word-tail"><span class="chord-cell is-empty" aria-hidden="true">&nbsp;</span><span class="lyric-cell">${esc(unfinished[2]).replace(/ $/g, "&nbsp;")}</span></span>`,
          joinsNext: true
        });
      }
    });

    const segHtml = [];
    let wordRun = [];
    for (const piece of pieces) {
      wordRun.push(piece.html);
      if (!piece.joinsNext) {
        segHtml.push(wordRun.length > 1 ? `<span class="cl-word">${wordRun.join("")}</span>` : wordRun[0]);
        wordRun = [];
      }
    }
    if (wordRun.length) segHtml.push(wordRun.join(""));

    linesHtml.push(
      `<div class="lyric-line${hasAnyLyric ? "" : " is-instrumental-line"}" data-line="${secIdx}-${lineIdx}">${segHtml.join("")}${repeatMark ? `<span class="repeat-mark">${repeatMark}</span>` : ""}</div>`
    );
  });

  // Collect line-level notes as well
  const lineNotesHtml = [];
  (sec.lines || []).forEach((line, lineIdx) => {
    const lineKey = `line-${secIdx}-${lineIdx}`;
    const lnObj = sidebarNotesMap[lineKey];
    const lText = chorusWording(lnObj?.text !== undefined ? lnObj.text : (line.sidebarNote || ""));
    const lKind = lnObj?.kind || line.sidebarKind || "general";
    if (lText) {
      lineNotesHtml.push(`
        <div class="margin-note-card kind-${esc(lKind)}" data-note-target="${esc(lineKey)}">
          <span class="margin-note-badge">${esc(KIND_LABELS[lKind] || "Cue")} (Line ${lineIdx + 1})</span>
          <p class="margin-note-text">${esc(lText)}</p>
        </div>
      `);
    }
  });

  const secNoteHtml = noteText
    ? `
      <div class="margin-note-card kind-${esc(noteKind)}" data-note-target="${esc(secKey)}">
        <div class="margin-note-card-head">
          <span class="margin-note-badge">${esc(KIND_LABELS[noteKind] || "Note")}</span>
          ${editableNotes ? `<button type="button" class="margin-note-edit-btn no-print" data-edit-note="${esc(secKey)}" data-sec-label="${esc(sec.label || "Section")}">Edit</button>` : ""}
        </div>
        <p class="margin-note-text">${esc(noteText)}</p>
      </div>
    `
    : (editableNotes && !sec.isRepeatCopy
        ? `<button type="button" class="add-margin-note-btn no-print" data-edit-note="${esc(secKey)}" data-sec-label="${esc(sec.label || "Section")}" title="Add sidebar cue for ${esc(sec.label || "this section")}">+ Sidebar note</button>`
        : "");

  const isChorus = sec.type === "chorus" || sec.type === "chorus_repeat";
  const showChorusReminder = !isChorus && (opts.showChorusReminder || sec.showChorusReminder) && displayStyle !== "chords_only";

  return `
    <section class="song-section type-${esc(sec.type || "verse")}${isChorus ? " is-chorus" : ""}" data-sec-idx="${secIdx}">
      <div class="section-main-col">
        <div class="section-header-row">
          <h4 class="section-label">${esc(sec.label || "Section")}</h4>
          ${editableNotes && !noteText && !sec.isRepeatCopy ? `<button type="button" class="inline-note-chip no-print" data-edit-note="${esc(secKey)}" data-sec-label="${esc(sec.label || "Section")}">+ Note</button>` : ""}
        </div>
        <div class="section-lines">
          ${linesHtml.join("")}
        </div>
        ${showChorusReminder ? `<div class="verse-chorus-reminder">CHORUS</div>` : ""}
      </div>
      <aside class="section-sidebar-rail${noteText || lineNotesHtml.length ? " has-notes" : ""}" aria-label="Sidebar notes for ${esc(sec.label || "section")}">
        ${secNoteHtml}
        ${lineNotesHtml.join("")}
      </aside>
    </section>
  `;
}

/**
 * Render an entire parsed song model into HTML (ready for Scroll, 1-Sheet, or 2-Sheet container).
 */
export function renderSongBodyHTML(songRow, viewOpts = {}) {
  const parsed = parse(songRow.chordpro || "");
  const baseKey = songRow.key || parsed.meta.key || parsed.meta.inferredKey || "G";
  const semitoneDelta = viewOpts.semitoneDelta ?? (songRow.preferred_transpose || 0);
  const accidentalPref = viewOpts.accidentalPref || songRow.layout_prefs?.accidental_pref || "auto";
  const targetKey = transposeKey(baseKey, semitoneDelta, accidentalPref);
  const compactChorus = viewOpts.compactChorus ?? (songRow.layout_prefs?.compact_chorus || false);
  // "Hide tabs" leaves out guitar tab (riffs, solos) and keeps the chords and words.
  const hideTabs = viewOpts.hideTabs ?? (songRow.layout_prefs?.hide_tabs || false);
  const sidebarNotesMap = songRow.layout_prefs?.sidebar_notes || {};

  // Choruses are written out every time they're sung. "Hide repeated choruses" (or the
  // one-page fit, when space runs out) shortens a repeat to a reminder instead.
  const seenChorusFingerprints = new Set();
  const sectionsToRender = [];
  const shortRepeat = (sec) => ({
    type: "chorus_repeat",
    label: sec.label || "Chorus",
    sidebarNote: "",
    sidebarKind: "general",
    lines: [{ comment: "Repeat Chorus" }]
  });

  parsed.sections.forEach((original, idx) => {
    let sec = original;
    if (hideTabs) {
      if (sec.type === "tab") return;
      if ((sec.lines || []).some((l) => l.tab !== undefined)) {
        sec = { ...sec, lines: sec.lines.filter((l) => l.tab === undefined) };
        if (!sec.lines.length) return;
      }
    }
    if (sec.type === "chorus_repeat") {
      if (!sec.lines?.length) return;
      sectionsToRender.push({ origIdx: idx, sec: compactChorus ? shortRepeat(sec) : sec });
      return;
    }
    if (compactChorus && sec.type === "chorus") {
      const fp = JSON.stringify(sec.lines);
      if (seenChorusFingerprints.has(fp)) {
        sectionsToRender.push({ origIdx: idx, sec: shortRepeat(sec) });
        return;
      }
      seenChorusFingerprints.add(fp);
    }
    sectionsToRender.push({ origIdx: idx, sec });
  });

  // When a sheet prints the chorus only once, it comes back after each later verse or bridge
  // that isn't already followed by a chorus.
  const chorusIndices = [];
  sectionsToRender.forEach((item, i) => {
    if (item.sec.type === "chorus" || item.sec.type === "chorus_repeat") {
      chorusIndices.push(i);
    }
  });
  const firstChorusIdx = chorusIndices.length > 0 ? chorusIndices[0] : -1;
  const chorusAfterEveryVerseNote = /chorus after (each|every) verse/i.test(
    `${songRow.notes || ""} ${parsed.meta.note || ""}`
  );
  const printedChorusIdx = parsed.sections.findIndex((sec) => sec.type === "chorus");
  if (chorusIndices.length === 1 || chorusAfterEveryVerseNote) {
    const expanded = [];
    sectionsToRender.forEach((item, i) => {
      expanded.push(item);
      if (item.sec.type !== "verse" && item.sec.type !== "bridge") return;
      const nextSec = sectionsToRender[i + 1]?.sec;
      const nextIsChorus = nextSec && (nextSec.type === "chorus" || nextSec.type === "chorus_repeat");
      if (nextIsChorus || !(i > firstChorusIdx || chorusAfterEveryVerseNote)) return;
      if (compactChorus || printedChorusIdx < 0) {
        item.showChorusReminder = true;
      } else {
        const chorus = parsed.sections[printedChorusIdx];
        expanded.push({ origIdx: printedChorusIdx, sec: { ...chorus, isRepeatCopy: true } });
      }
    });
    sectionsToRender.splice(0, sectionsToRender.length, ...expanded);
  }

  // Compute unique displayed chords in order
  const distinctChords = [];
  const seenChords = new Set();
  for (const ch of parsed.allChords) {
    const disp = formatDisplayChord(ch, {
      semitoneDelta,
      targetKey,
      accidentalPref,
      nashville: false
    });
    if (disp && !seenChords.has(disp)) {
      seenChords.add(disp);
      distinctChords.push(disp);
    }
  }

  return {
    parsed,
    baseKey,
    targetKey,
    distinctChords,
    sectionsToRender,
    renderSection: (item) =>
      renderSectionHTML(item.sec, item.origIdx, {
        semitoneDelta,
        targetKey,
        accidentalPref,
        nashville: !!viewOpts.nashville,
        displayStyle: viewOpts.displayStyle || "above",
        sidebarNotesMap,
        editableNotes: viewOpts.editableNotes !== false,
        showChorusReminder: !!item.showChorusReminder,
        alignMode: !!viewOpts.alignMode
      })
  };
}
