// Digital PDF text-layer geometry & chord/section extraction for import-sheet.
// Unified on `isValidChordToken` (no separate PDF-only chord regex),
// and preserves section headings + chord-only lines so clean single-song PDFs can use Track A.

import { getDocumentProxy } from "npm:unpdf@0.12.1";
import { isValidChordToken } from "./chord_net.ts";
import {
  Glyph,
  PlacedChord,
  placeChords,
  parseSectionHeader,
  isGuitarTabLine,
  isClutterLine,
  parseStructuredSheet
} from "./layout.ts";

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

export type TextItem = { str: string; x: number; y: number; width: number; size: number; mono: boolean };

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

function lineGlyphs(items: TextItem[]): Glyph[] {
  const glyphs: Glyph[] = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
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

/**
 * Chords in a PDF line, each with the x where it starts. Null when the line isn't all chords.
 * Unified on `isValidChordToken` so PDFs accept `6/9`, `Δ`, `-7`, `mmaj7`, `A2`, etc.
 */
export function chordsOf(glyphs: Glyph[], isValid: (c: string) => boolean = isValidChordToken): PlacedChord[] | null {
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
    const parts = t.split(/-(?=[A-G])/);
    if (!parts.every((c) => isValid(c))) return false;
    for (let idx = 0; idx < parts.length; idx++) {
      out.push({ chord: parts[idx], x: start, dashed: idx > 0 || dash });
    }
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

// A page set in two columns would otherwise mix chords from one column into the other.
export function splitColumns(items: TextItem[]): TextItem[][] {
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

export type ColumnExtract = {
  layoutLines: string[];
  structuredLines: string[];
  sectionHeaderCount: number;
};

/**
 * Extracts both exact chord+lyric pairs (`layoutLines`, for Track B realignment)
 * and full structured lines (`structuredLines`, preserving section headings, chord-only
 * instrumental lines, and plain lyric lines for Track A single-song digital PDFs).
 */
export function extractColumnLines(items: TextItem[], isValid: (c: string) => boolean = isValidChordToken): ColumnExtract {
  const layoutLines: string[] = [];
  const structuredLines: string[] = [];
  let sectionHeaderCount = 0;

  const rows = new Map<number, TextItem[]>();
  for (const item of items) {
    const key = [...rows.keys()].find((y) => Math.abs(y - item.y) < item.size * 0.3) ?? item.y;
    rows.set(key, [...(rows.get(key) || []), item]);
  }
  const lines = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, row]) => ({
      y,
      glyphs: lineGlyphs(row),
      size: Math.max(...row.map((r) => r.size))
    }));

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const rawText = cur.glyphs.map((g) => g.ch).join("").replace(/\s+/g, " ").trim();
    if (!rawText) continue;

    // Preserve section headings ("Verse 1", "Chorus", "Bridge", "Intro", etc.)
    const hdr = parseSectionHeader(rawText, isValid);
    if (hdr) {
      if (hdr.type !== "__drop__") {
        sectionHeaderCount++;
        structuredLines.push(`[${hdr.label}]${hdr.note ? ` ${hdr.note}` : ""}`);
        if (hdr.inlineChords) structuredLines.push(hdr.inlineChords);
      }
      continue;
    }

    const chords = chordsOf(cur.glyphs, isValid);
    if (chords) {
      const below = lines[i + 1];
      if (below) {
        const belowText = below.glyphs.map((g) => g.ch).join("").trim();
        const belowIsHeader = parseSectionHeader(belowText, isValid);
        const belowIsChords = chordsOf(below.glyphs, isValid);
        if (below.y - cur.y <= cur.size * 2.4 && /[a-z]/i.test(belowText) && !belowIsChords && !belowIsHeader && !isClutterLine(belowText)) {
          const placed = placeChords(chords, below.glyphs);
          layoutLines.push(placed);
          structuredLines.push(placed);
          i++;
          continue;
        }
      }
      // Standalone chord-only instrumental line (e.g. Intro: G D G D)
      const chordOnly = chords.map((c) => `[${c.chord}]`).join("   ");
      structuredLines.push(chordOnly);
      continue;
    }

    if (isGuitarTabLine(rawText)) {
      structuredLines.push(rawText);
      continue;
    }

    if (/[a-z]/i.test(rawText) && !isClutterLine(rawText)) {
      structuredLines.push(rawText);
    }
  }

  return { layoutLines, structuredLines, sectionHeaderCount };
}

