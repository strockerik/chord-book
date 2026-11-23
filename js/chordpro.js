// Pure ChordPro parser, serializer, standard chords-over-lyrics converter,
// AND ugly single-line paste parser (no DOM, no network).

import {
  parseChord,
  isChord,
  transposeChord,
  transposeKey,
  inferKeyFromChords,
  parseDefineDirective
} from "./chords.js";

const SECTION_START_MAP = {
  "start_of_verse": "verse",
  "sov": "verse",
  "start_of_chorus": "chorus",
  "soc": "chorus",
  "start_of_bridge": "bridge",
  "sob": "bridge",
  "start_of_tab": "tab",
  "sot": "tab",
  "start_of_intro": "intro",
  "start_of_outro": "outro",
  "start_of_instrumental": "instrumental",
  "start_of_pre_chorus": "pre_chorus"
};

const SECTION_END_SET = new Set([
  "end_of_verse", "eov",
  "end_of_chorus", "eoc",
  "end_of_bridge", "eob",
  "end_of_tab", "eot",
  "end_of_intro",
  "end_of_outro",
  "end_of_instrumental",
  "end_of_pre_chorus"
]);

const DEFAULT_SECTION_LABELS = {
  verse: "Verse",
  chorus: "Chorus",
  bridge: "Bridge",
  intro: "Intro",
  outro: "Outro",
  instrumental: "Instrumental",
  pre_chorus: "Pre-Chorus",
  tab: "Tab"
};

/**
 * Parse a ChordPro line like "[G]Walking down the [C]road, [G]friend."
 * into segments: [{ chord: "G", lyric: "Walking down the " }, ...]
 */
export function parseChordProLine(line) {
  const segments = [];
  if (!line) return segments;
  const re = /\[([^\]]+)\]([^\[]*)/g;
  let firstBracket = line.indexOf("[");
  if (firstBracket === -1) {
    return [{ chord: "", lyric: line }];
  }
  if (firstBracket > 0) {
    segments.push({ chord: "", lyric: line.slice(0, firstBracket) });
  }
  let m;
  while ((m = re.exec(line)) !== null) {
    segments.push({
      chord: m[1].trim(),
      lyric: m[2] || ""
    });
  }
  return segments;
}

/**
 * Serialize segments back to a ChordPro line.
 */
export function serializeSegments(segments) {
  if (!segments || !segments.length) return "";
  return segments
    .map((s) => (s.chord ? `[${s.chord}]` : "") + (s.lyric || ""))
    .join("");
}

/**
 * Parse a ChordPro document string into a structured song AST:
 * {
 *   meta: { title, artist, key, capo, tempo, time, tuning, duration, note, defines: {} },
 *   sections: [{ type, label, sidebarNote, sidebarKind, lines: [...] }],
 *   allChords: [...]
 * }
 */
