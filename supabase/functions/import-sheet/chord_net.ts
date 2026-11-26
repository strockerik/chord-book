// Chord grammar and output validation ("Chord Net") for import-sheet.

// ==== CHORD NET ====
export const NOTE_NAMES = new Set([
  "C", "B#", "C#", "Db", "D", "D#", "Eb", "E", "Fb", "F", "E#",
  "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B", "Cb"
]);
export const QUALITY_RE = /^(?:maj13|maj11|maj9|maj7|M7|Δ7|Δ|min11|min9|min7b5|min7|min6|min|m13|m11|m9|m7b5|m7|m6|mmaj7|m|-(?:7|9|11)?|dim7|dim|°7|°|ø7|ø|aug7|aug|\+7|\+|sus2sus4|sus4|sus2|sus|add11|add9|add4|add2|7sus4|7sus2|9sus4|13|11|9|7|6\/9|69|6|5|4|2)?(?:(?:\(?[b#](?:5|9|11|13)\)?)*)$/;
export const ROOT_RE = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/;

export function isValidChordToken(token: string): boolean {
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

export function validateSheetOutput(sheet: {
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
