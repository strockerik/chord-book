// Supabase Edge Function: import-sheet
//
// Accepts messy/ugly pasted chord text, 1-6 screenshot snips / camera photos,
// a PDF document upload, or a public link. Uses Claude Sonnet 4.6 for everything:
// rebuilding a messy paste into clean lines is the hard part, and imports are rare.
// Validates output through the Chord Net (every [chord] token parses under
// the Chord Book grammar; sections non-empty) and repairs once if needed.
//
// Request body (JSON):
//   { type: "text", text: "<pasted text>", layout?: ["[G]lines with exact chord columns"], note?: "<optional steer>" }
//   { type: "image", images: [{ mediaType: "image/jpeg"|"image/png"|"image/webp", data: "<base64>" }], note?: "<optional steer>" }
//   { type: "pdf", pdfData: "<base64>", fileName?: "...", note?: "<optional steer>" }
//   { type: "url", url: "<public sheet page>", note?: "<optional steer>" }
//
// Response: always HTTP 200 with
//   { result: { title, artist, key, capo, tempo, time_signature, tuning, genre, form, chordpro, notes },
//     results: [every song found; a set list PDF can hold several], missed: songs that couldn't be read }
// or { error: "..." }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getDocumentProxy } from "npm:unpdf@0.12.1";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL_TEXT = "claude-sonnet-4-6";
const MODEL_VISION = "claude-sonnet-4-6";
const DAILY_IMPORT_LIMIT = 20;
// Accounts that skip the daily limit (the owner and the test account), set as the Supabase
// secret CB_UNLIMITED_EMAILS, comma-separated. Kept out of this public file.
const UNLIMITED_EMAILS = new Set(
  (Deno.env.get("CB_UNLIMITED_EMAILS") || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const LIMIT_CHECK_FAILED = "Couldn’t check today’s limit — try again in a minute.";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_IMAGES = 6;
const MAX_SONGS_PER_IMPORT = 8;
const MAX_NOTE_CHARS = 350;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
function supabaseClientKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const key = typeof keys.default === "string"
      ? keys.default
      : Object.values(keys).find((v) => typeof v === "string");
    if (key) return key as string;
  } catch { /* not JSON */ }
  console.error("SUPABASE_PUBLISHABLE_KEYS is missing — database calls will fail.");
  return "";
}
const SUPABASE_CLIENT_KEY = supabaseClientKey();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