export function parse(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  const rawLines = raw.split("\n");

  const meta = {
    title: "",
    artist: "",
    key: "",
    capo: 0,
    tempo: null,
    time: "",
    tuning: "E A D G B E",
    duration: null,
    note: "",
    defines: {},
    unknownDirectives: []
  };

  const sections = [];
  let currentSection = null;
  let inTab = false;
  let tabBuffer = [];
  let lastChorusSection = null;

  const ensureSection = (type = "verse", label = null) => {
    if (!currentSection) {
      currentSection = {
        type,
        label: label !== null ? label : DEFAULT_SECTION_LABELS[type] || "Verse",
        sidebarNote: "",
        sidebarKind: "general",
        lines: []
      };
      sections.push(currentSection);
    }
    return currentSection;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (inTab) {
      const endMatch = trimmed.match(/^\{\s*(end_of_tab|eot)\s*\}$/i);
      if (endMatch) {
        const sec = ensureSection("tab", "Tab");
        sec.lines.push({ tab: tabBuffer.join("\n") });
        tabBuffer = [];
        inTab = false;
        if (sec.type === "tab") currentSection = null;
        continue;
      }
      tabBuffer.push(line);
      continue;
    }

    // Directive {name: value} or {name}
    const dirMatch = trimmed.match(/^\{\s*([a-zA-Z0-9_-]+)(?:\s*:\s*(.*?))?\s*\}$/);
    if (dirMatch) {
      const rawName = dirMatch[1];
      const name = rawName.toLowerCase();
      const val = (dirMatch[2] || "").trim();

      if (name === "title" || name === "t") {
        meta.title = val;
        continue;
      }
      if (name === "subtitle" || name === "st" || name === "artist") {
        meta.artist = val;
        continue;
      }
      if (name === "key") {
        meta.key = val;
        continue;
      }
      if (name === "capo") {
        meta.capo = parseInt(val, 10) || 0;
        continue;
      }
      if (name === "tempo") {
        meta.tempo = parseInt(val, 10) || null;
        continue;
      }
      if (name === "time") {
        meta.time = val;
        continue;
      }
      if (name === "tuning") {
        meta.tuning = val || "E A D G B E";
        continue;
      }
      if (name === "duration") {
        meta.duration = parseInt(val, 10) || null;
        continue;
      }
      if (name === "meta_note" || name === "song_note") {
        meta.note = val;
        continue;
      }
      if (name === "define") {
        const def = parseDefineDirective(val);
        if (def) meta.defines[def.name] = def.voicing;
        continue;
      }
      if (name in SECTION_START_MAP) {
        const secType = SECTION_START_MAP[name];
        if (secType === "tab") {
          inTab = true;
          tabBuffer = [];
          currentSection = {
            type: "tab",
            label: val || "Tab",
            sidebarNote: "",
            sidebarKind: "general",
            lines: [],
            explicitDirective: rawName,
            explicitLabel: val
          };
          sections.push(currentSection);
          continue;
        }
        currentSection = {
          type: secType,
          label: val || DEFAULT_SECTION_LABELS[secType] || "Section",
          sidebarNote: "",
          sidebarKind: "general",
          lines: [],
          explicitDirective: rawName,
          explicitLabel: val
        };
        sections.push(currentSection);
        if (secType === "chorus") lastChorusSection = currentSection;
        continue;
      }
      if (SECTION_END_SET.has(name)) {
        if (currentSection) {
          currentSection.endDirective = rawName;
        }
        currentSection = null;
        continue;
      }
      if (name === "chorus") {
        sections.push({
          type: "chorus_repeat",
          label: val || (lastChorusSection ? lastChorusSection.label : "Chorus"),
          sidebarNote: "",
          sidebarKind: "general",
          lines: lastChorusSection ? lastChorusSection.lines.map((l) => ({ ...l })) : [],
          isRepeatDirective: true,
          explicitLabel: val
        });
        currentSection = null;
        continue;
      }
      if (name === "note" || name === "sidebar") {
        // Format: {note: [dynamic] Start quiet and build} or {note: Start quiet}
        let noteKind = "general";
        let noteText = val;
        const km = val.match(/^\[([a-zA-Z_-]+)\]\s*(.*)$/);
        if (km) {
          noteKind = km[1].toLowerCase();
          noteText = km[2];
        }
        const sec = ensureSection("verse", "Verse");
        if (!sec.sidebarNote && sec.lines.length === 0) {
          sec.sidebarNote = noteText;
          sec.sidebarKind = noteKind;
        } else if (sec.lines.length > 0) {
          const lastLine = sec.lines[sec.lines.length - 1];
          lastLine.sidebarNote = noteText;
          lastLine.sidebarKind = noteKind;
        } else {
          sec.sidebarNote = (sec.sidebarNote ? sec.sidebarNote + " • " : "") + noteText;
          sec.sidebarKind = noteKind;
        }
        continue;
      }
      if (name === "comment" || name === "c") {
        const sec = ensureSection("verse", "Verse");
        sec.lines.push({ comment: val, rawDirective: rawName });
        continue;
      }

      // Unknown directive: preserve on current section or meta so round-trip never drops it
      if (currentSection) {
        currentSection.lines.push({ directive: trimmed });
      } else {
        meta.unknownDirectives.push(trimmed);
      }
      continue;
    }

    // Blank line outside section
    if (!trimmed) {
      if (currentSection && currentSection.lines.length > 0 && !currentSection.explicitDirective) {
        currentSection = null;
      } else if (currentSection && currentSection.explicitDirective) {
        currentSection.lines.push({ blank: true });
      }
      continue;
    }

    // Bracketed section header in raw ChordPro like [Verse 1] or [Chorus] on its own line
    const bracketHeader = parseStandaloneSectionHeader(trimmed);
    if (bracketHeader) {
      currentSection = {
        type: bracketHeader.type,
        label: bracketHeader.label,
        sidebarNote: "",
        sidebarKind: "general",
        lines: []
      };
      sections.push(currentSection);
      if (bracketHeader.type === "chorus") lastChorusSection = currentSection;
      continue;
    }

    const sec = ensureSection("verse", "Verse");
    sec.lines.push({
      segments: parseChordProLine(line)
    });
  }

  if (inTab && tabBuffer.length) {
    const sec = ensureSection("tab", "Tab");
    sec.lines.push({ tab: tabBuffer.join("\n") });
  }

  // Gather all chords in order of first appearance
  const allChords = [];
  const seen = new Set();
  for (const sec of sections) {
    for (const l of sec.lines || []) {
      if (l.segments) {
        for (const seg of l.segments) {
          if (seg.chord && parseChord(seg.chord) && !parseChord(seg.chord).isNC && !seen.has(seg.chord)) {
            seen.add(seg.chord);
            allChords.push(seg.chord);
          }
        }
      }
    }
  }

  if (!meta.key && allChords.length) {
    meta.inferredKey = inferKeyFromChords(allChords);
  }

  if (meta.note) meta.note = chorusWording(meta.note);
  for (const sec of sections) {
    sec.label = chorusWording(sec.label);
    if (sec.explicitLabel !== undefined) sec.explicitLabel = chorusWording(sec.explicitLabel);
    if (sec.sidebarNote) sec.sidebarNote = chorusWording(sec.sidebarNote);
    for (const l of sec.lines || []) {
      if (l.sidebarNote) l.sidebarNote = chorusWording(l.sidebarNote);
      if (l.comment !== undefined) l.comment = chorusWording(l.comment);
    }
  }

  return { meta, sections, allChords };
}

// "Chorus" is the app's one word for this section. Only labels and notes pass through here,
// so a lyric or title that uses the word "refrain" is left alone.
export function chorusWording(text) {
  return String(text ?? "").replace(/\brefrain\b/gi, (word) => {
    if (word === word.toUpperCase()) return "CHORUS";
    return word[0] === "R" ? "Chorus" : "chorus";
  });
}

export function chorusWordingInChordPro(text) {
  const labelOrNote = /^\s*\{\s*(start_of_\w+|so[cvb]|chorus|note|meta_note|song_note|comment|c)\s*[:}]/i;
  return String(text ?? "")
    .split("\n")
    .map((line) => (labelOrNote.test(line) || parseStandaloneSectionHeader(line) ? chorusWording(line) : line))
    .join("\n");
}

/**
 * Serialize a parsed model back into canonical ChordPro text.
 */