export function pairChordsWithLyrics(items: TextItem[], isValid: (c: string) => boolean = isValidChordToken): string[] {
  return extractColumnLines(items, isValid).layoutLines;
}

export type PdfExtractResult = {
  layoutLines: string[];
  structuredLines: string[];
  sectionHeaderCount: number;
  numPages: number;
  titleHint: string;
  looksMultiSong: boolean;
};

/** Extracts both exact chord+lyric layout lines and full structured lines from a PDF's text layer. */
export async function pdfExtract(bytes: Uint8Array, maxPages = 12): Promise<PdfExtractResult> {
  const pdf = await getDocumentProxy(bytes);
  const layoutLines: string[] = [];
  const structuredLines: string[] = [];
  let sectionHeaderCount = 0;
  let titleHint = "";
  let pagesWithBigTitles = 0;

  const pageCount = Math.min(pdf.numPages, maxPages);
  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // deno-lint-ignore no-explicit-any
    const styles = (content as any).styles || {};
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
    if (!items.length) continue;

    // Detect title-sized heading at top of page (helps identify single-song vs multi-song set list PDFs)
    const sizes = items.map((it) => it.size).sort((a, b) => a - b);
    const medianSize = sizes[Math.floor(sizes.length / 2)] || 11;
    const minY = Math.min(...items.map((it) => it.y));
    const bigTopItems = items
      .filter((it) => it.size >= medianSize * 1.35 && it.y <= minY + 90 && /[A-Za-z]{3}/.test(it.str))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    if (bigTopItems.length) {
      pagesWithBigTitles++;
      if (p === 1 && !titleHint) {
        const firstY = bigTopItems[0].y;
        titleHint = bigTopItems
          .filter((it) => Math.abs(it.y - firstY) < bigTopItems[0].size * 0.6)
          .map((it) => it.str.trim())
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }

    for (const column of splitColumns(items)) {
      const colRes = extractColumnLines(column, isValidChordToken);
      layoutLines.push(...colRes.layoutLines);
      structuredLines.push(...colRes.structuredLines);
      sectionHeaderCount += colRes.sectionHeaderCount;
    }
  }

  return {
    layoutLines,
    structuredLines,
    sectionHeaderCount,
    numPages: pdf.numPages,
    titleHint,
    looksMultiSong: pagesWithBigTitles >= 2 || pdf.numPages > 2
  };
}

/** Lyric lines with chords placed from the PDF's text layer. Empty if the PDF has no text layer. */
export async function pdfLayoutLines(bytes: Uint8Array, maxPages = 12): Promise<string[]> {
  return (await pdfExtract(bytes, maxPages)).layoutLines;
}

/** Track A direct builder for clean single-song digital PDFs with section headers. */
export function parsePdfDirect(ext: PdfExtractResult, fileName?: string) {
  if (ext.looksMultiSong || ext.sectionHeaderCount < 2 || ext.layoutLines.length < 4) {
    return { sheet: null, layoutLines: ext.layoutLines, confidence: "low" as const, reason: "multi-song or unstructured PDF" };
  }
  const fallbackTitle = (fileName || "").replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  // Drop the repeated title line from structuredLines if it's the very first item
  const lines = [...ext.structuredLines];
  if (ext.titleHint && lines.length && lines[0].toLowerCase() === ext.titleHint.toLowerCase()) {
    lines.shift();
  }
  return parseStructuredSheet({
    rawText: lines.join("\n"),
    title: ext.titleHint || fallbackTitle,
    isValid: isValidChordToken
  });
}