// ==== CHORD NET ====
const NOTE_NAMES = new Set([
  "C", "B#", "C#", "Db", "D", "D#", "Eb", "E", "Fb", "F", "E#",
  "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B", "Cb"
]);
const QUALITY_RE = /^(?:maj13|maj11|maj9|maj7|M7|Δ7|Δ|min11|min9|min7b5|min7|min6|min|m13|m11|m9|m7b5|m7|m6|mmaj7|m|-(?:7|9|11)?|dim7|dim|°7|°|ø7|ø|aug7|aug|\+7|\+|sus2sus4|sus4|sus2|sus|add11|add9|add4|add2|7sus4|7sus2|9sus4|13|11|9|7|6\/9|69|6|5|4|2)?(?:(?:\(?[b#](?:5|9|11|13)\)?)*)$/;
const ROOT_RE = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/;

function isValidChordToken(token: string): boolean {
  if (!token || typeof token !== "string") return false;
  const trimmed = token.trim();
  if (trimmed === "N.C." || trimmed === "NC") return true;
  const m = trimmed.match(ROOT_RE);
  if (!m) return false;
  const [, root, quality, bass] = m;
  if (!NOTE_NAMES.has(root)) return false;
  if (bass && !NOTE_NAMES.has(bass)) return false;
  return QUALITY_RE.test(quality || "");
}

function validateSheetOutput(sheet: {
  title?: string;
  key?: string;
  capo?: number;
  sections?: Array<{ type?: string; label?: string | null; lines?: Array<{ text?: string; tab?: boolean }> }>;
}): string[] {
  const problems: string[] = [];
  if (!sheet || typeof sheet !== "object") return ["Missing sheet output"];
  if (!sheet.title || !String(sheet.title).trim()) problems.push("Missing song title");
  if (!sheet.key || !isValidChordToken(String(sheet.key).trim())) {
    problems.push(`Invalid or missing key: ${sheet.key}`);
  }
  const sections = Array.isArray(sheet.sections) ? sheet.sections : [];
  if (sections.length === 0) {
    problems.push("Sheet has no sections");
  }
  let totalLines = 0;
  const badChords: string[] = [];
  for (const sec of sections) {
    const lines = Array.isArray(sec.lines) ? sec.lines : [];
    if (sec.type === "chorus_repeat") continue;
    if (lines.length === 0) {
      problems.push(`Empty section "${sec.label || sec.type || "section"}"`);
    }
    for (const l of lines) {
      totalLines++;
      const txt = String(l.text || "");
      if (l.tab) continue;
      const re = /\[([^\]]+)\]/g;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const tok = m[1].trim();
        if (!isValidChordToken(tok) && !badChords.includes(tok)) {
          badChords.push(tok);
        }
      }
    }
  }
  if (totalLines > 200) {
    problems.push(`Too many lines (${totalLines}, max 200)`);
  }
  if (badChords.length > 0) {
    problems.push(`Invalid chord tokens inside brackets: ${badChords.join(", ")}`);
  }
  return problems;
}
// ==== END CHORD NET ====

const TUNING_VALUES: Record<string, string> = {
  standard: "E A D G B E",
  half: "Eb Ab Db Gb Bb Eb",
  drop_d: "D A D G B E",
  other: "Other"
};
const GENRES = ["worship", "country", "rock", "pop"];

// ==== LAYOUT ====
// Exact chord placement for imports.
//
// The AI is good at reading and organizing a sheet but drifts when it places chords: it tends
// to slide a chord onto the first word of a line. When the source records where each chord
// sits, we use that instead:
//   - PDFs with a text layer: each chord's x position over the lyric line below it.
//   - Pasted text: the app's own column-exact formatter sends its lines as `layout`.
// realignToLayout() then swaps in the exact line wherever the AI's line has the same words
// and the same chords, and leaves everything else as the AI wrote it.

// Helvetica/Arial advance widths (1/1000 em) for printable ASCII, starting at space.
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];
function charWidth(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return WIDTHS[code - 32];
  if (ch === "’" || ch === "‘") return 222;
  if (ch === "“" || ch === "”") return 333;
  return 556;
}

type TextItem = { str: string; x: number; y: number; width: number; size: number; mono: boolean };
type Glyph = { ch: string; x: number; w: number };

// Spreads an item's measured width over its characters in proportion to typical letter widths.
// Monospaced text (common in chord PDFs) gets equal widths, which is exact.
function glyphsOf(item: TextItem): Glyph[] {
  const chars = [...item.str];
  const widthOf = (ch: string) => (item.mono ? 1 : charWidth(ch));
  const units = chars.reduce((sum, ch) => sum + widthOf(ch), 0) || 1;
  const scale = item.width / units;
  const out: Glyph[] = [];
  let x = item.x;
  for (const ch of chars) {
    const w = widthOf(ch) * scale;
    out.push({ ch, x, w });
    x += w;
  }
  return out;
}

const CHORD_TOKEN = /^(?:[A-G][#b]?(?:maj|min|m|M|dim|aug|sus|add|°|ø|\+)?[0-9]*(?:sus[24]?|add[0-9]+|[b#][0-9]+)*(?:\/[A-G][#b]?)?|N\.?C\.?)$/;

function lineGlyphs(items: TextItem[]): Glyph[] {
  const glyphs: Glyph[] = [];
  for (const item of items.sort((a, b) => a.x - b.x)) {
    const g = glyphsOf(item);
    if (!g.length) continue;
    const last = glyphs[glyphs.length - 1];
    if (last && g[0].x - (last.x + last.w) > item.size * 0.2 && last.ch !== " " && g[0].ch !== " ") {
      glyphs.push({ ch: " ", x: last.x + last.w, w: g[0].x - (last.x + last.w) });
    }
    glyphs.push(...g);
  }
  return glyphs;
}

// Chords in a line, each with the x where it starts. Null when the line isn't all chords.
type PlacedChord = { chord: string; x: number; dashed?: boolean };

// "Em - D" means both chords share one word: the D goes on the next syllable.
function chordsOf(glyphs: Glyph[]): PlacedChord[] | null {
  const out: PlacedChord[] = [];
  let token = "";
  let start = 0;
  let dash = false;
  const flush = () => {
    if (!token) return true;
    const t = token.replace(/^[(\[]+|[)\],]+$/g, "");
    token = "";
    if (/^[-–]+$/.test(t)) { dash = out.length > 0; return true; }
    if (!t || /^[|/.]+$/.test(t) || /^\(?x\d+\)?$|^\d+x$/i.test(t)) return true;
    if (!CHORD_TOKEN.test(t)) return false;
    out.push({ chord: t, x: start, dashed: dash });
    dash = false;
    return true;
  };
  for (const g of glyphs) {
    if (g.ch === " " || g.ch === "\u00a0") {
      if (!flush()) return null;
    } else {
      if (!token) start = g.x;
      token += g.ch;
    }
  }
  if (!flush()) return null;
  return out.length ? out : null;
}

const VOWEL = /[aeiouy]/i;
const DIGRAPH = /^(?:sh|ch|th|ph|wh|gh|ck|qu|ng)$/i;

// Where a word can be split into sung syllables: "mea|sure", "on|ly", "Be|hold", "moc|king".
// Rough rules (V-CV, VC-CV, consonant pairs kept together), and a silent final e is not a syllable.
function syllableStarts(word: string): number[] {
  const starts = [0];
  const w = word.toLowerCase();
  for (let i = 1; i < w.length - 1; i++) {
    if (!VOWEL.test(w[i - 1]) || VOWEL.test(w[i]) || !/[a-z]/.test(w[i])) continue;
    // w[i..j) is a run of consonants between two vowels.
    let j = i;
    while (j < w.length && /[a-z]/.test(w[j]) && !VOWEL.test(w[j])) j++;
    if (j >= w.length || !VOWEL.test(w[j])) { i = j; continue; }
    const run = w.slice(i, j);
    // One consonant goes with the next syllable (mea|sure); of two, split them (on|ly),
    // unless they make one sound (a|shamed); of three, keep the last pair together (com|plished).
    let cut = run.length === 1 || (run.length === 2 && DIGRAPH.test(run)) ? i : i + 1;
    if (run.length >= 3 && DIGRAPH.test(run.slice(-2))) cut = j - 2;
    // A silent final e is not a syllable: ma|ke, the|re, fi|nished stay whole there.
    if (!/^[^aeiouy]{1,2}e[sd]?$/.test(w.slice(cut))) starts.push(cut);
    i = j - 1;
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

// Moves a chord that lands inside a word to the nearest syllable start.
function snapToSyllable(text: string, i: number): number {
  if (i >= text.length || !/[A-Za-z']/.test(text[i])) {
    // Landed on punctuation after a word ("son," -> on "son").
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
function placeChords(chords: PlacedChord[], lyric: Glyph[]): string {
  const text = lyric.map((g) => g.ch).join("").replace(/\s+$/, "");
  const slots = new Map<number, string[]>();
  let prev = -1;
  for (const { chord, x, dashed } of chords) {
    let i = lyric.findIndex((g) => x < g.x + g.w * 0.6);
    if (i < 0 || i > text.length) i = text.length;
    // A chord over the gap between words belongs to the next word.
    while (i < text.length && text[i] === " ") i++;
    if (i < text.length) i = snapToSyllable(text, i);
    if (dashed && prev >= 0) {
      // Next syllable of the word the previous chord is on, when it has one.
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
    // Chords after the last word are played after it: "name. [A]".
    out += i === text.length ? here.map((c) => ` [${c}]`).join("") : here.map((c) => `[${c}]`).join("");
    if (i < text.length) out += text[i];
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Lyric lines with chords placed from the PDF's text layer. Empty if the PDF has no text layer. */
async function pdfLayoutLines(bytes: Uint8Array, maxPages = 12): Promise<string[]> {
  const pdf = await getDocumentProxy(bytes);
  const out: string[] = [];
  for (let p = 1; p <= Math.min(pdf.numPages, maxPages); p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // deno-lint-ignore no-explicit-any
    const styles = (content as any).styles || {};
    // Screen coordinates (y grows downward), so rotated pages read the same as upright ones.
    const vp = page.getViewport({ scale: 1 }).transform as number[];
    const items: TextItem[] = [];
    // deno-lint-ignore no-explicit-any
    for (const raw of content.items as any[]) {
      if (typeof raw.str !== "string" || !raw.str) continue;
      const [a, b, c, d, e, f] = raw.transform as number[];
      const m = [
        vp[0] * a + vp[2] * b, vp[1] * a + vp[3] * b,
        vp[0] * c + vp[2] * d, vp[1] * c + vp[3] * d,
        vp[0] * e + vp[2] * f + vp[4], vp[1] * e + vp[3] * f + vp[5]
      ];
      items.push({
        str: raw.str.replace(/\u00a0/g, " "),
        x: m[4],
        y: m[5],
        width: raw.width,
        size: Math.hypot(m[2], m[3]) || 11,
        mono: styles[raw.fontName]?.fontFamily === "monospace" || /mono|courier/i.test(String(styles[raw.fontName]?.fontFamily || ""))
      });
    }
    for (const column of splitColumns(items)) out.push(...pairChordsWithLyrics(column));
  }
  return out;
}

// A page set in two columns would otherwise mix chords from one column into the other.
function splitColumns(items: TextItem[]): TextItem[][] {
  const words = items.filter((it) => /[a-z]{3}/.test(it.str) && it.width > 30);
  if (words.length < 6) return [items];
  const minX = Math.min(...items.map((it) => it.x));
  const maxX = Math.max(...items.map((it) => it.x + it.width));
  let best: number | null = null;
  let bestGap = 0;
  for (let c = minX + (maxX - minX) * 0.3; c <= minX + (maxX - minX) * 0.7; c += 2) {
    if (words.some((it) => it.x < c && it.x + it.width > c)) continue;
    const left = words.filter((it) => it.x + it.width <= c);
    const right = words.filter((it) => it.x >= c);
    if (left.length < 3 || right.length < 3) continue;
    const gap = Math.min(...right.map((it) => it.x)) - Math.max(...left.map((it) => it.x + it.width));
    if (gap > bestGap) { bestGap = gap; best = Math.max(...left.map((it) => it.x + it.width)) + gap / 2; }
  }
  if (best === null) return [items];
  return [items.filter((it) => it.x < best!), items.filter((it) => it.x >= best!)];
}

function pairChordsWithLyrics(items: TextItem[]): string[] {
  const out: string[] = [];
  const rows = new Map<number, TextItem[]>();
  for (const item of items) {
    const key = [...rows.keys()].find((y) => Math.abs(y - item.y) < item.size * 0.3) ?? item.y;
    rows.set(key, [...(rows.get(key) || []), item]);
  }
  {
    const lines = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([y, row]) => ({ y, glyphs: lineGlyphs(row), size: row[0].size }));
    for (let i = 0; i < lines.length - 1; i++) {
      const chords = chordsOf(lines[i].glyphs);
      if (!chords) continue;
      const below = lines[i + 1];
      const words = below.glyphs.map((g) => g.ch).join("");
      if (below.y - lines[i].y > lines[i].size * 2.4 || !/[a-z]/.test(words) || chordsOf(below.glyphs)) continue;
      out.push(placeChords(chords, below.glyphs));
      i++;
    }
  }
  return out;
}

const wordsKey = (line: string) =>
  line.replace(/\[[^\]]*\]/g, "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, " ").trim();
const chordList = (line: string) => [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());

/**
 * Replaces the AI's chord placement with the exact one from the source wherever both have the
 * same words and the same number of chords. Returns how many lines changed.
 */
function realignToLayout(
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
  let changed = 0;
  for (const sec of sections || []) {
    for (const line of sec.lines || []) {
      if (line.tab || typeof line.text !== "string") continue;
      const candidates = byWords.get(wordsKey(line.text));
      if (!candidates) continue;
      const mine = chordList(line.text);
      const match = candidates.find((c) => chordList(c).length === mine.length);
      if (!match || match === line.text) continue;
      line.text = match;
      changed++;
    }
  }
  return changed;
}

/** Text pastes keep exact columns; this only moves chords that land inside a word to a syllable start. */
function snapLayoutLine(line: string): string {
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

// Convert validated structured sheet JSON into canonical ChordPro
function sheetToChordPro(sheet: {
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
      // A line that is only a note in parentheses, like "(Repeat 4x)", prints as a comment.
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

// URL safety helpers (copied from House Index)
function parseAllowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes("[")) return null;
  const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return null;
    }
  }
  return url;
}

function isPrivateAddress(addr: string): boolean {
  const v4 = addr.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const low = addr.toLowerCase();
  return low === "::1" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd");
}

async function resolvesPublic(host: string): Promise<boolean> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateAddress(host);
  const resolve = (Deno as unknown as { resolveDns?: (q: string, t: "A" | "AAAA") => Promise<string[]> }).resolveDns;
  if (typeof resolve !== "function") return true;
  const lookups = await Promise.allSettled([resolve(host, "A"), resolve(host, "AAAA")]);
  const addrs = lookups.flatMap((r) => (r.status === "fulfilled" ? (r.value as string[]) : []));
  if (!addrs.length) return true;
  return addrs.every((a) => !isPrivateAddress(a));
}

const MAX_PAGE_BYTES = 5_000_000;
async function readCapped(res: Response, maxBytes = MAX_PAGE_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total >= maxBytes) await reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, buf.length - off);
    buf.set(c.subarray(0, n), off);
    off += n;
    if (off >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

// Pulls the song text out of a chord-site page: Ultimate Guitar keeps the sheet in a JSON
// attribute, many sites put it in <pre>, and the rest is the page text without scripts.
function pageTextForImport(pageHtml: string): string {
  const decode = (t: string) => t
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const store = pageHtml.match(/class="js-store"\s+data-content="([^"]+)"/);
  if (store) {
    try {
      const data = JSON.parse(decode(store[1]));
      const page = data?.store?.page?.data;
      const content = page?.tab_view?.wiki_tab?.content;
      if (typeof content === "string" && content.trim()) {
        const head = [page?.tab?.song_name, page?.tab?.artist_name].filter(Boolean).join(" by ");
        const capo = page?.tab_view?.meta?.capo ? `\nCapo: ${page.tab_view.meta.capo}` : "";
        return `${head}${capo}\n\n${content.replace(/\[\/?(?:ch|tab)\]/g, "")}`.slice(0, 25_000);
      }
    } catch { /* fall through to the page text */ }
  }
  const title = decode((pageHtml.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim();
  const withoutCode = pageHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const pres = [...withoutCode.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((m) => m[1]);
  const body = pres.join("\n\n").replace(/<[^>]+>/g, "").trim().length > 200 ? pres.join("\n\n") : withoutCode;
  const text = decode(body.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? `${title}\n\n${text}`.slice(0, 25_000) : "";
}

const SHEET_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Song title only (not the artist, album, or site name)" },
    artist: { type: ["string", "null"] },
    key: { type: "string", description: "Key of the chord shapes as written, e.g. 'G', 'D', 'Em', 'Bb'" },
    capo: { type: "integer", description: "Capo fret 0-12 (0 if none)" },
    tuning: { type: "string", enum: ["standard", "half", "drop_d", "other"], description: "'half' = half step down (Eb tuning)" },
    tempo: { type: "integer", description: "Beats per minute. Use the stated tempo; otherwise the tempo of the well-known recording; otherwise your best estimate for the style." },
    time_signature: { type: "string", description: "e.g. '4/4', '3/4', '6/8'" },
    genre: { type: "string", enum: ["worship", "country", "rock", "pop"], description: "worship = Christian worship or hymns; country = country and folk; rock = rock, punk, emo, indie, alternative; pop = everything else" },
    form: { type: "string", description: "The order the song is played, e.g. 'Intro (4x) • V1 • Chorus • V2 • Chorus • Bridge (2x) • Chorus • Outro'" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["verse", "chorus", "chorus_repeat", "pre_chorus", "bridge", "intro", "outro", "instrumental", "tab"] },
          label: { type: ["string", "null"], description: "e.g. 'Intro (4x)', 'Verse 1', 'Chorus', 'Bridge (2x)'" },
          sidebar_note: { type: ["string", "null"], description: "Short playing cue from the source for this section, e.g. 'Palm muted', 'Bass comes in'" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "One sung line with each [Chord] directly before the syllable it is played on, e.g. '[G]Rivers run [C]down to the [D]sea'. Chord-only lines look like '[G]   [C]   [D]'." },
                tab: { type: "boolean" }
              },
              required: ["text", "tab"]
            }
          }
        },
        required: ["type", "label", "sidebar_note", "lines"]
      }
    },
    notes: { type: ["string", "null"], description: "Anything a player needs that isn't in a section, or null" },
    other_songs: { type: "array", items: { type: "string" }, description: "Titles of the other complete songs in the input, in order. Empty when the input is one song." }
  },
  required: ["title", "artist", "key", "capo", "tuning", "tempo", "time_signature", "genre", "form", "sections", "notes", "other_songs"]
};

const SYSTEM_PROMPT = `You turn guitar chord sheets into clean Chord Book sheets. People read them while playing guitar and singing, so every chord must sit on the right word and every line must read like the song.

The input may be a messy copy from a chord website, screenshots, a photo, a PDF, or an existing sheet to check.

READ THE MESS:
- Phone copies from sites like Chordie or AZChords put each chord and the word under it on separate lines, and break one sung line into many short pieces. A chord on its own line belongs on the word right after it. Put the pieces back into the original sung lines, about one phrase per line.
- Drop site clutter: album names, years, "this is 100% correct", ratings, chord voicing lists like "D - x57775", fret numbers, ads, and page buttons.
- Sites often list the artist first, then the title. Return the song title as title and the band or singer as artist.
- Read "Key:", "Capo:", tuning notes ("half step down", "Eb tuning", "Drop D"), and tempo when given.
- Photos may be sideways, and a page may have two columns: read column one, then column two. Screenshots may overlap or repeat: include every line once, in order.
- Drop chord shape diagrams, finger charts, copyright and CCLI lines, "submitted by" lines, video links, and buttons like "View Lyrics". A small block of tab or fret numbers that only shows how to finger one chord (often under a chord name at the top) is a chord diagram, not part of the song.
- Write the title in Title Case, even if the source is all capitals.
- Artist is the performing artist. A hymn or chart with only writer credits ("Words and Music by...") uses the writers' names: "A & B" or "A, B & C". Only people or bands, never "Traditional" or "American folk tune". Use null when no name is given.
- key is the key the song starts in, even if it changes key later.
- Section names in the source can be wrong. A chorus comes back with the same words; a section whose words never come back is a verse, even if the source calls it "Chorus" or "Refrain".
- If the input holds more than one song, transcribe only the first one and list the others in other_songs.

KEEP IT FAITHFUL:
- Never change, add, or simplify chords, and copy each chord name exactly as written: A2 stays A2, Esus stays Esus. Never rewrite lyrics. Keep backing vocals in parentheses as their own lines.
- A dashed chord run like "A/C#-D" means quick changes: write it as "[A/C#] [D]".
- "G (hold)" means hold that chord: put [G] on the next word and keep "(hold)" right after it.
- Every [ ] holds only a real chord, like [G], [G/B], [Dsus4], [F#m], [Am7]. Section names never go in brackets.
- Put each chord exactly where the source puts it: on the word or syllable printed directly under it. Don't move chords to where you think they belong. A line often starts with words before its first chord ("How [D]deep the Father's [Em]love"), so never pull the first chord to the start of the line unless the source puts it there. A chord in the middle of a word goes in the middle: "un[Bm]less".
- Hymns often print chords only on verse 1. When later verses are sung to the same tune, give them the same chords on the matching syllables, so every verse can be played.
- Bar charts like "| A | C#m7 | Bsus |" become a chord-only line: "[A]   [C#m7]   [Bsus]".
- Guitar tab (lines like "e|--3--" or "E:--3--") goes in a section of type "tab", copied exactly with tab true, under the part name from the source. Never invent chords that the source doesn't show.

ORGANIZE IT:
- One section per part, in the order it is played, labeled Intro, Verse 1, Verse 2, Pre-Chorus, Chorus, Bridge, Outro, or Interlude. Always call the chorus "Chorus", never "Refrain".
- Write the chorus out in full the first time. Each later time it is played, add a section of type "chorus_repeat" with no lines. Do this for "(Repeat Chorus)" notes too.
- When a whole section repeats, put the count in its label: "Bridge (2x)". When only some lines repeat, add a line "(Repeat 4x)" after them.
- Notes after a section name, like "Intro: ... Palm muted" or "Verse 1: Bass will enter", become that section's sidebar_note. Chords written after "Intro:" become the intro's chord line.
- "form" lists every section as played, using V1, V2 for verses and "Chorus" for each chorus, with repeat counts.`;

// Same RPC and token accounting as House Index (supabase/sql/v1.9-part1.sql). Never throws.
// deno-lint-ignore no-explicit-any
async function logAiCall(client: any, task: string, model: string, valid: boolean, ms: number, usage?: any, userId?: string) {
  try {
    const input = usage?.input_tokens;
    const { error } = await client.rpc("log_ai_call", {
      p_task: task,
      p_model: model,
      p_valid: valid,
      p_latency_ms: Math.round(ms),
      p_escalated: false,
      p_input_tokens: input == null ? null : input + (usage?.cache_creation_input_tokens ?? 0),
      p_output_tokens: usage?.output_tokens ?? null,
      p_cache_read_tokens: usage?.cache_read_input_tokens ?? null,
      p_web_searches: null,
      p_user_id: userId ?? null
    });
    if (error) console.error("log_ai_call failed:", error.message ?? error);
  } catch (e) {
    console.error("log_ai_call failed:", e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" });

  // 1. Check caller is signed in before anything paid
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Please sign in to use AI import." });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_CLIENT_KEY, {
    global: { headers: { Authorization: authHeader } }
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Please sign in to use AI import." });
  }
  const userId = userData.user.id;

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "AI import is not configured on this server (missing ANTHROPIC_API_KEY)." });
  }

  // 2. Validate input before checking cap
  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON request body." });
  }

  const reqType = String(body?.type || "");
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE_CHARS) : "";
  // deno-lint-ignore no-explicit-any
  const userContent: any[] = [];
  let model = MODEL_TEXT;

  // Where the source says each chord sits, used to correct the AI's chord placement.
  let layout: string[] = [];

  if (reqType === "text") {
    if (Array.isArray(body?.layout)) {
      layout = body.layout
        .filter((l: unknown) => typeof l === "string" && l.length <= 400)
        .slice(0, 600)
        .map((l: string) => snapLayoutLine(l));
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length < 10) return json({ error: "Paste a chord sheet first." });
    if (text.length > 40_000) return json({ error: "Pasted text is too long (max 40,000 characters)." });
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") + `Transcribe and align this chord sheet:\n\n${text}`
    });
    model = MODEL_TEXT;
  } else if (reqType === "image") {
    const imgs = Array.isArray(body?.images) ? body.images : [];
    if (!imgs.length || imgs.length > MAX_IMAGES) {
      return json({ error: `Attach between 1 and ${MAX_IMAGES} images.` });
    }
    for (const img of imgs) {
      if (!ALLOWED_IMAGE_TYPES.includes(img?.mediaType) || typeof img?.data !== "string" || !img.data) {
        return json({ error: "Unsupported image format (use JPEG, PNG, or WebP)." });
      }
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data }
      });
    }
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") +
        "Transcribe the guitar chord sheet from these image(s). If multiple screenshots overlap, stitch and deduplicate them into one complete song with exact [Chord] placement over each syllable."
    });
    model = MODEL_VISION;
  } else if (reqType === "pdf") {
    const pdfData = typeof body?.pdfData === "string" ? body.pdfData.trim() : "";
    if (!pdfData) return json({ error: "Attach a PDF file first." });
    if (pdfData.length > 7_500_000) return json({ error: "PDF is too large (max 5 MB)." });
    try {
      const bytes = Uint8Array.from(atob(pdfData), (ch) => ch.charCodeAt(0));
      layout = await pdfLayoutLines(bytes);
    } catch (e) {
      console.error("PDF text layer unreadable; using the AI's placement:", e);
    }
    userContent.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfData }
    });
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") +
        "Transcribe the guitar chord sheet from this PDF into structured sections with inline [Chord] placement."
    });
    model = MODEL_VISION;
  } else if (reqType === "url") {
    const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
    const url = parseAllowedUrl(rawUrl);
    if (!url || !(await resolvesPublic(url.hostname))) {
      return json({ error: "That doesn’t look like a valid public link." });
    }
    let pageHtml = "";
    try {
      const pageRes = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ChordBook/0.1)",
          "Accept": "text/html,text/plain"
        }
      });
      const landed = pageRes.redirected ? parseAllowedUrl(pageRes.url) : url;
      if (!landed || (pageRes.redirected && !(await resolvesPublic(landed.hostname)))) {
        await pageRes.body?.cancel();
        return json({ error: "That link redirects somewhere we can’t read — copy and paste the sheet instead." });
      }
      pageHtml = await readCapped(pageRes);
      if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
    } catch {
      return json({ error: "Couldn’t load that page — copy the chords and paste them instead." });
    }
    const pageText = pageTextForImport(pageHtml);
    if (pageText.length < 200) {
      return json({ error: "That page builds itself in the browser, so it can’t be read from a link. Copy the song and paste it instead." });
    }
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") + `Extract the chord sheet from this page (${url.hostname}):\n\n${pageText}`
    });
    model = MODEL_TEXT;
  } else {
    return json({ error: "Unsupported import type." });
  }

  // 3. Check daily cap right before paid call (fail closed!)
  const unlimited = UNLIMITED_EMAILS.has(String(userData.user.email || "").toLowerCase());
  if (!unlimited) {
    const { data: capCount, error: capErr } = await supabase.rpc("increment_ai_usage", {
      usage_kind: "cb_import",
      daily_limit: DAILY_IMPORT_LIMIT
    });
    if (capErr || typeof capCount !== "number") {
      console.error("increment_ai_usage failed:", capErr);
      return json({ error: LIMIT_CHECK_FAILED });
    }
    if (capCount < 0) {
      return json({ error: `You’ve reached today’s limit of ${DAILY_IMPORT_LIMIT} AI imports. Free paste import still works anytime.` });
    }
  }

  // 4. Call Anthropic with tool schema + Chord Net validation + 1 repair attempt
  // deno-lint-ignore no-explicit-any
  async function callClaude(messages: any[], retry = true): Promise<{ toolInput: any; usage: any; ms: number; stopReason: string }> {
    const t0 = performance.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model,
        // Billed on actual output, so a long song's headroom costs nothing extra.
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: [{
          name: "save_chord_sheet",
          description: "Return the transcribed guitar chord sheet",
          input_schema: SHEET_SCHEMA
        }],
        tool_choice: { type: "tool", name: "save_chord_sheet" },
        messages
      })
    });
    const ms = performance.now() - t0;
    const payload = await res.json().catch(() => null);
    // Busy or a passing server error: wait a moment and try once more.
    if (retry && [429, 500, 502, 503, 529].includes(res.status)) {
      console.error(`Anthropic HTTP ${res.status}; retrying once`);
      await new Promise((r) => setTimeout(r, 2500));
      return callClaude(messages, false);
    }
    if (!res.ok) {
      if ([429, 529].includes(res.status)) throw new Error("BUSY");
      await logAiCall(supabase, "cb_import", model, false, ms, payload?.usage, userId);
      const reason = String(payload?.error?.message || "").slice(0, 160);
      console.error(`Anthropic HTTP ${res.status}:`, reason);
      if (/credit balance/i.test(reason)) throw new Error("NO_CREDIT");
      throw new Error(`API:${res.status} ${reason}`);
    }
    if (payload?.stop_reason === "refusal") throw new Error("REFUSED");
    if (payload?.stop_reason === "max_tokens") throw new Error("TOO_LONG");
    // deno-lint-ignore no-explicit-any
    const toolBlock = (payload?.content || []).find((b: any) => b.type === "tool_use" && b.name === "save_chord_sheet");
    return { toolInput: toolBlock?.input || null, usage: payload?.usage, ms, stopReason: payload?.stop_reason };
  }

  // One song: ask, check every chord, and repair once if the check fails.
  // `focus` names the song to read when the input holds several.
  // deno-lint-ignore no-explicit-any
  async function transcribe(focus: string | null): Promise<{ sheet: any; problems: string[] }> {
    const content = focus
      ? [...userContent, { type: "text", text: `This input holds several songs. Transcribe only "${focus}" and leave other_songs empty.` }]
      : userContent;
    // deno-lint-ignore no-explicit-any
    const messages: any[] = [{ role: "user", content }];
    let attempt = await callClaude(messages);
    if (layout.length && attempt.toolInput?.sections) realignToLayout(attempt.toolInput.sections, layout, isValidChordToken);
    let problems = validateSheetOutput(attempt.toolInput);
    await logAiCall(supabase, focus ? "cb_import_more" : "cb_import", model, problems.length === 0, attempt.ms, attempt.usage, userId);
    if (problems.length > 0 && attempt.toolInput) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: "repair_1", name: "save_chord_sheet", input: attempt.toolInput }]
      });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "repair_1",
          content: `Validation failed: ${problems.join("; ")}. Fix every problem and call save_chord_sheet again.`
        }]
      });
      attempt = await callClaude(messages);
      if (layout.length && attempt.toolInput?.sections) realignToLayout(attempt.toolInput.sections, layout, isValidChordToken);
      problems = validateSheetOutput(attempt.toolInput);
      await logAiCall(supabase, "cb_import_repair", model, problems.length === 0, attempt.ms, attempt.usage, userId);
    }
    return { sheet: attempt.toolInput, problems: attempt.toolInput ? problems : ["No sheet returned"] };
  }

  // deno-lint-ignore no-explicit-any
  function resultFor(sheet: any) {
    const tempo = Number(sheet.tempo);
    return {
      title: sheet.title,
      artist: sheet.artist,
      key: sheet.key,
      capo: sheet.capo || 0,
      tempo: tempo >= 20 && tempo <= 300 ? Math.round(tempo) : null,
      time_signature: sheet.time_signature || "4/4",
      tuning: TUNING_VALUES[sheet.tuning] || TUNING_VALUES.standard,
      genre: GENRES.includes(sheet.genre) ? sheet.genre : "pop",
      form: typeof sheet.form === "string" ? sheet.form.replace(/^form:\s*/i, "").trim() : "",
      notes: sheet.notes,
      chordpro: sheetToChordPro(sheet)
    };
  }

  try {
    const first = await transcribe(null);
    if (first.problems.length > 0) {
      return json({ error: `Couldn’t check the chords (${first.problems.join(", ")}). Try pasting the text instead.` });
    }
    const results = [resultFor(first.sheet)];

    // A set list PDF or several photos can hold more songs. Read them side by side so the
    // whole import stays well inside the function's time limit.
    const others = (Array.isArray(first.sheet.other_songs) ? first.sheet.other_songs : [])
      .filter((t: unknown) => typeof t === "string" && t.trim())
      .slice(0, MAX_SONGS_PER_IMPORT - 1);
    if (others.length) {
      const more = await Promise.allSettled(others.map((title: string) => transcribe(title.trim())));
      for (const r of more) {
        if (r.status === "fulfilled" && r.value.problems.length === 0) results.push(resultFor(r.value.sheet));
      }
    }
    return json({ result: results[0], results, missed: others.length + 1 - results.length });
  } catch (err) {
    console.error("import-sheet error:", err);
    const msg = err instanceof Error ? err.message : "";
    if (msg === "REFUSED") return json({ error: "The AI declined to read that. Try the pasted text instead." });
    if (msg === "TOO_LONG") return json({ error: "That song was too long to read in one go. Try pasting it in two parts." });
    if (msg === "BUSY") return json({ error: "The AI is busy right now. Try again in a minute." });
    if (msg === "NO_CREDIT") return json({ error: "The AI account is out of credit. Add credit in the Anthropic console." });
    // The API's own reason (never secret) helps the owner see what went wrong.
    const reason = msg.startsWith("API:") ? ` (${msg.slice(4)})` : "";
    return json({ error: `The AI couldn’t read that${reason}. Try again, or the app can format it without AI.` });
  }
});