export function serialize(model) {
  if (!model) return "";
  const { meta = {}, sections = [] } = model;
  const out = [];

  if (meta.title) out.push(`{title: ${meta.title}}`);
  if (meta.artist) out.push(`{artist: ${meta.artist}}`);
  if (meta.key) out.push(`{key: ${meta.key}}`);
  if (meta.capo && Number(meta.capo) > 0) out.push(`{capo: ${meta.capo}}`);
  if (meta.tempo) out.push(`{tempo: ${meta.tempo}}`);
  if (meta.time) out.push(`{time: ${meta.time}}`);
  if (meta.tuning && meta.tuning !== "standard" && meta.tuning !== "E A D G B E") {
    out.push(`{tuning: ${meta.tuning}}`);
  }
  if (meta.duration) out.push(`{duration: ${meta.duration}}`);
  if (meta.note) out.push(`{meta_note: ${meta.note}}`);

  if (meta.defines) {
    for (const [name, v] of Object.entries(meta.defines)) {
      const fStr = (v.frets || []).map((f) => (f < 0 ? "x" : String(f))).join(" ");
      out.push(`{define: ${name} base-fret ${v.baseFret || 1} frets ${fStr}}`);
    }
  }
  if (meta.unknownDirectives) {
    for (const d of meta.unknownDirectives) out.push(d);
  }

  if (out.length > 0 && sections.length > 0) out.push("");

  sections.forEach((sec, idx) => {
    if (sec.isRepeatDirective || sec.type === "chorus_repeat") {
      out.push(sec.explicitLabel ? `{chorus: ${sec.explicitLabel}}` : `{chorus}`);
      if (idx < sections.length - 1) out.push("");
      return;
    }

    const startTag = sec.explicitDirective || `start_of_${sec.type || "verse"}`;
    const endTag = sec.endDirective || (
      startTag.startsWith("so") && startTag.length === 3
        ? "eo" + startTag.slice(2)
        : `end_of_${sec.type || "verse"}`
    );

    const hasCustomLabel = sec.explicitLabel !== undefined
      ? sec.explicitLabel !== ""
      : (sec.label && sec.label !== DEFAULT_SECTION_LABELS[sec.type]);

    if (hasCustomLabel) {
      out.push(`{${startTag}: ${sec.explicitLabel !== undefined ? sec.explicitLabel : sec.label}}`);
    } else {
      out.push(`{${startTag}}`);
    }

    if (sec.sidebarNote) {
      const kindPrefix = sec.sidebarKind && sec.sidebarKind !== "general" ? `[${sec.sidebarKind}] ` : "";
      out.push(`{note: ${kindPrefix}${sec.sidebarNote}}`);
    }

    for (const l of sec.lines || []) {
      if (l.blank) {
        out.push("");
      } else if (l.tab !== undefined) {
        out.push(l.tab);
      } else if (l.comment !== undefined) {
        const cTag = l.rawDirective || "comment";
        out.push(`{${cTag}: ${l.comment}}`);
      } else if (l.directive !== undefined) {
        out.push(l.directive);
      } else if (l.segments) {
        out.push(serializeSegments(l.segments));
      }
      if (l.sidebarNote) {
        const kindPrefix = l.sidebarKind && l.sidebarKind !== "general" ? `[${l.sidebarKind}] ` : "";
        out.push(`{note: ${kindPrefix}${l.sidebarNote}}`);
      }
    }

    out.push(`{${endTag}}`);
    if (idx < sections.length - 1) out.push("");
  });

  return out.join("\n");
}

/**
 * Transpose an entire ChordPro text by `semitones` and return the new ChordPro text.
 */
export function transposeChordPro(chordproText, semitones, targetKeyOverride = null, preference = "auto") {
  const model = parse(chordproText);
  const baseKey = model.meta.key || model.meta.inferredKey || "G";
  const newKey = targetKeyOverride || transposeKey(baseKey, semitones, preference);
  if (model.meta.key) {
    model.meta.key = newKey;
  }
  for (const sec of model.sections) {
    for (const l of sec.lines || []) {
      if (l.segments) {
        for (const seg of l.segments) {
          if (seg.chord && parseChord(seg.chord)) {
            seg.chord = transposeChord(seg.chord, semitones, newKey, preference);
          }
        }
      }
    }
  }
  return serialize(model);
}

// ============================================================================
// Section header helpers
// ============================================================================
const SECTION_NAME_RE = /^(intro|verse|chorus|refrain|bridge|pre-?chorus|outro|ending|interlude|instrumental|solo|tag|vamp|coda|hook)(?:\s*(\d+|[A-Za-z]))?$/i;

export function parseStandaloneSectionHeader(line) {
  if (!line) return null;
  const trimmed = line.trim();
  // [Verse 1], [Chorus], (Chorus), Verse 1:, CHORUS
  const m = trimmed.match(/^(?:\[([A-Za-z0-9\s-]+)\]|\(([A-Za-z0-9\s-]+)\)|([A-Za-z0-9\s-]+):|([A-Z\s0-9-]{3,20}))$/);
  if (!m) return null;
  const inner = (m[1] || m[2] || m[3] || m[4] || "").trim();
  // Ensure `[G]` is not treated as a section header!
  if (isChord(inner)) return null;
  const sm = inner.match(SECTION_NAME_RE);
  if (!sm) return null;
  const kindRaw = sm[1].toLowerCase().replace("-", "_");
  const num = sm[2] ? " " + sm[2] : "";
  let type = "verse";
  if (kindRaw === "chorus" || kindRaw === "refrain" || kindRaw === "hook") type = "chorus";
  else if (kindRaw === "bridge" || kindRaw === "tag" || kindRaw === "coda") type = "bridge";
  else if (kindRaw === "intro") type = "intro";
  else if (kindRaw === "outro" || kindRaw === "ending") type = "outro";
  else if (kindRaw === "pre_chorus" || kindRaw === "prechorus") type = "pre_chorus";
  else if (kindRaw === "instrumental" || kindRaw === "interlude" || kindRaw === "solo") type = "instrumental";
  const label = inner.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return { type, label: chorusWording(label) || (DEFAULT_SECTION_LABELS[type] + num) };
}

/**
 * Determine whether a line in a standard tab is a "chord line"
 * (every token is a chord, bar line `|`, repeat `x2`, `(x2)`, or slash `/`).
 */
export function isChordLine(line) {
  if (!line || !line.trim()) return false;
  const trimmed = line.trim();
  if (/^[eBGDAE]\|[-0-9hpb/\\~x]+/.test(trimmed)) return false; // guitar tab line
  // Strip bar lines and repeat markers
  const tokens = trimmed
    .replace(/\|+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return false;

  let chordCount = 0;
  for (const tok of tokens) {
    if (/^(?:\(?x\d+\)?|\d+x|\/+|%|-+|\.\.\.)$/i.test(tok)) continue;
    const clean = tok.replace(/^[([)]+|[)\],.;]+$/g, "");
    if (!clean) continue;
    if (isChord(clean)) {
      chordCount++;
    } else {
      return false;
    }
  }
  return chordCount > 0;
}

