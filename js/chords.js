// Pure chord music theory & guitar chord library (no DOM, no network).
// Imported by browser ES modules and tested standalone.

export const CHROMATIC_SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const CHROMATIC_FLATS  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export const NOTE_TO_PITCH = {
  "C": 0,  "B#": 0,
  "C#": 1, "Db": 1,
  "D": 2,
  "D#": 3, "Eb": 3,
  "E": 4,  "Fb": 4,
  "F": 5,  "E#": 5,
  "F#": 6, "Gb": 6,
  "G": 7,
  "G#": 8, "Ab": 8,
  "A": 9,
  "A#": 10, "Bb": 10,
  "B": 11, "Cb": 11
};

// Keys that prefer flat spelling (SPEC 5.3)
export const FLAT_KEYS = new Set([
  "F", "Bb", "Eb", "Ab", "Db", "Gb",
  "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm"
]);

export const ALL_MAJOR_KEYS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const ALL_MINOR_KEYS = ["Am", "Bbm", "Bm", "Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m"];

// Open chord shapes comfortable for acoustic/electric guitar without full barres
export const EASY_OPEN_CHORDS = new Set([
  "C", "Cadd9", "Cmaj7", "C7",
  "G", "G6", "G7", "Gsus4", "G/B", "G/F#",
  "D", "Dsus2", "Dsus4", "D7", "Dmaj7", "Dm", "Dm7", "D/F#", "D/E", "D/C",
  "A", "Asus2", "Asus4", "A7", "Amaj7", "Am", "Am7",
  "E", "Esus4", "E7", "Em", "Em7",
  "Fmaj7"
]);

