// Exact chord placement, syllable snapping, Track A deterministic sheet builder,
// and ChordPro serialization for import-sheet.

import { isValidChordToken, validateSheetOutput } from "./chord_net.ts";

export const TUNING_VALUES: Record<string, string> = {
  standard: "E A D G B E",
  half: "Eb Ab Db Gb Bb Eb",
  drop_d: "D A D G B E",
  other: "Other"
};

export const GENRES = ["worship", "country", "rock", "pop"];

// Chord voicing charts at the top of a page aren't part of the song.
export const NOT_SONG_SECTION = /chord (?:shapes?|diagrams?|charts?|voicings?)|voicings?|fingerings?/i;

// A section name on its own line in a chord site's text: "[Chorus]", "[Verse 2]".
export const SOURCE_HEADER = /^\s*\[([^\]]+)\]\s*$/;

// ==== LAYOUT ====
export type Glyph = { ch: string; x: number; w: number };
export type PlacedChord = { chord: string; x: number; dashed?: boolean };

const VOWEL = /[aeiouy]/i;
const DIGRAPH = /^(?:sh|ch|th|ph|wh|gh|ck|qu|ng)$/i;

// Where a word can be split into sung syllables: "mea|sure", "on|ly", "Be|hold", "moc|king".
// Rough rules (V-CV, VC-CV, consonant pairs kept together), and a silent final e is not a syllable.
export function syllableStarts(word: string): number[] {
  const starts = [0];
  const w = word.toLowerCase();
  for (let i = 1; i < w.length - 1; i++) {
    if (!VOWEL.test(w[i - 1]) || VOWEL.test(w[i]) || !/[a-z]/.test(w[i])) continue;
    let j = i;
    while (j < w.length && /[a-z]/.test(w[j]) && !VOWEL.test(w[j])) j++;
    if (j >= w.length || !VOWEL.test(w[j])) { i = j; continue; }
    const run = w.slice(i, j);
    let cut = run.length === 1 || (run.length === 2 && DIGRAPH.test(run)) ? i : i + 1;
    if (run.length >= 3 && DIGRAPH.test(run.slice(-2))) cut = j - 2;
    if (!/^[^aeiouy]{1,2}e[sd]?$/.test(w.slice(cut))) starts.push(cut);
    i = j - 1;
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

// Moves a chord that lands inside a word to the nearest syllable start.
export function snapToSyllable(text: string, i: number): number {
  if (i >= text.length || !/[A-Za-z']/.test(text[i])) {
    if (i > 0 && /[A-Za-z']/.test(text[i - 1] || "")) i--;
    else return i;
  }
  let start = i;
  while (start > 0 && /[A-Za-z']/.test(text[start - 1])) start--;
  let end = i;
  while (end < text.length && /[A-Za-z']/.test(text[end])) end++;
  const offsets = syllableStarts(text.slice(start, end));
  const nearest = offsets.reduce((best, o) => (Math.abs(o - (i - start)) < Math.abs(best - (i - start)) ? o : best), 0);
  return start + nearest;
}

// Puts each chord on the syllable under its left edge.
export function placeChords(chords: PlacedChord[], lyric: Glyph[]): string {
  const text = lyric.map((g) => g.ch).join("").replace(/\s+$/, "");
  const slots = new Map<number, string[]>();
  let prev = -1;
  for (const { chord, x, dashed } of chords) {
    let i = lyric.findIndex((g) => x < g.x + g.w * 0.6);
    if (i < 0 || i > text.length) i = text.length;
    while (i < text.length && text[i] === " ") i++;
    if (i < text.length) i = snapToSyllable(text, i);
    if (dashed && prev >= 0) {
      let start = prev;
      while (start > 0 && /[A-Za-z']/.test(text[start - 1])) start--;
      let end = prev;
      while (end < text.length && /[A-Za-z']/.test(text[end])) end++;
      const next = syllableStarts(text.slice(start, end)).map((o) => start + o).find((o) => o > prev);
      if (next !== undefined) i = next;
    }
    if (i <= prev) i = prev;
    slots.set(i, [...(slots.get(i) || []), chord]);
    prev = i;
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    const here = slots.get(i) || [];
    out += i === text.length ? here.map((c) => ` [${c}]`).join("") : here.map((c) => `[${c}]`).join("");
    if (i < text.length) out += text[i];
  }
  return out.replace(/\s+/g, " ").trim();
}

export const wordsKey = (line: string) =>
  line.replace(/\[[^\]]*\]/g, "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, " ").trim();

export const chordList = (line: string) =>
  [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());

// "[G]Down the [D]river in the morning" split after 3 words -> ["[G]Down the [D]river", "in the morning"].
export function splitAtWord(text: string, words: number): [string, string] {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") { const close = text.indexOf("]", i); if (close > i) { i = close; continue; } }
    const letter = /[A-Za-z0-9']/.test(text[i]);
    if (letter && !inWord) { inWord = true; count++; if (count === words + 1) return [text.slice(0, i).trim(), text.slice(i).trim()]; }
    if (!letter && text[i] !== "[") inWord = letter;
  }
  return [text, ""];
}

// Removes Ultimate Guitar [tab] / [/tab] wrappers without turning chord+lyric lines into tablature.
export function stripTabWrappers(text: string): string {
  return String(text || "").replace(/\[\/?tab\]/gi, "");
}

// Removes Ultimate Guitar [ch] / [/ch] and [tab] / [/tab] tags for plain monospaced text.
export function stripUgTags(text: string): string {
  return String(text || "").replace(/\[\/?(?:ch|tab)\]/gi, "");
}

/**
 * Chord columns in a monospaced chord line, or null when the line isn't all chords.
 * Supports Ultimate Guitar's native `[ch]...[/ch]` markers, computing each chord's exact
 * visual column offset (ignoring the `[ch]`/`[/ch]` wrapper characters) so columns align
 * 1-to-1 with the lyric line directly below.
 */
export function chordColumns(
  line: string,
  isValid: (c: string) => boolean
): Array<{ chord: string; col: number }> | null {
  const cleaned = stripTabWrappers(line);
  if (/\[ch\]/i.test(cleaned)) {
    const out: Array<{ chord: string; col: number }> = [];
    const re = /\[ch\](.*?)\[\/ch\]/gi;
    let lastIdx = 0;
    let visualCol = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const between = cleaned.slice(lastIdx, m.index);
      // Allow spaces, bar lines, dashes, parentheses, repeat counts, and stray punctuation between chords;
      // if real lyric words sit outside [ch] tags, this isn't a pure chord line.
      const nonChordBits = between.replace(/[\s|/\-–()\[\],.]+|\(?x\d{1,2}\)?|\d{1,2}x/gi, "");
      if (nonChordBits.length > 0) return null;
      visualCol += between.length;
      const raw = m[1].trim().replace(/^[(\[]+|[)\],]+$/g, "");
      const parts = raw.split(/-(?=[A-G])/);
      if (!raw || !parts.every((c) => isValid(c))) return null;
      let col = visualCol;
      for (const c of parts) {
        out.push({ chord: c, col });
        col += c.length + 1;
      }
      visualCol += m[1].length;
      lastIdx = m.index + m[0].length;
    }
    const tail = cleaned.slice(lastIdx);
    const tailBits = tail.replace(/[\s|/\-–()\[\],.]+|\(?x\d{1,2}\)?|\d{1,2}x/gi, "");
    if (tailBits.length > 0) return null;
    return out.length ? out : null;
  }

  const out: Array<{ chord: string; col: number }> = [];
  for (const m of cleaned.matchAll(/\S+/g)) {
    const raw = m[0].replace(/^[(\[]+|[)\],]+$/g, "");
    if (!raw || /^[-–|/.]+$/.test(raw) || /^\(?x\d{1,2}\)?$|^\d{1,2}x$/i.test(raw)) continue;
    // "A/C#-D" is two quick chords.
    const parts = raw.split(/-(?=[A-G])/);
    if (!parts.every((c) => isValid(c))) return null;
    let col = m.index ?? 0;
    for (const c of parts) { out.push({ chord: c, col }); col += c.length + 1; }
  }
  return out.length ? out : null;
}

/**
 * Replaces the AI's chord placement with the exact one from the source wherever both have the
 * same words and the same number of chords. Returns how many lines changed.
 */
export function realignToLayout(
  sections: Array<{ type?: string; lines?: Array<{ text?: string; tab?: boolean }> }>,
  layout: string[],
  isValidChord: (c: string) => boolean
): number {
  const byWords = new Map<string, string[]>();
  for (const line of layout) {
    const chords = chordList(line);
    if (!chords.length || !chords.every(isValidChord)) continue;
    const key = wordsKey(line);
    if (key.length < 6) continue;
    byWords.set(key, [...(byWords.get(key) || []), line]);
  }
  const used = new Map<string, number>();
  const semis: Record<string, number> = { C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4, F: 5, "E#": 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11 };
  const root = (c: string) => semis[(c.match(/^[A-G][#b]?/) || [""])[0]] ?? -1;
  const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c === b[i]);
  const sameRoots = (a: string[], b: string[]) =>
    a.length === b.length && a.filter((c, i) => root(c) === root(b[i])).length * 2 >= a.length;
  const take = (key: string, mine: string[]): string | null => {
    const candidates = byWords.get(key);
    if (!candidates) return null;
    const from = used.get(key) ?? 0;
    const pick = (i: number) => { used.set(key, i + 1); return candidates[i]; };
    for (let i = from; i < candidates.length; i++) if (sameNames(chordList(candidates[i]), mine)) return pick(i);
    for (let i = 0; i < from; i++) if (sameNames(chordList(candidates[i]), mine)) return candidates[i];
    for (let i = from; i < candidates.length; i++) if (sameRoots(chordList(candidates[i]), mine)) return pick(i);
    return null;
  };
  const ordered = layout.filter((l) => chordList(l).length && chordList(l).every(isValidChord)).map((l) => ({ text: l, key: wordsKey(l) }));
  let changed = 0;
  for (const sec of sections || []) {
    if (sec.type === "chorus_repeat" || !Array.isArray(sec.lines)) continue;
    const out: Array<{ text?: string; tab?: boolean }> = [];
    for (let i = 0; i < sec.lines.length; i++) {
      const line = sec.lines[i];
      if (line.tab || typeof line.text !== "string") { out.push(line); continue; }
      const key = wordsKey(line.text);
      const exact = take(key, chordList(line.text));
      if (exact) {
        if (exact !== line.text) changed++;
        out.push({ ...line, text: exact });
        continue;
      }
      const stutter = ordered.find((o) => {
        if (!key.startsWith(o.key + " ")) return false;
        const extra = key.slice(o.key.length + 1).split(" ");
        const words = o.key.split(" ");
        for (let n = 1; n <= Math.min(4, words.length); n++) {
          const tail = words.slice(-n);
          if (extra.length % n === 0 && extra.every((w, j) => w === tail[j % n])) return true;
        }
        return false;
      });
      if (stutter && sameRoots(chordList(stutter.text), chordList(line.text))) {
        out.push({ ...line, text: stutter.text });
        changed++;
        continue;
      }
      let joined: string[] | null = null;
      for (let a = 0; a < ordered.length && !joined; a++) {
        for (let n = 2; n <= 3 && a + n <= ordered.length; n++) {
          const parts = ordered.slice(a, a + n);
          if (parts.map((p) => p.key).join(" ") === key) { joined = parts.map((p) => p.text); break; }
        }
      }
      if (joined) {
        joined.forEach((t) => out.push({ ...line, text: t }));
        changed++;
        continue;
      }
      const nextLine = sec.lines[i + 1];
      const nextText = nextLine && !nextLine.tab && typeof nextLine.text === "string" ? nextLine.text : null;
      if (nextLine && nextText !== null) {
        const firstWords = key.split(" ").length;
        const whole = ordered.find((o) => o.key === `${key} ${wordsKey(nextText)}`);
        if (whole) {
          const [head, tail] = splitAtWord(whole.text, firstWords);
          out.push({ ...line, text: head }, { ...nextLine, text: tail });
          i++;
          changed++;
          continue;
        }
      }
      out.push(line);
    }
    sec.lines = out;
  }
  return changed;
}

/**
 * Lyric lines with chords placed by column from a monospaced, chords-over-lyrics transcription.
 * Supports Ultimate Guitar `[ch]` tags (ignoring `[tab]` wrappers).
 * With keepAll, lines without chords and chord-only lines are kept too, in order.
 */
export function layoutFromSourceText(text: string, isValid: (c: string) => boolean, keepAll = false): string[] {
  const lines = stripTabWrappers(String(text || "")).replace(/\r/g, "").replace(/\t/g, "    ").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const chords = chordColumns(lines[i], isValid);
    if (!chords) {
      const plain = stripUgTags(lines[i]);
      if (keepAll && /[a-z]/i.test(plain) && !SOURCE_HEADER.test(plain)) out.push(plain.trim().replace(/\s+/g, " "));
      continue;
    }
    const lyricRaw = lines[i + 1] ?? "";
    const lyric = stripUgTags(lyricRaw);
    if (!/[a-z]/i.test(lyric) || chordColumns(lyricRaw, isValid)) {
      if (keepAll) out.push(chords.map((c) => `[${c.chord}]`).join("   "));
      continue;
    }
    const start = lyric.search(/\S/);
    const slots = new Map<number, string[]>();
    const lead = chords.filter((c) => c.col < start);
    const leadText = lead.slice(0, -1).map((c) => `[${c.chord}] `).join("");
    if (lead.length) slots.set(start, [lead[lead.length - 1].chord]);
    for (const { chord, col } of chords.slice(lead.length)) {
      let at = Math.min(col, lyric.length);
      while (at < lyric.length && /[\s,;:.!?)]/.test(lyric[at])) at++;
      slots.set(at, [...(slots.get(at) || []), chord]);
    }
    let merged = "";
    for (let k = 0; k <= lyric.length; k++) {
      const here = slots.get(k) || [];
      merged += k === lyric.length && k > 0 ? here.map((c) => ` [${c}]`).join("") : here.map((c) => `[${c}]`).join("");
      if (k < lyric.length) merged += lyric[k];
    }
    out.push(snapLayoutLine((leadText + merged.trim()).replace(/\s+/g, " ").trim()));
    i++;
  }
  return out;
}

/**
 * The AI sometimes marks a chorus as "the same again" when the source sings it with other words
 * or chords (a second chorus with a different line, a longer last chorus). When the source names
 * its sections, compare each repeat with the source's chorus at that spot and write out the ones
 * that differ, straight from the source. Returns how many came back.
 */
// deno-lint-ignore no-explicit-any
export function restoreChangedChoruses(sections: any[], sourceText: string, isValid: (c: string) => boolean): number {
  const blocks: Array<{ label: string; text: string[] }> = [];
  let cur: { label: string; text: string[] } | null = null;
  for (const raw of stripTabWrappers(String(sourceText || "")).replace(/\r/g, "").split("\n")) {
    const h = raw.match(SOURCE_HEADER);
    if (h && !isValid(h[1].trim())) { cur = { label: h[1].trim(), text: [] }; blocks.push(cur); continue; }
    if (cur) cur.text.push(raw);
  }
  const isChorus = (label: string) => /chorus|refrain/i.test(label) && !/pre|post/i.test(label);
  const fromSource = blocks.filter((b) => isChorus(b.label)).map((b) => layoutFromSourceText(b.text.join("\n"), isValid, true));
  // deno-lint-ignore no-explicit-any
  const inSheet = (sections || []).filter((s: any) => (s.type === "chorus" || s.type === "chorus_repeat") && !/pre|post/i.test(s.label || ""));
  if (fromSource.length < 2 || fromSource.length !== inSheet.length || inSheet[0].type !== "chorus") return 0;
  const first = inSheet[0];
  // deno-lint-ignore no-explicit-any
  const firstLines: string[] = (first.lines || []).filter((l: any) => !l.tab && typeof l.text === "string").map((l: any) => l.text);
  const words = (lines: string[]) => lines.map(wordsKey).filter(Boolean).join("|");
  const chords = (lines: string[]) => lines.flatMap(chordList).join(" ");
  if (words(fromSource[0]) !== words(firstLines)) return 0;
  let restored = 0;
  inSheet.forEach((sec, i) => {
    const src = fromSource[i];
    if (i === 0 || sec.type !== "chorus_repeat" || !src.length) return;
    if (words(src) === words(firstLines) && chords(src) === chords(firstLines)) return;
    sec.type = "chorus";
    sec.label = sec.label && !/repeat/i.test(sec.label) ? sec.label : (first.label || "Chorus");
    sec.lines = src.map((text) => ({ text, tab: false }));
    restored++;
  });
  return restored;
}

/** Text pastes keep exact columns; this only moves chords that land inside a word to a syllable start. */
export function snapLayoutLine(line: string): string {
  const parts: Array<{ chord: string; at: number }> = [];
  let text = "";
  for (const piece of line.split(/(\[[^\]]+\])/)) {
    const m = piece.match(/^\[([^\]]+)\]$/);
    if (m) parts.push({ chord: m[1], at: text.length });
    else text += piece;
  }
  const slots = new Map<number, string[]>();
  let prev = -1;
  for (const { chord, at } of parts) {
    let i = at < text.length && /[A-Za-z']/.test(text[at]) ? snapToSyllable(text, at) : at;
    if (i < prev) i = prev;
    slots.set(i, [...(slots.get(i) || []), chord]);
    prev = i;
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    out += (slots.get(i) || []).map((c) => `[${c}]`).join("");
    if (i < text.length) out += text[i];
  }
  return out;
}
// ==== END LAYOUT ====

// The AI lists the word under each chord before writing the line ("D over river, A over
// morning"). When the line it wrote disagrees, rebuild the line from that list.
// deno-lint-ignore no-explicit-any
export function applyPlacementNotes(sections: any[]): number {
  let fixed = 0;
  for (const sec of sections || []) {
    for (const line of sec.lines || []) {
      if (line.tab || typeof line.text !== "string" || typeof line.placement !== "string") continue;
      const notes = [...line.placement.matchAll(/([A-G][^\s,;]*)\s+(?:over\s+["“]?([^\s,;"”]+)["”]?|at\s+end)/gi)]
        .map((m) => ({ chord: m[1], anchor: m[2] || null }));
      const chords = [...line.text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
      if (!notes.length || notes.length !== chords.length || notes.some((n, i) => n.chord !== chords[i])) continue;
      const lyric = line.text.replace(/\[[^\]]*\]/g, "");
      if (!lyric.trim()) continue;
      const lower = lyric.toLowerCase();
      const clean = (a: string) => a.toLowerCase().replace(/[.,!?;:]+$/, "");
      const written: number[] = [];
      let plain = 0;
      for (const piece of line.text.split(/(\[[^\]]+\])/)) {
        if (/^\[[^\]]+\]$/.test(piece)) written.push(plain);
        else plain += piece.length;
      }
      const onWord = (a: string, at: number) => lower.startsWith(a, at) || lower.startsWith(a, at + 1);
      if (notes.every((n, k) => (n.anchor ? onWord(clean(n.anchor), written[k]) : written[k] >= lyric.trimEnd().length))) continue;
      const find = (a: string, from: number) => {
        let at = -1;
        for (let i = lower.indexOf(a, from); i >= 0; i = lower.indexOf(a, i + 1)) {
          if (i === 0 || !/[a-z']/i.test(lower[i - 1])) return i;
          if (at < 0) at = i;
        }
        return at;
      };
      const spots: number[] = [];
      let cursor = 0;
      let ok = true;
      for (let k = 0; k < notes.length; k++) {
        const n = notes[k];
        if (!n.anchor) { spots.push(lyric.length); continue; }
        const a = clean(n.anchor);
        const prev = k > 0 && notes[k - 1].anchor ? clean(notes[k - 1].anchor as string) : null;
        let at = prev === a ? find(a, cursor + 1) : -1;
        if (at < 0) at = find(a, cursor);
        if (at < 0) { ok = false; break; }
        spots.push(at);
        cursor = at;
      }
      if (!ok) continue;
      let out = "";
      for (let i = 0; i <= lyric.length; i++) {
        notes.forEach((n, k) => { if (spots[k] === i) out += (i === lyric.length && lyric.length ? " " : "") + `[${n.chord}]`; });
        if (i < lyric.length) out += lyric[i];
      }
      out = out.replace(/\s+/g, " ").trim();
      if (out !== line.text.replace(/\s+/g, " ").trim()) { line.text = out; fixed++; }
    }
  }
  return fixed;
}

// Some sources write a repeat out in full (the same lines again, back to back). Print it once
// with a count, so the sheet stays short: "Bridge (2x)", or a "Repeat 4x" line after the block.
// deno-lint-ignore no-explicit-any
export function collapseWrittenRepeats(sections: any[]) {
  const same = (a: { text?: string }, b: { text?: string }) =>
    typeof a?.text === "string" && typeof b?.text === "string" && a.text.trim() === b.text.trim() && a.text.trim() !== "";
  for (const sec of sections || []) {
    const lines = Array.isArray(sec.lines) ? sec.lines : [];
    if (sec.type === "tab" || lines.length < 2) continue;
    const out = [];
    let i = 0;
    while (i < lines.length) {
      let best = { size: 0, times: 1 };
      for (let size = Math.floor((lines.length - i) / 2); size >= 1; size--) {
        let times = 1;
        while (i + (times + 1) * size <= lines.length &&
          lines.slice(i, i + size).every((l: { text?: string }, k: number) => same(l, lines[i + times * size + k]))) times++;
        if (times > 1 && size * times >= best.size * best.times) best = { size, times };
      }
      if (best.times > 1) {
        out.push(...lines.slice(i, i + best.size));
        const wholeSection = i === 0 && best.size * best.times === lines.length;
        if (wholeSection && !/\(\d+x\)/.test(sec.label || "")) {
          sec.label = `${sec.label || ""} (${best.times}x)`.trim();
        } else if (!wholeSection) {
          out.push({ text: `(Repeat ${best.times}x)`, tab: false });
        }
        i += best.size * best.times;
      } else {
        out.push(lines[i]);
        i++;
      }
    }
    sec.lines = out;
  }
}

// ---------------------------------------------------------------------------
// Track A: Deterministic Structured Sheet Parser (Ultimate Guitar & Digital PDFs)
// ---------------------------------------------------------------------------

// Genuine 6-string guitar tablature line (never conflated with UG [tab]...[/tab] line wrappers).
export function isGuitarTabLine(line: string): boolean {
  const t = stripUgTags(line).trim();
  return /^[eBGDAE][|:][-\d\w/\\~^hpbx()|\s]{4,}$/.test(t) && (t.match(/-/g) || []).length >= 3;
}

// Site clutter, chord-shape voicing tables, copyright, and UI junk.
export function isClutterLine(line: string): boolean {
  const t = stripUgTags(line).trim();
  if (!t) return false;
  if (/^\s*(?:[A-G][#b]?[^\s]*\s*[:=-]?\s*[xX0-9]{6}\b|[xX0-9]{6}\b)/.test(t)) return true;
  if (/^(?:CCLI|copyright|©|submitted by|view lyrics|words and music|all rights reserved|www\.|https?:\/\/|tuning\s*:|capo\s*:|key\s*:|tempo\s*:|bpm\s*:|difficulty\s*:|author\s*:|strumming\s*:)/i.test(t)) return true;
  if (/^[EADGBe\s]{5,15}$/.test(t) && /E\s*A\s*D\s*G\s*B\s*E/i.test(t)) return true;
  return false;
}

const SECTION_KEYWORDS = /^(intro|verse|pre[\s-]*chorus|chorus|refrain|bridge|outro|interlude|instrumental|solo|tag|ending|turnaround|vamp|hook|coda|breakdown|post[\s-]*chorus|tab|riff)(?:\s*#?\s*(\d+[a-z]?))?(?:\s*\(([^)]+)\))?(?:\s*[:\-–—]\s*(.*))?$/i;

export function parseSectionHeader(
  rawLine: string,
  isValid: (c: string) => boolean
): { type: string; label: string; note: string; inlineChords: string } | null {
  const trimmed = stripTabWrappers(rawLine).trim();
  if (!trimmed || trimmed.length > 90 || /\[\/?ch\]/i.test(trimmed)) return null;

  let inner = "";
  let trailing = "";
  const bracketed = trimmed.match(/^\[([^\]]+)\](?:\s*[:\-–—]?\s*(.*))?$/);
  if (bracketed) {
    inner = bracketed[1].trim();
    trailing = (bracketed[2] || "").trim();
    if (!inner || isValid(inner) || /\[/.test(trailing)) return null;
  } else {
    // Plain heading on its own line: "Verse 1", "Chorus:", "Bridge (2x):", "Intro: Palm muted"
    if (!SECTION_KEYWORDS.test(trimmed)) return null;
    inner = trimmed;
  }

  if (NOT_SONG_SECTION.test(inner)) {
    return { type: "__drop__", label: inner, note: "", inlineChords: "" };
  }

  const m = inner.match(SECTION_KEYWORDS);
  if (!m) {
    // Bracketed custom section like "[Guitar Solo]" or "[Chorus 2]"
    if (bracketed && !/\d{6}/.test(inner) && inner.split(/\s+/).length <= 5) {
      const low = inner.toLowerCase();
      const type = /chorus|refrain/.test(low) ? (/pre/.test(low) ? "pre_chorus" : "chorus")
        : /verse/.test(low) ? "verse"
        : /bridge/.test(low) ? "bridge"
        : /intro/.test(low) ? "intro"
        : /outro|ending|coda/.test(low) ? "outro"
        : /solo|interlude|instrumental|turnaround|riff/.test(low) ? "instrumental"
        : "verse";
      const label = /refrain/i.test(inner) ? inner.replace(/refrain/gi, "Chorus") : inner;
      return { type, label, note: trailing, inlineChords: "" };
    }
    return null;
  }

  const rawKind = m[1].toLowerCase().replace(/[\s-]+/g, "_");
  const num = m[2] ? ` ${m[2]}` : "";
  const paren = m[3] ? m[3].trim() : "";
  const rest = [m[4] || "", trailing].filter(Boolean).join(" — ").trim();

  let type = "verse";
  let baseLabel = "Verse";
  if (rawKind === "chorus" || rawKind === "refrain" || rawKind === "hook") {
    type = "chorus";
    baseLabel = "Chorus";
  } else if (rawKind === "pre_chorus") {
    type = "pre_chorus";
    baseLabel = "Pre-Chorus";
  } else if (rawKind === "post_chorus") {
    type = "chorus";
    baseLabel = "Post-Chorus";
  } else if (rawKind === "bridge" || rawKind === "breakdown") {
    type = "bridge";
    baseLabel = "Bridge";
  } else if (rawKind === "intro") {
    type = "intro";
    baseLabel = "Intro";
  } else if (rawKind === "outro" || rawKind === "ending" || rawKind === "coda") {
    type = "outro";
    baseLabel = "Outro";
  } else if (rawKind === "interlude" || rawKind === "instrumental" || rawKind === "solo" || rawKind === "turnaround" || rawKind === "vamp" || rawKind === "riff") {
    type = "instrumental";
    baseLabel = rawKind.charAt(0).toUpperCase() + rawKind.slice(1);
  } else if (rawKind === "tag") {
    type = "outro";
    baseLabel = "Tag";
  } else if (rawKind === "tab") {
    type = "tab";
    baseLabel = "Tab";
  } else {
    type = "verse";
    baseLabel = "Verse";
  }

  let repeatSuffix = "";
  let note = rest;
  if (paren) {
    if (/^\d+x$|^x\d+$/i.test(paren)) {
      const n = paren.replace(/\D/g, "");
      repeatSuffix = ` (${n}x)`;
    } else {
      note = note ? `${paren} — ${note}` : paren;
    }
  }

  // Check if trailing text after "Intro:" is actually a chord line ("Intro: G D Em C")
  let inlineChords = "";
  if (note) {
    const ch = chordColumns(note, isValid);
    if (ch && ch.length >= 1) {
      inlineChords = ch.map((c) => `[${c.chord}]`).join("   ");
      note = "";
    }
  }

  return {
    type,
    label: `${baseLabel}${num}${repeatSuffix}`.trim(),
    note: stripUgTags(note),
    inlineChords
  };
}

export function toTitleCase(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "per", "the", "to", "vs"]);
  const words = s.toLowerCase().split(/\s+/);
  return words.map((w, idx) => {
    if (idx > 0 && idx < words.length - 1 && small.has(w)) return w;
    return w.replace(/(^|['"(])([a-z])/, (_, p, c) => p + c.toUpperCase());
  }).join(" ");
}

export function normalizeTuning(raw: string | null | undefined): "standard" | "half" | "drop_d" | "other" {
  const t = String(raw || "").toLowerCase();
  if (!t || /standard|e\s*a\s*d\s*g\s*b\s*e/.test(t)) return "standard";
  if (/half|eb|d#|flat/.test(t)) return "half";
  if (/drop\s*d|d\s*a\s*d\s*g\s*b\s*e/.test(t)) return "drop_d";
  return "other";
}

export function inferKeyFromSections(sections: Array<{ lines?: Array<{ text?: string; tab?: boolean }> }>): string {
  const chords: string[] = [];
  for (const sec of sections) {
    for (const l of sec.lines || []) {
      if (l.tab || !l.text) continue;
      for (const c of chordList(l.text)) {
        if (c !== "N.C." && c !== "NC") chords.push(c);
      }
    }
  }
  if (!chords.length) return "G";
  const normalizeRoot = (c: string) => {
    const m = c.match(/^([A-G][#b]?)(m(?!aj))?/);
    return m ? m[1] + (m[2] ? "m" : "") : "G";
  };
  // Ending tonic is often the true key; fall back to first chord.
  const first = normalizeRoot(chords[0]);
  const last = normalizeRoot(chords[chords.length - 1]);
  return last || first || "G";
}

export function buildFormString(sections: Array<{ type: string; label?: string | null }>): string {
  const parts: string[] = [];
  let vNum = 0;
  for (const s of sections) {
    if (s.type === "tab") continue;
    const lbl = (s.label || "").trim();
    if (s.type === "verse") {
      const m = lbl.match(/verse\s*(\d+)/i);
      vNum = m ? Number(m[1]) : vNum + 1;
      parts.push(`V${vNum}`);
    } else if (s.type === "chorus" || s.type === "chorus_repeat") {
      parts.push("Chorus");
    } else if (lbl) {
      parts.push(lbl);
    }
  }
  return parts.join(" • ");
}

/**
 * Deterministic Track A converter for structured chord sheets (Ultimate Guitar pages with `[ch]`
 * tags, and clean single-song digital text-layer PDFs).
 * Never rewrites lyrics or drifts chords. Checks every chorus individually (words + chords)
 * before marking `chorus_repeat`, and returns `confidence: "low"` to trigger Track B AI fallback
 * whenever the source looks mangled, incomplete, or ambiguous.
 */
// A short playing instruction printed under a chord line ("Palm muted", "Let ring", "Drums in"):
// a note for the player, not sung words.
const CUE_LINE = /^\(?\s*(?:palm[\s-]*mut(?:e|ed|ing)|p\.?\s?m\.?|let\s+(?:it\s+)?ring|muted?|clean(?:\s+guitar)?|distort(?:ed|ion)|tacet|hold|builds?(?:\s+up)?|building|soft(?:ly)?|quiet(?:ly)?|loud(?:er)?|full\s+band|(?:drums?|bass|band|guitars?|keys)\s+(?:in|enters?|comes?\s+in|kicks?\s+in)|fade(?:\s+out)?|ad[\s-]*lib|strum(?:ming)?|(?:single|one)\s+strums?|arpeggiat(?:e|ed)|picked|fingerpick(?:ed|ing)|half[\s-]*time|double[\s-]*time)[\s.!,]*\)?$/i;

export function parseStructuredSheet(opts: {
  rawText: string;
  title?: string;
  artist?: string | null;
  key?: string | null;
  capo?: number;
  tuning?: string | null;
  tempo?: number | null;
  timeSignature?: string | null;
  isValid?: (c: string) => boolean;
  // deno-lint-ignore no-explicit-any
}): { sheet: any; layoutLines: string[]; confidence: "high" | "low"; reason?: string } {
  const isValid = opts.isValid || isValidChordToken;
  const rawLines = stripTabWrappers(String(opts.rawText || ""))
    .replace(/\r/g, "")
    .replace(/\t/g, "    ")
    .split("\n");

  let title = (opts.title || "").trim();
  let artist = opts.artist ? String(opts.artist).trim() : null;
  let key = opts.key && isValid(opts.key.trim()) ? opts.key.trim() : "";
  let capo = Number.isFinite(opts.capo) ? Math.max(0, Math.min(12, Number(opts.capo))) : 0;
  let tuning = normalizeTuning(opts.tuning);
  let tempo = opts.tempo && opts.tempo >= 20 && opts.tempo <= 300 ? Math.round(opts.tempo) : null;
  let timeSignature = (opts.timeSignature || "").trim() || "4/4";

  // deno-lint-ignore no-explicit-any
  const sections: Array<{ type: string; label: string; sidebar_note: string | null; lines: Array<{ text: string; tab: boolean }> }> = [];
  const layoutLines: string[] = [];
  let current: { type: string; label: string; sidebar_note: string | null; lines: Array<{ text: string; tab: boolean }> } | null = null;
  let dropSection = false;
  let lyricLinesCount = 0;
  let chordLinesCount = 0;
  // Lines with [ch] chord tags that couldn't be read as a clean chord line (an unknown chord name,
  // or chords mixed into the words): the AI reads those better.
  let unreadableChordLines = 0;
  // Before the first section name, a page lists the band, album, and chord shapes: not song lines.
  const hasHeaders = rawLines.some((l) => !!parseSectionHeader(l, isValid));
  let seenHeader = false;
  const lyricLengths: number[] = [];

  const ensureSection = (type = "verse", label = "Verse 1") => {
    if (!current) {
      current = { type, label, sidebar_note: null, lines: [] };
      sections.push(current);
    }
    return current;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const plain = stripUgTags(raw).trim();
    if (!plain) continue;

    // Extract inline metadata headers near the top if not already supplied
    if (sections.length === 0) {
      const km = plain.match(/^Key\s*[:\-–]\s*([A-G][#b]?m?)\b/i);
      if (km && isValid(km[1])) { if (!key) key = km[1]; continue; }
      const cm = plain.match(/^Capo\s*[:\-–]\s*(\d+)/i);
      if (cm) { if (!capo) capo = Math.min(12, Number(cm[1]) || 0); continue; }
      const tm = plain.match(/^(?:Tempo|BPM)\s*[:\-–]\s*(\d{2,3})\b/i);
      if (tm) { if (!tempo) tempo = Number(tm[1]); continue; }
      const ts = plain.match(/^Time(?:\s+Signature)?\s*[:\-–]\s*(\d+\/\d+)\b/i);
      if (ts) { timeSignature = ts[1]; continue; }
      const tun = plain.match(/^Tuning\s*[:\-–]\s*(.+)$/i);
      if (tun) { tuning = normalizeTuning(tun[1]); continue; }
    }

    // Section headers ("[Verse 1]", "[Chorus]", "Bridge:", etc.)
    const hdr = parseSectionHeader(raw, isValid);
    if (hdr) {
      seenHeader = true;
      if (hdr.type === "__drop__") {
        dropSection = true;
        current = null;
        continue;
      }
      dropSection = false;
      current = {
        type: hdr.type,
        label: hdr.label,
        sidebar_note: hdr.note || null,
        lines: []
      };
      if (hdr.inlineChords) {
        current.lines.push({ text: hdr.inlineChords, tab: false });
        chordLinesCount++;
      }
      sections.push(current);
      continue;
    }

    if (dropSection) continue;
    if (isClutterLine(raw)) continue;

    // Real 6-string guitar tablature lines (detected strictly by string-line shape, never [tab] tags)
    if (isGuitarTabLine(raw)) {
      const tabBlock: Array<{ text: string; tab: boolean }> = [];
      while (i < rawLines.length && isGuitarTabLine(rawLines[i])) {
        tabBlock.push({ text: stripUgTags(rawLines[i]).trimEnd(), tab: true });
        i++;
      }
      i--;
      if (current && current.type === "tab") {
        current.lines.push(...tabBlock);
      } else {
        const tabLabel = current && current.lines.length === 0 ? current.label : "Tab";
        if (current && current.lines.length === 0) {
          current.type = "tab";
          current.lines.push(...tabBlock);
        } else {
          sections.push({ type: "tab", label: tabLabel, sidebar_note: null, lines: tabBlock });
        }
      }
      continue;
    }

    // Repeat chorus cue on its own line: "(Repeat Chorus)" or "Repeat Chorus"
    if (/^\(?repeat\s+chorus\)?$/i.test(plain)) {
      sections.push({ type: "chorus_repeat", label: "Chorus", sidebar_note: null, lines: [] });
      current = null;
      continue;
    }

    // Already-inline ChordPro line (e.g., emitted by pdfExtract for a paired line)
    if (/\[[A-G][#b]?[^\]\s]{0,10}\]/.test(plain) && !/\[ch\]/i.test(raw)) {
      const chords = chordList(plain);
      if (chords.length > 0 && chords.every(isValid)) {
        const sec = ensureSection("verse", "Verse 1");
        const snapped = snapLayoutLine(plain);
        sec.lines.push({ text: snapped, tab: false });
        chordLinesCount++;
        const wordsOnly = snapped.replace(/\[[^\]]+\]/g, "").trim();
        if (/[a-z]/i.test(wordsOnly)) {
          layoutLines.push(snapped);
          lyricLinesCount++;
          lyricLengths.push(wordsOnly.length);
        }
        continue;
      }
    }

    // Chord line over a lyric line (or standalone chord-only instrumental line)
    const chords = chordColumns(raw, isValid);
    if (chords) {
      const nextRaw = rawLines[i + 1] ?? "";
      const nextPlain = stripUgTags(nextRaw);
      const nextIsHeader = parseSectionHeader(nextRaw, isValid);
      const nextIsChords = chordColumns(nextRaw, isValid);
      const nextIsTab = isGuitarTabLine(nextRaw);
      const sec = ensureSection("verse", "Verse 1");

      const repeat = stripUgTags(raw).match(/\(?x(\d{1,2})\)?|\b(\d{1,2})x\b/i);
      const repeatMark = repeat ? ` (x${repeat[1] || repeat[2]})` : "";
      if (nextPlain.trim() && CUE_LINE.test(nextPlain.trim()) && !nextIsHeader && !nextIsChords) {
        // Chords with a playing cue under them: the chords as a chord-only line, the cue as the
        // section's margin note.
        const cue = nextPlain.trim().replace(/^\(|\)$/g, "").trim();
        sec.lines.push({ text: chords.map((c) => `[${c.chord}]`).join("   ") + repeatMark, tab: false });
        if (!sec.sidebar_note) sec.sidebar_note = cue.charAt(0).toUpperCase() + cue.slice(1);
        chordLinesCount++;
        i++;
        continue;
      }
      if (nextPlain.trim() && /[a-z]/i.test(nextPlain) && !nextIsHeader && !nextIsChords && !nextIsTab && !isClutterLine(nextRaw)) {
        const start = nextPlain.search(/\S/);
        const slots = new Map<number, string[]>();
        const lead = chords.filter((c) => c.col < start);
        const leadText = lead.slice(0, -1).map((c) => `[${c.chord}] `).join("");
        if (lead.length) slots.set(start, [lead[lead.length - 1].chord]);
        for (const { chord, col } of chords.slice(lead.length)) {
          let at = Math.min(col, nextPlain.length);
          while (at < nextPlain.length && /[\s,;:.!?)]/.test(nextPlain[at])) at++;
          slots.set(at, [...(slots.get(at) || []), chord]);
        }
        let merged = "";
        for (let k = 0; k <= nextPlain.length; k++) {
          const here = slots.get(k) || [];
          merged += k === nextPlain.length && k > 0 ? here.map((c) => ` [${c}]`).join("") : here.map((c) => `[${c}]`).join("");
          if (k < nextPlain.length) merged += nextPlain[k];
        }
        const placed = snapLayoutLine((leadText + merged.trim()).replace(/\s+/g, " ").trim());
        sec.lines.push({ text: placed, tab: false });
        layoutLines.push(placed);
        chordLinesCount++;
        lyricLinesCount++;
        lyricLengths.push(nextPlain.trim().length);
        i++;
      } else {
        // Chord-only line; a repeat count stays on the line, where the sheet shows it as ×N.
        sec.lines.push({ text: chords.map((c) => `[${c.chord}]`).join("   ") + repeatMark, tab: false });
        chordLinesCount++;
      }
      continue;
    }

    if (/\[ch\]/i.test(raw)) {
      unreadableChordLines++;
      continue;
    }

    // Plain lyric line (no chords above it). Before the first section name it's page clutter.
    if (hasHeaders && !seenHeader) continue;
    if (/[a-z]/i.test(plain)) {
      const sec = ensureSection("verse", "Verse 1");
      sec.lines.push({ text: plain.replace(/\s+/g, " "), tab: false });
      lyricLinesCount++;
      lyricLengths.push(plain.length);
    }
  }

  // Drop empty non-repeat sections
  const cleanedSections = sections.filter((s) => s.type === "chorus_repeat" || s.lines.length > 0);

  // Deduplicate identical choruses ONLY when both words AND chords match the first chorus.
  // Any chorus with different words or a key change stays written out in full.
  let firstChorusSig: { words: string; chords: string } | null = null;
  for (const sec of cleanedSections) {
    if (sec.type !== "chorus" || /post/i.test(sec.label || "")) continue;
    const textLines = sec.lines.filter((l) => !l.tab).map((l) => l.text);
    const sig = {
      words: textLines.map(wordsKey).filter(Boolean).join("|"),
      chords: textLines.flatMap(chordList).join(" ")
    };
    if (!firstChorusSig) {
      firstChorusSig = sig;
    } else if (sig.words && sig.words === firstChorusSig.words && sig.chords === firstChorusSig.chords) {
      sec.type = "chorus_repeat";
      sec.label = "Chorus";
      sec.lines = [];
    }
  }

  collapseWrittenRepeats(cleanedSections);

  if (!key) key = inferKeyFromSections(cleanedSections);
  const finalTitle = title ? (title === title.toUpperCase() ? toTitleCase(title) : title) : "";

  const sheet = {
    title: finalTitle,
    artist,
    key,
    capo,
    tuning,
    tempo,
    time_signature: timeSignature,
    genre: "pop",
    form: buildFormString(cleanedSections),
    sections: cleanedSections,
    notes: null as string | null,
    other_songs: [] as string[]
  };

  // Quality gate: fall back to AI whenever the direct parse looks weak or mangled.
  const problems = validateSheetOutput(sheet);
  if (problems.length > 0) {
    return { sheet, layoutLines, confidence: "low", reason: problems.join("; ") };
  }
  if (unreadableChordLines > 0) {
    return { sheet, layoutLines, confidence: "low", reason: `chord lines it couldn't read (${unreadableChordLines})` };
  }
  if (chordLinesCount < 4) {
    return { sheet, layoutLines, confidence: "low", reason: `too few chord lines (${chordLinesCount})` };
  }
  if (lyricLinesCount >= 4) {
    const sortedLens = [...lyricLengths].sort((a, b) => a - b);
    const medianLen = sortedLens[Math.floor(sortedLens.length / 2)] || 0;
    // Phone copies from Chordie/AZChords put 1-2 words per line (median < 12 chars)
    if (medianLen < 12) {
      return { sheet, layoutLines, confidence: "low", reason: `looks like split phone lines (median ${medianLen} chars)` };
    }
  }
  // If any verse has zero chords (e.g., hymn with chords only on verse 1), let AI copy chords to later verses
  const bareVerses = cleanedSections.filter(
    (s) => s.type === "verse" && s.lines.some((l) => !l.tab && /[a-z]/i.test(l.text)) && !s.lines.some((l) => !l.tab && chordList(l.text).length > 0)
  );
  if (bareVerses.length > 0) {
    return { sheet, layoutLines, confidence: "low", reason: `verses without chords (${bareVerses.length})` };
  }

  return { sheet, layoutLines, confidence: "high" };
}

// Convert validated structured sheet JSON into canonical ChordPro
export function sheetToChordPro(sheet: {
  title: string;
  artist?: string | null;
  key: string;
  capo?: number;
  tempo?: number | null;
  time_signature?: string | null;
  tuning?: string | null;
  sections: Array<{
    type: string;
    label?: string | null;
    sidebar_note?: string | null;
    lines: Array<{ text: string; tab?: boolean }>;
  }>;
}): string {
  const out: string[] = [];
  out.push(`{title: ${sheet.title.trim()}}`);
  if (sheet.artist && sheet.artist.trim()) out.push(`{artist: ${sheet.artist.trim()}}`);
  if (sheet.key && sheet.key.trim()) out.push(`{key: ${sheet.key.trim()}}`);
  if (sheet.capo && sheet.capo > 0) out.push(`{capo: ${sheet.capo}}`);
  if (sheet.tempo && sheet.tempo > 0) out.push(`{tempo: ${sheet.tempo}}`);
  if (sheet.time_signature && sheet.time_signature.trim()) out.push(`{time: ${sheet.time_signature.trim()}}`);
  const tuning = TUNING_VALUES[sheet.tuning || "standard"];
  if (tuning && tuning !== TUNING_VALUES.standard) out.push(`{tuning: ${tuning}}`);
  out.push("");

  sheet.sections.forEach((sec, idx) => {
    const t = (sec.type || "verse").toLowerCase();
    if (t === "chorus_repeat") {
      out.push("{chorus}");
      if (idx < sheet.sections.length - 1) out.push("");
      return;
    }
    const tag = ["verse", "chorus", "bridge", "intro", "outro", "instrumental", "pre_chorus", "tab"].includes(t) ? t : "verse";
    const label = sec.label ? sec.label.trim() : "";
    out.push(label ? `{start_of_${tag}: ${label}}` : `{start_of_${tag}}`);
    if (sec.sidebar_note && sec.sidebar_note.trim()) {
      out.push(`{note: ${sec.sidebar_note.trim()}}`);
    }
    for (const l of sec.lines || []) {
      if (l.text == null) continue;
      const text = String(l.text);
      if (!l.tab && /^\((?:repeat|x\d|\d+x)[^)]*\)$/i.test(text.trim())) {
        out.push(`{comment: ${text.trim().slice(1, -1)}}`);
      } else {
        out.push(text);
      }
    }
    out.push(`{end_of_${tag}}`);
    if (idx < sheet.sections.length - 1) out.push("");
  });
  return out.join("\n");
}