/**
 * Merge a chord line with a lyric line underneath it by column position (SPEC 5.2).
 */
export function mergeChordAndLyricLines(chordLine, lyricLine) {
  const chordPositions = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(chordLine)) !== null) {
    const rawTok = m[0];
    if (rawTok === "|") continue;
    const clean = rawTok.replace(/^[([)]+|[)\]]+$/g, "");
    if (isChord(clean) || /^(?:x\d+|\d+x)$/i.test(clean)) {
      chordPositions.push({ chord: clean, col: m.index });
    }
  }

  if (!lyricLine || !lyricLine.trim()) {
    return chordPositions.map((c) => `[${c.chord}]`).join(" ");
  }

  const maxCol = chordPositions.length ? chordPositions[chordPositions.length - 1].col : 0;
  let paddedLyric = lyricLine;
  if (paddedLyric.length < maxCol) {
    paddedLyric = paddedLyric.padEnd(maxCol, " ");
  }

  // Insert from right to left so column offsets stay accurate
  let result = paddedLyric;
  for (let i = chordPositions.length - 1; i >= 0; i--) {
    const { chord, col } = chordPositions[i];
    const pos = Math.min(col, result.length);
    result = result.slice(0, pos) + `[${chord}]` + result.slice(pos);
  }
  return result.replace(/\s+$/, "");
}

/**
 * Import standard multi-line "chords over lyrics" plain text into ChordPro.
 */