// Valid chord quality suffixes (order from longest/specific to shortest)
const QUALITY_RE = /^(?:maj13|maj11|maj9|maj7|M7|Δ7|Δ|min11|min9|min7b5|min7|min6|min|m13|m11|m9|m7b5|m7|m6|mmaj7|m|-(?:7|9|11)?|dim7|dim|°7|°|ø7|ø|aug7|aug|\+7|\+|sus2sus4|sus4|sus2|sus|add11|add9|add4|add2|7sus4|7sus2|9sus4|13|11|9|7|6\/9|69|6|5)?(?:(?:\(?[b#](?:5|9|11|13)\)?)*)$/;

const ROOT_RE = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/;

/**
 * Parse a chord token into { root, quality, bass } or null if invalid.
 * Does NOT alter quality text.
 */
export function parseChord(token) {
  if (!token || typeof token !== "string") return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (trimmed === "N.C." || trimmed === "NC") {
    return { root: "N.C.", quality: "", bass: null, isNC: true };
  }
  const m = trimmed.match(ROOT_RE);
  if (!m) return null;
  const [, root, quality, bass] = m;
  if (!(root in NOTE_TO_PITCH)) return null;
  if (bass && !(bass in NOTE_TO_PITCH)) return null;
  if (!QUALITY_RE.test(quality)) return null;
  return {
    root,
    quality: quality || "",
    bass: bass || null
  };
}

/**
 * Returns true if token is a valid chord (or N.C.).
 * Rejects common English words that happen to look like chords unless valid.
 */
export function isChord(token, { allowBareA = true } = {}) {
  if (!token || typeof token !== "string") return false;
  const trimmed = token.trim();
  if (trimmed === "N.C." || trimmed === "NC") return true;
  const clean = trimmed.replace(/^[([{|]+|[)\]}|,.;:!]+$/g, "");
  if (!clean) return false;
  if (!allowBareA && clean === "A") return false;
  return parseChord(clean) !== null;
}

/**
 * Decide whether to use flats for a given target key and optional override.
 * preference: "auto" | "sharps" | "flats"
 */
export function shouldUseFlats(targetKey = "C", preference = "auto") {
  if (preference === "flats") return true;
  if (preference === "sharps") return false;
  if (!targetKey) return false;
  const normalized = normalizeKeyName(targetKey);
  if (FLAT_KEYS.has(normalized)) return true;
  if (normalized.includes("b")) return true;
  return false;
}

/**
 * Convert pitch class 0-11 to note name.
 */
export function pitchToNote(pitch, useFlats = false) {
  const idx = ((pitch % 12) + 12) % 12;
  return useFlats ? CHROMATIC_FLATS[idx] : CHROMATIC_SHARPS[idx];
}

/**
 * Normalize a key string like "g", "G major", "E minor", "Bb" -> "G", "Em", "Bb"
 */
export function normalizeKeyName(keyStr) {
  if (!keyStr || typeof keyStr !== "string") return "C";
  const s = keyStr.trim();
  const m = s.match(/^([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?$/i);
  if (!m) return "C";
  const root = m[1].toUpperCase() + (m[2] || "");
  const qual = (m[3] || "").toLowerCase();
  const isMinor = qual === "m" || qual === "min" || qual === "minor";
  return root + (isMinor ? "m" : "");
}

/**
 * Transpose a single note name by semitones.
 */
export function transposeNote(note, semitones, useFlats = false) {
  if (!(note in NOTE_TO_PITCH)) return note;
  const p = (NOTE_TO_PITCH[note] + semitones % 12 + 12) % 12;
  return pitchToNote(p, useFlats);
}

/**
 * Transpose a key name (e.g. "G" or "Em") by semitones.
 */
export function transposeKey(keyStr, semitones, preference = "auto") {
  if (!keyStr) return "C";
  const norm = normalizeKeyName(keyStr);
  const isMinor = norm.endsWith("m");
  const root = isMinor ? norm.slice(0, -1) : norm;
  if (!(root in NOTE_TO_PITCH)) return norm;
  const newPitch = (NOTE_TO_PITCH[root] + (semitones % 12) + 12) % 12;
  // Determine default spelling for this key pitch
  let defaultKey;
  if (isMinor) {
    defaultKey = ALL_MINOR_KEYS[newPitch];
  } else {
    defaultKey = ALL_MAJOR_KEYS[newPitch];
  }
  if (preference === "auto") return defaultKey;
  const useFlats = preference === "flats";
  return pitchToNote(newPitch, useFlats) + (isMinor ? "m" : "");
}

/**
 * Transpose a chord string by semitones, keeping quality untouched.
 */
export function transposeChord(chordStr, semitones, targetKey = null, preference = "auto") {
  const parsed = parseChord(chordStr);
  if (!parsed || parsed.isNC) return chordStr;
  const steps = ((semitones % 12) + 12) % 12;
  let useFlats;
  if (preference === "flats") {
    useFlats = true;
  } else if (preference === "sharps") {
    useFlats = false;
  } else if (targetKey) {
    useFlats = shouldUseFlats(targetKey, "auto");
  } else {
    useFlats = parsed.root.includes("b") || (parsed.bass && parsed.bass.includes("b"));
  }
  const newRoot = transposeNote(parsed.root, steps, useFlats);
  const newBass = parsed.bass ? transposeNote(parsed.bass, steps, useFlats) : null;
  return newRoot + parsed.quality + (newBass ? "/" + newBass : "");
}

/**
 * Given a sounding key and a capo fret (0..12), return the shapes key played.
 * Shapes key = sounding key - capo
 */
export function capoShapesKey(soundingKey, capoFret, preference = "auto") {
  return transposeKey(soundingKey, -(capoFret || 0), preference);
}

/**
 * Given a written shapes key and a capo fret, return the actual concert sounding key.
 * Sounding key = shapes key + capo
 */
export function soundingKeyFromShapes(shapesKey, capoFret, preference = "auto") {
  return transposeKey(shapesKey, +(capoFret || 0), preference);
}

/**
 * Convert a chord into Nashville Number notation relative to keyStr.
 * e.g. in key of G: G -> "1", C -> "4", D/F# -> "5/7", Em7 -> "6m7", Am -> "2m"
 */
export function toNashville(chordStr, keyStr = "C") {
  const parsed = parseChord(chordStr);
  if (!parsed || parsed.isNC) return chordStr;
  const normKey = normalizeKeyName(keyStr || "C");
  const isMinorKey = normKey.endsWith("m");
  const keyRoot = isMinorKey ? normKey.slice(0, -1) : normKey;
  const keyPitch = NOTE_TO_PITCH[keyRoot] ?? 0;
  // Use relative major scale degrees for standard Nashville or tonic-based
  const majorKeyPitch = isMinorKey ? (keyPitch + 3) % 12 : keyPitch;

  const SCALE_INTERVALS = {
    0: "1", 1: "b2", 2: "2", 3: "b3", 4: "3", 5: "4",
    6: "b5", 7: "5", 8: "b6", 9: "6", 10: "b7", 11: "7"
  };

  const rootInterval = ((NOTE_TO_PITCH[parsed.root] - majorKeyPitch) % 12 + 12) % 12;
  const rootDeg = SCALE_INTERVALS[rootInterval];
  let bassPart = "";
  if (parsed.bass) {
    const bassInterval = ((NOTE_TO_PITCH[parsed.bass] - majorKeyPitch) % 12 + 12) % 12;
    bassPart = "/" + SCALE_INTERVALS[bassInterval];
  }
  return rootDeg + parsed.quality + bassPart;
}

/**
 * Score how easy/open a list of chords is (0 to 100) and suggest best capo frets (0..7)
 * to play the given sounding chords with open guitar shapes.
 */
export function suggestCapoPositions(chords, soundingKey = "C") {
  const unique = Array.from(new Set((chords || []).filter((c) => parseChord(c) && !parseChord(c).isNC)));
  const OPEN_SHAPE_KEYS = new Set(["G", "C", "D", "A", "E", "Em", "Am", "Dm"]);

  const results = [];
  for (let capo = 0; capo <= 9; capo++) {
    const shapesKey = transposeKey(soundingKey, -capo);
    const transposed = unique.map((c) => transposeChord(c, -capo, shapesKey));
    let openCount = 0;
    for (const tc of transposed) {
      const p = parseChord(tc);
      const base = p ? p.root + (p.quality.startsWith("m") && !p.quality.startsWith("maj") ? "m" : "") : tc;
      if (EASY_OPEN_CHORDS.has(tc) || EASY_OPEN_CHORDS.has(base)) {
        openCount++;
      }
    }
    const openRatio = unique.length ? openCount / unique.length : 1;
    const keyBonus = OPEN_SHAPE_KEYS.has(shapesKey) ? 0.25 : 0;
    const score = Math.round(Math.min(1, openRatio * 0.8 + keyBonus) * 100);
    results.push({
      capo,
      shapesKey,
      soundingKey: normalizeKeyName(soundingKey),
      openCount,
      totalChords: unique.length,
      score,
      sampleChords: transposed.slice(0, 5)
    });
  }
  results.sort((a, b) => b.score - a.score || a.capo - b.capo);
  return results;
}

/**
 * Infer a song's written key from its chords if no explicit {key:} is present.
 */
export function inferKeyFromChords(chords) {
  const valid = (chords || []).map(parseChord).filter((c) => c && !c.isNC);
  if (!valid.length) return "G";
  const isMin = (c) => c.quality.startsWith("m") && !c.quality.startsWith("maj");

  // Score all 12 major and 12 minor keys by diatonic chord fit
  // Major scale diatonic triads: I (0), ii (2m), iii (4m), IV (5), V (7), vi (9m)
  let bestKey = "G";
  let bestScore = -1;

  for (let pitch = 0; pitch < 12; pitch++) {
    const majName = ALL_MAJOR_KEYS[pitch];
    const minPitch = (pitch + 9) % 12;
    const minRoot = shouldUseFlats(majName, "auto") ? CHROMATIC_FLATS[minPitch] : CHROMATIC_SHARPS[minPitch];
    const minName = minRoot + "m";

    let majScore = 0;
    let minScore = 0;

    for (let i = 0; i < valid.length; i++) {
      const c = valid[i];
      const cp = NOTE_TO_PITCH[c.root];
      const cm = isMin(c);
      const rel = ((cp - pitch) % 12 + 12) % 12;

      // Diatonic fit
      if (!cm && (rel === 0 || rel === 5 || rel === 7)) {
        majScore += (rel === 0 ? 3.5 : 2.5);
        minScore += (rel === 0 ? 2.0 : 1.8);
      } else if (cm && (rel === 9 || rel === 2 || rel === 4)) {
        majScore += 2.0;
        minScore += (rel === 9 ? 3.5 : 2.0);
      }
      // Bonus for first and last chords matching tonic or IV/V
      if (i === 0 || i === valid.length - 1) {
        if (!cm && rel === 0) majScore += 3.0;
        if (cm && rel === 9) minScore += 3.0;
      }
    }

    if (majScore > bestScore) {
      bestScore = majScore;
      bestKey = majName;
    }
    if (minScore > bestScore) {
      bestScore = minScore;
      bestKey = minName;
    }
  }

  return normalizeKeyName(bestKey);
}

/**
 * Normalize a key to its Major / Relative Minor tonal center pair for vocal analytics.
 * e.g. "G" or "Em" -> { major: "G", minor: "Em", pitch: 7, label: "G / Em" }
 */
export function getKeyCenter(keyStr) {
  const norm = normalizeKeyName(keyStr || "C");
  const isMinor = norm.endsWith("m");
  const root = isMinor ? norm.slice(0, -1) : norm;
  const pitch = NOTE_TO_PITCH[root] ?? 0;
  const majorPitch = isMinor ? (pitch + 3) % 12 : pitch;
  const minorPitch = (majorPitch + 9) % 12;
  const major = ALL_MAJOR_KEYS[majorPitch];
  const minorRoot = shouldUseFlats(major, "auto") ? CHROMATIC_FLATS[minorPitch] : CHROMATIC_SHARPS[minorPitch];
  const minor = minorRoot + "m";
  return {
    major,
    minor,
    pitch: majorPitch,
    label: `${major} / ${minor}`
  };
}

// ============================================================================
// Built-in Guitar Chord Diagram Library (Standard Tuning E A D G B E)
// ============================================================================
// Format: { frets: [E, A, D, G, B, e] (-1 = mute 'x', 0 = open, 1..15 = fret),
//           baseFret: 1, fingers?: [0..4], barres?: [{ fret, fromString, toString }] }

export const BUILTIN_VOICINGS = {
  // C family
  "C":      { frets: [-1, 3, 2, 0, 1, 0], baseFret: 1 },
  "Cadd9":  { frets: [-1, 3, 2, 0, 3, 3], baseFret: 1 },
  "Cmaj7":  { frets: [-1, 3, 2, 0, 0, 0], baseFret: 1 },
  "C7":     { frets: [-1, 3, 2, 3, 1, 0], baseFret: 1 },
  "Csus4":  { frets: [-1, 3, 3, 0, 1, 1], baseFret: 1 },
  "Csus2":  { frets: [-1, 3, 0, 0, 1, 3], baseFret: 1 },
  "C6":     { frets: [-1, 3, 2, 2, 1, 0], baseFret: 1 },
  "Cm":     { frets: [-1, 1, 3, 3, 2, 1], baseFret: 3, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Cm7":    { frets: [-1, 1, 3, 1, 2, 1], baseFret: 3, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Cdim":   { frets: [-1, 3, 4, 2, 4, -1], baseFret: 1 },
  "Caug":   { frets: [-1, 3, 2, 1, 1, 0], baseFret: 1 },
  "C/G":    { frets: [3, 3, 2, 0, 1, 0], baseFret: 1 },
  "C/E":    { frets: [0, 3, 2, 0, 1, 0], baseFret: 1 },
  "C/B":    { frets: [-1, 2, 2, 0, 1, 0], baseFret: 1 },

  // D family
  "D":      { frets: [-1, -1, 0, 2, 3, 2], baseFret: 1 },
  "Dsus4":  { frets: [-1, -1, 0, 2, 3, 3], baseFret: 1 },
  "Dsus2":  { frets: [-1, -1, 0, 2, 3, 0], baseFret: 1 },
  "Dadd9":  { frets: [-1, -1, 0, 2, 3, 0], baseFret: 1 },
  "Dmaj7":  { frets: [-1, -1, 0, 2, 2, 2], baseFret: 1 },
  "D7":     { frets: [-1, -1, 0, 2, 1, 2], baseFret: 1 },
  "D6":     { frets: [-1, -1, 0, 2, 0, 2], baseFret: 1 },
  "Dm":     { frets: [-1, -1, 0, 2, 3, 1], baseFret: 1 },
  "Dm7":    { frets: [-1, -1, 0, 2, 1, 1], baseFret: 1 },
  "Ddim":   { frets: [-1, -1, 0, 1, 3, 1], baseFret: 1 },
  "Daug":   { frets: [-1, -1, 0, 3, 3, 2], baseFret: 1 },
  "D/F#":   { frets: [2, 0, 0, 2, 3, 2], baseFret: 1 },
  "D/E":    { frets: [0, 0, 0, 2, 3, 2], baseFret: 1 },
  "D/C":    { frets: [-1, 3, 0, 2, 3, 2], baseFret: 1 },
  "D/A":    { frets: [-1, 0, 0, 2, 3, 2], baseFret: 1 },

  // E family
  "E":      { frets: [0, 2, 2, 1, 0, 0], baseFret: 1 },
  "Esus4":  { frets: [0, 2, 2, 2, 0, 0], baseFret: 1 },
  "Esus2":  { frets: [0, 2, 4, 4, 0, 0], baseFret: 1 },
  "Eadd9":  { frets: [0, 2, 4, 1, 0, 0], baseFret: 1 },
  "Emaj7":  { frets: [0, 2, 1, 1, 0, 0], baseFret: 1 },
  "E7":     { frets: [0, 2, 0, 1, 0, 0], baseFret: 1 },
  "Em":     { frets: [0, 2, 2, 0, 0, 0], baseFret: 1 },
  "Em7":    { frets: [0, 2, 2, 0, 3, 0], baseFret: 1 },
  "Em9":    { frets: [0, 2, 0, 0, 0, 2], baseFret: 1 },
  "Edim":   { frets: [0, 1, 2, 0, 2, 0], baseFret: 1 },
  "Eaug":   { frets: [0, 3, 2, 1, 1, 0], baseFret: 1 },
  "E/G#":   { frets: [4, 2, 2, 1, 0, 0], baseFret: 1 },
  "E/B":    { frets: [-1, 2, 2, 1, 0, 0], baseFret: 1 },

  // F family
  "F":      { frets: [1, 3, 3, 2, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fmaj7":  { frets: [-1, -1, 3, 2, 1, 0], baseFret: 1 },
  "F7":     { frets: [1, 3, 1, 2, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fsus4":  { frets: [1, 3, 3, 3, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fsus2":  { frets: [-1, -1, 3, 0, 1, 1], baseFret: 1 },
  "Fadd9":  { frets: [-1, -1, 3, 2, 1, 3], baseFret: 1 },
  "Fm":     { frets: [1, 3, 3, 1, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fm7":    { frets: [1, 3, 1, 1, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fdim":   { frets: [-1, -1, 3, 1, 0, 1], baseFret: 1 },
  "Faug":   { frets: [-1, -1, 3, 2, 2, 1], baseFret: 1 },

  // G family
  "G":      { frets: [3, 2, 0, 0, 3, 3], baseFret: 1 },
  "Gsus4":  { frets: [3, 3, 0, 0, 1, 3], baseFret: 1 },
  "Gsus2":  { frets: [3, 0, 0, 0, 3, 3], baseFret: 1 },
  "Gadd9":  { frets: [3, 0, 0, 2, 0, 3], baseFret: 1 },
  "Gmaj7":  { frets: [3, 2, 0, 0, 0, 2], baseFret: 1 },
  "G7":     { frets: [3, 2, 0, 0, 0, 1], baseFret: 1 },
  "G6":     { frets: [3, 2, 0, 0, 0, 0], baseFret: 1 },
  "Gm":     { frets: [1, 3, 3, 1, 1, 1], baseFret: 3, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Gm7":    { frets: [1, 3, 1, 1, 1, 1], baseFret: 3, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Gdim":   { frets: [-1, -1, 2, 3, 2, 3], baseFret: 1 },
  "Gaug":   { frets: [3, 2, 1, 0, 0, 3], baseFret: 1 },
  "G/B":    { frets: [-1, 2, 0, 0, 3, 3], baseFret: 1 },
  "G/D":    { frets: [-1, -1, 0, 0, 3, 3], baseFret: 1 },
  "G/F#":   { frets: [2, 2, 0, 0, 3, 3], baseFret: 1 },

  // A family
  "A":      { frets: [-1, 0, 2, 2, 2, 0], baseFret: 1 },
  "Asus4":  { frets: [-1, 0, 2, 2, 3, 0], baseFret: 1 },
  "Asus2":  { frets: [-1, 0, 2, 2, 0, 0], baseFret: 1 },
  "Aadd9":  { frets: [-1, 0, 2, 4, 2, 0], baseFret: 1 },
  "Amaj7":  { frets: [-1, 0, 2, 1, 2, 0], baseFret: 1 },
  "A7":     { frets: [-1, 0, 2, 0, 2, 0], baseFret: 1 },
  "Am":     { frets: [-1, 0, 2, 2, 1, 0], baseFret: 1 },
  "Am7":    { frets: [-1, 0, 2, 0, 1, 0], baseFret: 1 },
  "Am9":    { frets: [-1, 0, 2, 4, 1, 3], baseFret: 1 },
  "Adim":   { frets: [-1, 0, 1, 2, 1, -1], baseFret: 1 },
  "Aaug":   { frets: [-1, 0, 3, 2, 2, 1], baseFret: 1 },
  "A/C#":   { frets: [-1, 4, 2, 2, 2, 0], baseFret: 1 },
  "A/E":    { frets: [0, 0, 2, 2, 2, 0], baseFret: 1 },
  "A/G":    { frets: [3, 0, 2, 2, 2, 0], baseFret: 1 },

  // B family
  "B":      { frets: [-1, 1, 3, 3, 3, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bsus4":  { frets: [-1, 1, 3, 3, 4, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bsus2":  { frets: [-1, 1, 3, 3, 1, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bmaj7":  { frets: [-1, 1, 3, 2, 3, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "B7":     { frets: [-1, 2, 1, 2, 0, 2], baseFret: 1 },
  "Bm":     { frets: [-1, 1, 3, 3, 2, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bm7":    { frets: [-1, 2, 0, 2, 0, 2], baseFret: 1 },
  "Bdim":   { frets: [-1, 2, 3, 4, 3, -1], baseFret: 1 },
  "Baug":   { frets: [-1, 2, 1, 0, 0, 3], baseFret: 1 }
};

/**
 * Look up or dynamically generate a movable barre guitar voicing for any parsed chord.
 * Returns { frets: [E,A,D,G,B,e], baseFret, barres } or null if unknown quality.
 */
export function getChordVoicing(chordStr, customDefines = {}) {
  if (!chordStr) return null;
  if (customDefines && customDefines[chordStr]) return customDefines[chordStr];
  if (BUILTIN_VOICINGS[chordStr]) return BUILTIN_VOICINGS[chordStr];

  const parsed = parseChord(chordStr);
  if (!parsed || parsed.isNC) return null;

  // Normalize enharmonic root to see if exact voicing exists
  const pitch = NOTE_TO_PITCH[parsed.root];
  const sharpRoot = CHROMATIC_SHARPS[pitch];
  const flatRoot = CHROMATIC_FLATS[pitch];

  const normQual = normalizeVoicingQuality(parsed.quality);
  for (const r of [parsed.root, sharpRoot, flatRoot]) {
    const candidate = r + normQual + (parsed.bass ? "/" + parsed.bass : "");
    if (BUILTIN_VOICINGS[candidate]) return BUILTIN_VOICINGS[candidate];
  }
  // If slash chord has no custom slash voicing, fall back to root+quality voicing
  for (const r of [parsed.root, sharpRoot, flatRoot]) {
    const baseCandidate = r + normQual;
    if (BUILTIN_VOICINGS[baseCandidate]) return BUILTIN_VOICINGS[baseCandidate];
  }

  // Generate movable E-shape or A-shape barre chord for any root
  return generateMovableVoicing(pitch, normQual);
}

function normalizeVoicingQuality(q) {
  if (!q) return "";
  if (q === "min" || q === "-") return "m";
  if (q === "M7" || q === "Δ" || q === "Δ7") return "maj7";
  if (q === "min7" || q === "-7") return "m7";
  if (q === "°" || q === "dim7") return "dim";
  if (q === "+") return "aug";
  if (q === "sus") return "sus4";
  return q;
}

function generateMovableVoicing(pitch, quality) {
  // E-string root fret (E = pitch 4)
  const eFret = ((pitch - 4) % 12 + 12) % 12 || 12;
  // A-string root fret (A = pitch 9)
  const aFret = ((pitch - 9) % 12 + 12) % 12 || 12;

  // Prefer A-shape for frets 1..6, E-shape for frets 1..8
  const useAShape = aFret <= 6 && aFret < eFret;

  if (useAShape) {
    const shapesA = {
      "":     { frets: [-1, 1, 3, 3, 3, 1], barres: [{ fret: 1, from: 1, to: 5 }] },
      "m":    { frets: [-1, 1, 3, 3, 2, 1], barres: [{ fret: 1, from: 1, to: 5 }] },
      "7":    { frets: [-1, 1, 3, 1, 3, 1], barres: [{ fret: 1, from: 1, to: 5 }] },
      "maj7": { frets: [-1, 1, 3, 2, 3, 1], barres: [{ fret: 1, from: 1, to: 5 }] },
      "m7":   { frets: [-1, 1, 3, 1, 2, 1], barres: [{ fret: 1, from: 1, to: 5 }] },
      "sus2": { frets: [-1, 1, 3, 3, 1, 1], barres: [{ fret: 1, from: 1, to: 5 }] },
      "sus4": { frets: [-1, 1, 3, 3, 4, 1], barres: [{ fret: 1, from: 1, to: 5 }] },
      "add9": { frets: [-1, 1, 3, 5, 3, 1], barres: [{ fret: 1, from: 1, to: 5 }] },
      "dim":  { frets: [-1, 1, 2, 3, 2, -1], barres: [] },
      "aug":  { frets: [-1, 1, 4, 3, 3, -1], barres: [] }
    };
    if (shapesA[quality]) {
      return { ...shapesA[quality], baseFret: aFret };
    }
  }

  const shapesE = {
    "":     { frets: [1, 3, 3, 2, 1, 1], barres: [{ fret: 1, from: 0, to: 5 }] },
    "m":    { frets: [1, 3, 3, 1, 1, 1], barres: [{ fret: 1, from: 0, to: 5 }] },
    "7":    { frets: [1, 3, 1, 2, 1, 1], barres: [{ fret: 1, from: 0, to: 5 }] },
    "maj7": { frets: [1, -1, 2, 2, 1, -1], barres: [] },
    "m7":   { frets: [1, 3, 1, 1, 1, 1], barres: [{ fret: 1, from: 0, to: 5 }] },
    "sus2": { frets: [1, 3, 5, 5, 1, 1], barres: [{ fret: 1, from: 0, to: 5 }] },
    "sus4": { frets: [1, 3, 3, 3, 1, 1], barres: [{ fret: 1, from: 0, to: 5 }] },
    "add9": { frets: [1, 3, 5, 2, 1, 1], barres: [{ fret: 1, from: 0, to: 5 }] },
    "dim":  { frets: [1, -1, 1, 2, 1, -1], barres: [] },
    "aug":  { frets: [1, -1, 3, 2, 2, -1], barres: [] }
  };
  if (shapesE[quality]) {
    return { ...shapesE[quality], baseFret: eFret };
  }
  return null;
}

/**
 * Parse a ChordPro {define: Name base-fret N frets x 3 2 0 1 0} directive string.
 */
export function parseDefineDirective(val) {
  if (!val || typeof val !== "string") return null;
  const parts = val.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const name = parts[0];
  let baseFret = 1;
  const bfIdx = parts.findIndex((p) => p.toLowerCase() === "base-fret");
  if (bfIdx !== -1 && parts[bfIdx + 1]) {
    baseFret = parseInt(parts[bfIdx + 1], 10) || 1;
  }
  const fIdx = parts.findIndex((p) => p.toLowerCase() === "frets");
  if (fIdx === -1) return null;
  const fretTokens = parts.slice(fIdx + 1, fIdx + 7);
  if (fretTokens.length !== 6) return null;
  const frets = fretTokens.map((t) => (t.toLowerCase() === "x" || t === "-1" ? -1 : parseInt(t, 10) || 0));
  return { name, voicing: { frets, baseFret, barres: [] } };
}