export function fromChordsOverLyrics(text) {
  const cleaned = cleanPasteNoise(text);
  const lines = cleaned.split("\n");

  const meta = {
    title: "",
    artist: "",
    key: "",
    capo: 0,
    tuning: "E A D G B E",
    note: ""
  };

  let idx = 0;
  // Extract header metadata lines at the top if present
  while (idx < lines.length && idx < 10) {
    const l = lines[idx].trim();
    if (!l) { idx++; continue; }
    const tuningMatch = l.match(/Tuning:\s*([EADGBe#b\s]+)/i);
    const capoMatch = l.match(/Capo:\s*(\d+|no capo)/i);
    if (tuningMatch || capoMatch) {
      if (tuningMatch) meta.tuning = tuningMatch[1].trim().replace(/\s+/g, " ");
      if (capoMatch && /\d+/.test(capoMatch[1])) meta.capo = parseInt(capoMatch[1], 10);
      idx++;
      continue;
    }
    const keyMatch = l.match(/^Key:\s*([A-G][#b]?m?)\b/i);
    if (keyMatch) {
      meta.key = keyMatch[1];
      idx++;
      continue;
    }
    if (!meta.title && !parseStandaloneSectionHeader(l) && !isChordLine(l) && !l.startsWith("{")) {
      const dashParts = l.split(/\s+[-–—]\s+|\s+by\s+/i);
      if (dashParts.length === 2 && dashParts[0].length < 60 && dashParts[1].length < 50) {
        meta.title = dashParts[0].replace(/\s+chords$/i, "").trim();
        meta.artist = dashParts[1].trim();
        idx++;
        continue;
      }
    }
    if (l.startsWith("(") && l.endsWith(")") && idx < 6) {
      meta.note = l.slice(1, -1).trim();
      idx++;
      continue;
    }
    break;
  }

  const sections = [];
  let currentSec = null;
  const ensureSec = (type = "verse", label = "Verse") => {
    if (!currentSec) {
      currentSec = { type, label, sidebarNote: "", sidebarKind: "general", lines: [] };
      sections.push(currentSec);
    }
    return currentSec;
  };

  let tabLines = [];
  const flushTab = () => {
    if (tabLines.length) {
      const s = { type: "tab", label: "Tab", sidebarNote: "", sidebarKind: "general", lines: [{ tab: tabLines.join("\n") }] };
      sections.push(s);
      tabLines = [];
      currentSec = null;
    }
  };

  for (let i = idx; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^[eBGDAE]\|[-0-9hpb/\\~x|]+/.test(trimmed)) {
      tabLines.push(line);
      continue;
    } else if (tabLines.length) {
      flushTab();
    }

    if (!trimmed) {
      continue;
    }

    const header = parseStandaloneSectionHeader(trimmed);
    if (header) {
      currentSec = {
        type: header.type,
        label: header.label,
        sidebarNote: "",
        sidebarKind: "general",
        lines: []
      };
      sections.push(currentSec);
      continue;
    }

    if (isChordLine(line)) {
      // Check next line
      const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
      const nextTrimmed = (nextLine || "").trim();
      if (
        nextTrimmed &&
        !isChordLine(nextLine) &&
        !parseStandaloneSectionHeader(nextTrimmed) &&
        !/^[eBGDAE]\|/.test(nextTrimmed)
      ) {
        const merged = mergeChordAndLyricLines(line, nextLine);
        ensureSec().lines.push({ segments: parseChordProLine(merged) });
        i++; // consumed nextLine
      } else {
        // Chord-only instrumental line
        const merged = mergeChordAndLyricLines(line, "");
        ensureSec().lines.push({ segments: parseChordProLine(merged) });
      }
      continue;
    }

    // Plain lyric or comment line
    if (trimmed.startsWith("(") && trimmed.endsWith(")") && !meta.note && sections.length === 0) {
      meta.note = trimmed.slice(1, -1);
      continue;
    }
    ensureSec().lines.push({ segments: parseChordProLine(trimmed) });
  }
  flushTab();

  // Infer key from parsed chords
  const allChords = [];
  for (const s of sections) {
    for (const l of s.lines) {
      for (const seg of l.segments || []) {
        if (seg.chord && isChord(seg.chord)) allChords.push(seg.chord);
      }
    }
  }
  if (!meta.key && allChords.length) {
    meta.key = inferKeyFromChords(allChords);
  }

  return serialize({ meta, sections });
}

/**
 * Strip Ultimate Guitar markdown links, UI buttons ("Autoscroll", "Transpose", etc.)
 */
function cleanPasteNoise(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    // Convert markdown links like [E A D G B E](https://...) to inner text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1 ")
    // Remove common UG copy-paste chrome lines
    .replace(/^\s*(?:Autoscroll|Simplify|Transpose|Create correction|Report bad tab|Print)\s*$/gim, "");
}

/**
 * Specifically engineered for collapsed single-line / ugly pastes like:
 * `Tuning: [E A D G B E](...)Capo: Song Title - Artist (a note...) [Intro] C G C G [Verse] G G/B C G First lyric line. C Dsus4 D G Second lyric line...`
 */
export function fromUglyPaste(text) {
  let raw = cleanPasteNoise(text).trim();

  const meta = {
    title: "",
    artist: "",
    key: "",
    capo: 0,
    tuning: "E A D G B E",
    note: ""
  };

  // 1. Extract Tuning & Capo from top header even if glued together
  const tuningRe = /Tuning:\s*([EADGBe#b](?:\s+[EADGBe#b]){5})/i;
  const tm = raw.match(tuningRe);
  if (tm) {
    meta.tuning = tm[1].trim().replace(/\s+/g, " ");
    raw = raw.replace(tm[0], " ").trim();
  }

  const capoRe = /Capo:\s*(?:(\d+)(?:st|nd|rd|th)?\s*fret\b|no\s*capo)?/i;
  const cm = raw.match(capoRe);
  if (cm) {
    if (cm[1]) meta.capo = parseInt(cm[1], 10) || 0;
    raw = raw.replace(cm[0], " ").trim();
  }

  // 2. Look at text before the first section marker `[Intro]`, `[Verse]`, `[Chorus]`, etc.
  const firstSecRe = /\[(Intro|Verse(?:\s*\d+)?|Chorus|Pre-?Chorus|Bridge|Outro|Instrumental|Interlude|Solo|Tag)\]/i;
  const fsm = raw.match(firstSecRe);
  if (fsm && fsm.index > 0) {
    let preamble = raw.slice(0, fsm.index).trim();
    raw = raw.slice(fsm.index).trim();

    // Extract parenthetical note in preamble like (All throughout the song you can play Cadd9 for C)
    const parenRe = /\(([^)]{10,160})\)/;
    const pm = preamble.match(parenRe);
    if (pm) {
      meta.note = pm[1].trim();
      preamble = preamble.replace(pm[0], " ").trim();
    }

    // Extract Title - Artist from remaining preamble
    const titleLine = preamble.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    if (titleLine) {
      const parts = titleLine.split(/\s+[-–—]\s+|\s+by\s+/i);
      if (parts.length >= 2) {
        meta.title = parts[0].replace(/\s+chords$/i, "").trim();
        meta.artist = parts.slice(1).join(" - ").trim();
      } else {
        meta.title = titleLine.replace(/\s+chords$/i, "").trim();
      }
    }
  }

  // 3. Split into sections on `[Intro]`, `[Verse]`, `[Chorus]`, `[Bridge]`, etc.
  const secSplitRe = /\[(Intro|Verse(?:\s*\d+)?|Chorus(?:\s*\d+)?|Pre-?Chorus|Bridge|Outro|Instrumental|Interlude|Solo|Tag)\]/gi;
  const chunks = [];
  let lastIndex = 0;
  let match;
  let currentHeader = { type: "verse", label: "Verse" };

  while ((match = secSplitRe.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const body = raw.slice(lastIndex, match.index).trim();
      if (body) chunks.push({ header: currentHeader, body });
    }
    const parsedH = parseStandaloneSectionHeader(`[${match[1]}]`) || { type: "verse", label: match[1] };
    currentHeader = parsedH;
    lastIndex = secSplitRe.lastIndex;
  }
  const tailBody = raw.slice(lastIndex).trim();
  if (tailBody) {
    chunks.push({ header: currentHeader, body: tailBody });
  }

  // Number multiple [Verse] sections automatically (Verse 1, Verse 2)
  const verseCountTotal = chunks.filter((c) => c.header.type === "verse" && /^verse$/i.test(c.header.label)).length;
  let verseIdx = 0;

  const sections = [];
  const allChords = [];

  for (const chunk of chunks) {
    let label = chunk.header.label;
    if (chunk.header.type === "verse" && /^verse$/i.test(label) && verseCountTotal > 1) {
      verseIdx++;
      label = `Verse ${verseIdx}`;
    }

    const lines = parseCollapsedSectionBody(chunk.body);
    for (const l of lines) {
      for (const seg of l.segments || []) {
        if (seg.chord && isChord(seg.chord)) allChords.push(seg.chord);
      }
    }

    sections.push({
      type: chunk.header.type,
      label,
      sidebarNote: "",
      sidebarKind: "general",
      lines
    });
  }

  if (!meta.key && allChords.length) {
    meta.key = inferKeyFromChords(allChords);
  }

  // Add helpful sidebar note from preamble note if present
  if (meta.note && sections.length > 0 && !sections[0].sidebarNote) {
    sections[0].sidebarNote = meta.note;
    sections[0].sidebarKind = "cue";
  }

  return serialize({ meta, sections });
}

/**
 * Given a collapsed section body like:
 * `G G/B C G First lyric line. C Dsus4 D G Second lyric line.`
 * Splits it into alternating (chord cluster -> lyric phrase) pairs and aligns the chords over the phrase words!
 */
function parseCollapsedSectionBody(bodyText) {
  const tokens = bodyText.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!tokens.length) return [];

  // Group tokens into runs of chords vs runs of lyric words.
  // Special care for "A" or "Am" or "I":
  // - Inside a chord run (or right at the start of a line/after sentence punctuation),
  //   a token that parses as a chord is treated as a chord IF:
  //   (a) it is not the ambiguous word "A" or "Am", OR
  //   (b) it is adjacent to an unambiguous chord (like G/B, Dsus4, Am7, C, D, G, Em).
  const isUnambiguousChord = (tok) => {
    // Strip trailing punctuation only if not part of chord
    if (/[.,!?;:]$/.test(tok)) return false;
    if (tok === "A" || tok === "Am" || tok === "I") return false;
    return isChord(tok);
  };

  const tokenTypes = tokens.map((tok, i) => {
    if (isUnambiguousChord(tok)) return "chord";
    if (tok === "Am" || tok === "A") {
      const prev = tokens[i - 1] || "";
      const next = tokens[i + 1] || "";
      const prevIsChord = isUnambiguousChord(prev);
      const nextIsChord = isUnambiguousChord(next);
      if (prevIsChord || nextIsChord) return "chord";
    }
    return "lyric";
  });

  // Second pass: if "Am" or "A" is adjacent to a chord run, mark it chord
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i] === "Am" || tokens[i] === "A") && tokenTypes[i] === "lyric") {
      if (tokenTypes[i + 1] === "chord" || tokenTypes[i - 1] === "chord") {
        tokenTypes[i] = "chord";
      }
    }
  }

  // Group into alternating blocks: [{ chords: [...], words: [...] }]
  const phrases = [];
  let curChords = [];
  let curWords = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const kind = tokenTypes[i];
    if (kind === "chord") {
      if (curWords.length > 0) {
        phrases.push({ chords: curChords, words: curWords });
        curChords = [];
        curWords = [];
      }
      curChords.push(t);
    } else {
      curWords.push(t);
    }
  }
  if (curChords.length > 0 || curWords.length > 0) {
    phrases.push({ chords: curChords, words: curWords });
  }

  return phrases.map(({ chords, words }) => {
    if (!words.length) {
      // Instrumental / chord-only line
      return {
        segments: chords.map((c) => ({ chord: c, lyric: "  " }))
      };
    }
    if (!chords.length) {
      return {
        segments: [{ chord: "", lyric: words.join(" ") }]
      };
    }
    return {
      segments: distributeChordsAcrossWords(chords, words)
    };
  });
}

/**
 * Intelligently place a list of chords across the words of a single lyric phrase.
 * E.g. chords: ["G", "G/B", "C", "G"], words: ["Thank", "you", "for", "the", "cross,", "Lord."]
 */
function distributeChordsAcrossWords(chords, words) {
  const nChords = chords.length;
  const nWords = words.length;

  if (nChords === 1) {
    return [{ chord: chords[0], lyric: words.join(" ") }];
  }

  // Map each chord index to a word index (or trailing slot if more chords than words)
  const wordChords = new Array(nWords).fill(null).map(() => []);
  const trailingChords = [];

  if (nChords <= nWords) {
    // Spread chords evenly across words
    for (let c = 0; c < nChords; c++) {
      const wIdx = Math.min(nWords - 1, Math.round((c * (nWords - 1)) / Math.max(1, nChords - 1)));
      wordChords[wIdx].push(chords[c]);
    }
  } else {
    for (let c = 0; c < nWords; c++) {
      wordChords[c].push(chords[c]);
    }
    for (let c = nWords; c < nChords; c++) {
      trailingChords.push(chords[c]);
    }
  }

  const segments = [];
  let currentChord = "";
  let currentWords = [];

  for (let w = 0; w < nWords; w++) {
    const assigned = wordChords[w];
    if (assigned.length > 0) {
      if (currentWords.length > 0 || currentChord) {
        segments.push({
          chord: currentChord,
          lyric: currentWords.join(" ") + (currentWords.length ? " " : "")
        });
        currentWords = [];
      }
      // If multiple chords assigned to same word
      for (let k = 0; k < assigned.length - 1; k++) {
        segments.push({ chord: assigned[k], lyric: " " });
      }
      currentChord = assigned[assigned.length - 1];
      currentWords.push(words[w]);
    } else {
      currentWords.push(words[w]);
    }
  }

  if (currentWords.length > 0 || currentChord) {
    segments.push({
      chord: currentChord,
      lyric: currentWords.join(" ") + (trailingChords.length ? " " : "")
    });
  }

  for (const tc of trailingChords) {
    segments.push({ chord: tc, lyric: " " });
  }

  return segments;
}

/**
 * Smart auto-detector for any pasted text:
 * - Already ChordPro (`{title:...}` or inline `[G]lyric`) -> normalizes & returns
 * - Collapsed single-line ugly paste -> `fromUglyPaste`
 * - Multi-line chords-over-lyrics -> `fromChordsOverLyrics`
 */
export function smartImportText(text) {
  const raw = String(text || "").trim();
  if (!raw) return { chordpro: "", format: "empty" };

  // 1. Check if it already contains ChordPro directives or inline `[Chord]word`
  if (/^\s*\{(title|t|start_of_verse|sov|start_of_chorus|soc|key)\s*:/im.test(raw)) {
    return { chordpro: serialize(parse(raw)), format: "chordpro" };
  }
  // Inline [G]Thank you (where bracket is immediately followed by lowercase letter)
  if (/\[[A-G][#b]?[^\]]*\]\w/.test(raw) && raw.split("\n").length > 3) {
    return { chordpro: serialize(parse(raw)), format: "chordpro" };
  }

  // 2. Check if it's a collapsed ugly paste (few lines, inline [Intro]/[Verse]/[Chorus], or long lines mixing chords and lyrics)
  const nonEmptyLines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hasInlineSections = /\[(Intro|Verse|Chorus|Bridge)\]\s+[A-G]/i.test(raw);
  const avgLineLen = raw.length / Math.max(1, nonEmptyLines.length);

  if (hasInlineSections || (nonEmptyLines.length <= 4 && avgLineLen > 120)) {
    return { chordpro: fromUglyPaste(raw), format: "ugly_paste" };
  }

  // 3. Standard multi-line chords over lyrics
  return { chordpro: fromChordsOverLyrics(raw), format: "chords_over_lyrics" };
}

// Common weak pickup words at the start of a line where an ugly paste often drops the first downbeat chord
const PICKUP_WORDS = new Set([
  "the", "a", "an", "and", "in", "of", "to", "for", "on", "at", "by", "with", "from", "as", "but", "or", "is"
]);

// True when a chord lands between two syllables rather than inside one.
function isSyllableBreak(before, after) {
  const left = before.toLowerCase();
  const right = after.toLowerCase();
  if (!/[aeiouy]/.test(left) || !/[aeiouy]/.test(right)) return false;
  if (/^[^aeiouy]*e$/.test(right) && !/^[^aeiouy]*le$/.test(right)) return false; // silent e: pla|ce
  if (/^(ed|es)$/.test(right)) return false;
  if (/^[^aeiouy]*[^aeiouytd]ed$/.test(right)) return false; // wa|lked
  if (/^[^aeiouy]*[^aeiouysxzc]es$/.test(right)) return false; // ti|mes
  const seam = left.slice(-1) + right[0];
  return !["ou", "ee", "oo", "ai", "oa", "au", "ei", "oi"].includes(seam);
}

/**
 * Layer 1 Quality Check: Deterministic Chord-to-Word Alignment Auditor & Auto-Fixer.
 * Scans a ChordPro string for:
 * 1. Chords that split a single syllable (`wa[G]lked`, `pla[C]ce`). A chord on a real syllable (`a[G]bide`) is correct.
 * 2. Redundant consecutive identical chords on a lyric line (`[E]Sing it, sing it, [E]once a[F#m]gain`).
 * 3. Weak pickup-word downbeats (`[D]The lantern of...`) where the opening chord belongs on the first content word (`The [D]lantern of...`).
 * 4. Hanging punctuation chords (`paid.[G]Word` -> `paid. [G]Word`).
 * 5. Cross-verse harmonic rhythm mismatches across Verse 1, Verse 2, Verse 3.
 */
export function auditChordAlignment(chordproText) {
  const raw = String(chordproText || "");
  if (!raw.trim()) {
    return { issues: [], fixedChordpro: raw, issueCount: 0 };
  }

  const lines = raw.split(/\r?\n/);
  const issues = [];
  const fixedLines = [];
  let currentSecLabel = "Sheet";
  let currentSecType = "verse";
  let inTab = false;

  for (let i = 0; i < lines.length; i++) {
    const origLine = lines[i];
    const trimmed = origLine.trim();

    if (/^\{start_of_tab\b|^\{sot\b/i.test(trimmed)) {
      inTab = true;
      fixedLines.push(origLine);
      continue;
    }
    if (/^\{end_of_tab\b|^\{eot\b/i.test(trimmed)) {
      inTab = false;
      fixedLines.push(origLine);
      continue;
    }
    if (inTab) {
      fixedLines.push(origLine);
      continue;
    }

    const secMatch = trimmed.match(/^\{(?:start_of_([a-z_]+)|so([vc]))(?::\s*([^}]+))?\}/i);
    if (secMatch) {
      currentSecType = (secMatch[1] || (secMatch[2] === "c" ? "chorus" : "verse")).toLowerCase();
      currentSecLabel = (secMatch[3] || currentSecType).trim();
      fixedLines.push(origLine);
      continue;
    }

    if (!trimmed || trimmed.startsWith("{") || !trimmed.includes("[")) {
      fixedLines.push(origLine);
      continue;
    }

    // Check if this is a lyric line (contains letters outside [Chord] brackets)
    const lyricOnly = trimmed.replace(/\[[^\]]+\]/g, "").trim();
    if (!/[A-Za-z]/.test(lyricOnly)) {
      fixedLines.push(origLine);
      continue;
    }

    let line = origLine;

    // Rule 1: A chord inside one syllable moves to the start of the word: `wa[G]lked` -> `[G]walked`.
    line = line.replace(/(^|[\s"'(])([A-Za-z]{1,3})\[([A-G][#b]?[^\]]*)\]([A-Za-z]{2,})/g, (full, lead, prefix, chord, suffix) => {
      if (!isChord(chord) || isSyllableBreak(prefix, suffix)) return full;
      const word = prefix + suffix;
      issues.push({
        lineNumber: i + 1,
        section: currentSecLabel,
        kind: "mid_word_split",
        message: `Move ${chord} to the start of "${word}"`,
        before: `${prefix}[${chord}]${suffix}`,
        after: `[${chord}]${word}`
      });
      return `${lead}[${chord}]${word}`;
    });

    // Rule 2: Redundant consecutive identical chord on a lyric line (`[E]Sing it, [E]once` -> `[E]Sing it, once`)
    {
      const chordRegex = /\[([A-G][#b]?[^\]]*)\]/g;
      let lastChord = "";
      let lastEnd = 0;
      let rebuilt = "";
      let m;
      while ((m = chordRegex.exec(line)) !== null) {
        const ch = m[1].trim();
        const between = line.slice(lastEnd, m.index);
        if (isChord(ch) && ch === lastChord && /[A-Za-z]/.test(between)) {
          issues.push({
            lineNumber: i + 1,
            section: currentSecLabel,
            kind: "redundant_chord",
            message: `Remove the repeated ${ch}`,
            before: m[0],
            after: ""
          });
          rebuilt += between;
        } else {
          rebuilt += between + m[0];
          if (isChord(ch)) lastChord = ch;
        }
        lastEnd = m.index + m[0].length;
      }
      rebuilt += line.slice(lastEnd);
      line = rebuilt;
    }

    // Rule 3: Weak pickup-word downbeat at the start of a line (`[D]The lantern of` -> `The [D]lantern of`)
    // Triggers when a line starts with `[Chord]PickupWord NextWord` where PickupWord is an unstressed article/preposition
    // and NextWord has at least 4 letters and no chord of its own.
    {
      const pickupMatch = line.match(/^(\s*)\[([A-G][#b]?[^\]]*)\]([A-Za-z]+)(\s+)([A-Za-z]{4,})(?!\[)/);
      if (pickupMatch) {
        const [, indent, firstChord, firstWord, space, secondWord] = pickupMatch;
        if (isChord(firstChord) && PICKUP_WORDS.has(firstWord.toLowerCase())) {
          const rest = line.slice(pickupMatch[0].length);
          issues.push({
            lineNumber: i + 1,
            section: currentSecLabel,
            kind: "pickup_downbeat",
            message: `Move ${firstChord} from "${firstWord}" to "${secondWord}"`,
            before: `[${firstChord}]${firstWord}${space}${secondWord}`,
            after: `${firstWord}${space}[${firstChord}]${secondWord}`
          });
          line = `${indent}${firstWord}${space}[${firstChord}]${secondWord}${rest}`;
        }
      }
    }

    // Rule 4: Hanging punctuation glued directly before a chord (`paid.[G]Word` -> `paid. [G]Word`)
    line = line.replace(/([.,!?;:])\[([A-G][#b]?[^\]]*)\](?=[A-Za-z\[])/g, (full, punct, chord) => {
      if (!isChord(chord)) return full;
      issues.push({
        lineNumber: i + 1,
        section: currentSecLabel,
        kind: "punctuation_spacing",
        message: `Add a space before ${chord}`,
        before: `${punct}[${chord}]`,
        after: `${punct} [${chord}]`
      });
      return `${punct} [${chord}]`;
    });

    fixedLines.push(line);
  }

  const fixedChordpro = fixedLines.join("\n");

  // Rule 5: Cross-verse parallel meter advisory check
  const parsed = parse(fixedChordpro);
  const verses = parsed.sections.filter((s) => s.type === "verse" && (s.lines || []).length >= 2);
  if (verses.length >= 2) {
    const baseVerse = verses[0];
    const baseLineChords = (baseVerse.lines || [])
      .filter((l) => l.segments)
      .map((l) => l.segments.filter((s) => s.chord).map((s) => s.chord));
    for (let v = 1; v < verses.length; v++) {
      const curVerse = verses[v];
      const curLines = (curVerse.lines || []).filter((l) => l.segments);
      if (curLines.length === baseLineChords.length) {
        for (let ln = 0; ln < curLines.length; ln++) {
          const cChords = curLines[ln].segments.filter((s) => s.chord).map((s) => s.chord);
          if (baseLineChords[ln].length > 0 && cChords.length === 0) {
            issues.push({
              lineNumber: ln + 1,
              section: curVerse.label || `Verse ${v + 1}`,
              kind: "cross_verse_missing",
              message: `${curVerse.label || `Verse ${v + 1}`} line ${ln + 1} has no chords (Verse 1 has ${baseLineChords[ln].join(" → ")})`,
              advisoryOnly: true
            });
          }
        }
      }
    }
  }

  return {
    issues,
    fixedChordpro,
    issueCount: issues.length,
    autoFixCount: issues.filter((it) => !it.advisoryOnly).length
  };
}

export function autoFixChordAlignment(chordproText) {
  return auditChordAlignment(chordproText).fixedChordpro;
}

/**
 * Layer 2 Interactive On-Sheet Scrubber:
 * Nudge a specific chord (identified by `secIdx`, `lineIdx`, `segIdx`) one word or syllable
 * left (`dir = -1`) or right (`dir = +1`) directly in the ChordPro source.
 */
export function nudgeChordInChordPro(chordproText, secIdx, lineIdx, segIdx, dir = 1) {
  const model = parse(chordproText);
  const sec = model.sections?.[secIdx];
  const lineObj = sec?.lines?.[lineIdx];
  if (!lineObj || ! Array.isArray(lineObj.segments)) return chordproText;

  const segs = lineObj.segments.map((s) => ({ chord: s.chord || "", lyric: s.lyric || "" }));
  const target = segs[segIdx];
  if (!target || !target.chord) return chordproText;

  const chordToMove = target.chord;

  if (dir > 0) {
    // Move chord RIGHT into target.lyric (after first word or syllable) or onto next segment
    const lyr = target.lyric || "";
    const wordSpaceMatch = lyr.match(/^(\s*\S+\s+)(.+)$/);
    if (wordSpaceMatch) {
      // Shift chord past the first word in this segment
      const [, firstPart, restPart] = wordSpaceMatch;
      target.chord = "";
      target.lyric = firstPart;
      segs.splice(segIdx + 1, 0, { chord: chordToMove, lyric: restPart });
    } else if (lyr.trim().length >= 4) {
      // Split single word roughly at midpoint syllable so you can place a walkdown chord on the end of a word
      const leadSpaces = (lyr.match(/^\s*/) || [""])[0];
      const trailSpaces = (lyr.match(/\s*$/) || [""])[0];
      const core = lyr.trim();
      const splitAt = Math.max(2, Math.ceil(core.length * 0.6));
      const leftSyll = leadSpaces + core.slice(0, splitAt);
      const rightSyll = core.slice(splitAt) + trailSpaces;
      target.chord = "";
      target.lyric = leftSyll;
      segs.splice(segIdx + 1, 0, { chord: chordToMove, lyric: rightSyll });
    } else if (segIdx + 1 < segs.length && !segs[segIdx + 1].chord) {
      target.chord = "";
      segs[segIdx + 1].chord = chordToMove;
    }
  } else if (dir < 0) {
    // Move chord LEFT into the previous segment's trailing word or start of current split word
    if (segIdx > 0) {
      const prev = segs[segIdx - 1];
      const prevLyr = prev.lyric || "";
      // If previous segment ended mid-word (no trailing space), snap chord to the start of that word
      if (prevLyr.length > 0 && !/\s$/.test(prevLyr)) {
        const lastWordMatch = prevLyr.match(/^(.*?\s)?(\S+)$/);
        if (lastWordMatch && lastWordMatch[1]) {
          prev.lyric = lastWordMatch[1];
          target.lyric = lastWordMatch[2] + (target.lyric || "");
        } else if (!prev.chord) {
          prev.chord = chordToMove;
          prev.lyric = prevLyr + (target.lyric || "");
          segs.splice(segIdx, 1);
        }
      } else {
        // Pull the last word from prev.lyric into target
        const pullMatch = prevLyr.match(/^(.*\s)(\S+\s*)$/);
        if (pullMatch) {
          prev.lyric = pullMatch[1];
          target.lyric = pullMatch[2] + (target.lyric || "");
        } else if (!prev.chord && prevLyr.length > 0) {
          prev.chord = chordToMove;
          prev.lyric = prevLyr + (target.lyric || "");
          segs.splice(segIdx, 1);
        }
      }
    }
  }

  // Re-serialize the modified line through parseChordProLine so adjacent empty-chord segments merge cleanly
  const rawRebuilt = segs.map((s) => `${s.chord ? `[${s.chord}]` : ""}${s.lyric || ""}`).join("");
  lineObj.segments = parseChordProLine(rawRebuilt);
  return serialize(model);
}

