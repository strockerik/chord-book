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
// Indexed by pitch (C = 0), like ALL_MAJOR_KEYS.
export const ALL_MINOR_KEYS = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];

// Open chord shapes comfortable for acoustic/electric guitar without full barres
export const EASY_OPEN_CHORDS = new Set([
  "C", "C2", "Cadd9", "Cmaj7", "C7",
  "G", "G2", "G6", "G7", "Gsus4", "G/B", "G/F#",
  "D", "D2", "Dsus2", "Dsus4", "D7", "Dmaj7", "Dm", "Dm7", "D/F#", "D/E", "D/C",
  "A", "A2", "Asus2", "Asus4", "A7", "Amaj7", "Am", "Am7",
  "E", "E2", "Esus4", "E7", "Em", "Em7",
  "Fmaj7"
]);

// Valid chord quality suffixes (order from longest/specific to shortest)
const QUALITY_RE = /^(?:maj13|maj11|maj9|maj7|M7|Δ7|Δ|min11|min9|min7b5|min7|min6|min|m13|m11|m9|m7b5|m7|m6|mmaj7|m|-(?:7|9|11)?|dim7|dim|°7|°|ø7|ø|aug7|aug|\+7|\+|sus2sus4|sus4|sus2|sus|add11|add9|add4|add2|7sus4|7sus2|9sus4|13|11|9|7|6\/9|69|6|5|4|2)?(?:(?:\(?[b#](?:5|9|11|13)\)?)*)$/;

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

// Guitar tunings. `offset` is how far the whole guitar sounds from standard pitch.
export const TUNINGS = [
  { id: "standard", label: "Standard", value: "E A D G B E", offset: 0 },
  { id: "half", label: "Half step down", value: "Eb Ab Db Gb Bb Eb", offset: -1 },
  { id: "drop_d", label: "Drop D", value: "D A D G B E", offset: 0 },
  { id: "other", label: "Other", value: "Other", offset: 0 }
];

export function getTuning(value) {
  const text = String(value || "").trim();
  const compact = text.toLowerCase().replace(/\s+/g, "");
  let tuning = TUNINGS[3];
  if (!compact || compact === "standard" || compact === "eadgbe") tuning = TUNINGS[0];
  else if (compact === "ebabdbgbbbeb" || compact === "d#g#c#f#a#d#" || compact === "halfstepdown") tuning = TUNINGS[1];
  else if (compact === "dadgbe" || compact === "dropd") tuning = TUNINGS[2];
  // A specific custom tuning keeps its own name on the sheet.
  const display = tuning.id === "other" && text && compact !== "other" ? text : tuning.label;
  return { ...tuning, display };
}

export function soundingKeyWithTuning(shapesKey, capoFret, tuningValue, preference = "auto") {
  return transposeKey(shapesKey, Number(capoFret || 0) + getTuning(tuningValue).offset, preference);
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
  "C":       { frets: [-1, 3, 2, 0, 1, 0], baseFret: 1 },
  "C2":      { frets: [-1, 3, 0, 0, 1, 0], baseFret: 1 },
  "Cadd9":   { frets: [-1, 3, 2, 0, 3, 3], baseFret: 1 },
  "Cadd11":  { frets: [-1, 3, 3, 0, 1, 0], baseFret: 1 },
  "Cmaj7":   { frets: [-1, 3, 2, 0, 0, 0], baseFret: 1 },
  "Cmaj9":   { frets: [-1, 3, 0, 0, 0, 0], baseFret: 1 },
  "C7":      { frets: [-1, 3, 2, 3, 1, 0], baseFret: 1 },
  "C9":      { frets: [-1, 3, 2, 3, 3, 3], baseFret: 1 },
  "C7sus4":  { frets: [-1, 3, 3, 3, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 4, to: 5 }] },
  "Csus4":   { frets: [-1, 3, 3, 0, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 4, to: 5 }] },
  "Csus2":   { frets: [-1, 3, 0, 0, 1, 3], baseFret: 1 },
  "C6":      { frets: [-1, 3, 2, 2, 1, 0], baseFret: 1 },
  "C6/9":    { frets: [-1, 3, 2, 2, 3, 3], baseFret: 1 },
  "C5":      { frets: [-1, 3, 5, 5, -1, -1], baseFret: 1 },
  "Cm":      { frets: [-1, 1, 3, 3, 2, 1], baseFret: 3, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Cm7":     { frets: [-1, 1, 3, 1, 2, 1], baseFret: 3, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Cm9":     { frets: [-1, 3, 1, 3, 3, -1], baseFret: 1 },
  "Cm6":     { frets: [-1, 1, 3, 3, 2, 3], baseFret: 3 },
  "Cm7b5":   { frets: [-1, 3, 4, 3, 4, -1], baseFret: 1 },
  "Cdim":    { frets: [-1, 3, 4, 2, 4, -1], baseFret: 1 },
  "Cdim7":   { frets: [-1, 3, 4, 2, 4, -1], baseFret: 1 },
  "Caug":    { frets: [-1, 3, 2, 1, 1, 0], baseFret: 1 },
  "C/G":     { frets: [3, 3, 2, 0, 1, 0], baseFret: 1 },
  "C/E":     { frets: [0, 3, 2, 0, 1, 0], baseFret: 1 },
  "C/B":     { frets: [-1, 2, 2, 0, 1, 0], baseFret: 1 },
  "C/D":     { frets: [-1, -1, 0, 0, 1, 0], baseFret: 1 },
  "Cadd9/B": { frets: [-1, 2, 0, 0, 3, 3], baseFret: 1 },
  "Cmaj7/G": { frets: [3, 3, 2, 0, 0, 0], baseFret: 1 },
  "Cmaj7/E": { frets: [0, 3, 2, 0, 0, 0], baseFret: 1 },

  // C# / Db family
  "C#":      { frets: [-1, 1, 3, 3, 3, 1], baseFret: 4, barres: [{ fret: 1, from: 1, to: 5 }] },
  "C#5":     { frets: [-1, 1, 3, 3, -1, -1], baseFret: 4 },
  "C#m":     { frets: [-1, 1, 3, 3, 2, 1], baseFret: 4, barres: [{ fret: 1, from: 1, to: 5 }] },
  "C#m7":    { frets: [-1, 1, 3, 1, 2, 1], baseFret: 4, barres: [{ fret: 1, from: 1, to: 5 }] },
  "C#m/B":   { frets: [-1, 2, 2, 1, 2, 0], baseFret: 1 },
  "C#m/G#":  { frets: [1, 1, 3, 3, 2, 1], baseFret: 4, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Db":      { frets: [-1, 1, 3, 3, 3, 1], baseFret: 4, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Dbmaj7":  { frets: [-1, 1, 3, 2, 3, 1], baseFret: 4, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Db7":     { frets: [-1, 1, 3, 1, 3, 1], baseFret: 4, barres: [{ fret: 1, from: 1, to: 5 }] },

  // D family
  "D":        { frets: [-1, -1, 0, 2, 3, 2], baseFret: 1 },
  "D2":       { frets: [-1, -1, 0, 2, 3, 0], baseFret: 1 },
  "D4":       { frets: [-1, -1, 0, 2, 3, 3], baseFret: 1 },
  "Dsus4":    { frets: [-1, -1, 0, 2, 3, 3], baseFret: 1 },
  "Dsus2":    { frets: [-1, -1, 0, 2, 3, 0], baseFret: 1 },
  "Dadd9":    { frets: [-1, -1, 0, 2, 3, 0], baseFret: 1 },
  "Dmaj7":    { frets: [-1, -1, 0, 2, 2, 2], baseFret: 1 },
  "Dmaj9":    { frets: [-1, -1, 0, 2, 2, 0], baseFret: 1 },
  "D7":       { frets: [-1, -1, 0, 2, 1, 2], baseFret: 1 },
  "D7sus4":   { frets: [-1, -1, 0, 2, 1, 3], baseFret: 1 },
  "D9":       { frets: [-1, -1, 0, 2, 1, 0], baseFret: 1 },
  "D6":       { frets: [-1, -1, 0, 2, 0, 2], baseFret: 1 },
  "D6/9":     { frets: [-1, -1, 0, 2, 0, 0], baseFret: 1 },
  "D5":       { frets: [-1, -1, 0, 2, 3, -1], baseFret: 1 },
  "Dm":       { frets: [-1, -1, 0, 2, 3, 1], baseFret: 1 },
  "Dm7":      { frets: [-1, -1, 0, 2, 1, 1], baseFret: 1 },
  "Dm9":      { frets: [-1, -1, 0, 2, 1, 0], baseFret: 1 },
  "Dm6":      { frets: [-1, -1, 0, 2, 0, 1], baseFret: 1 },
  "Dmmaj7":   { frets: [-1, -1, 0, 2, 2, 1], baseFret: 1 },
  "Dm7b5":    { frets: [-1, -1, 0, 1, 1, 1], baseFret: 1 },
  "Ddim":     { frets: [-1, -1, 0, 1, 3, 1], baseFret: 1 },
  "Ddim7":    { frets: [-1, -1, 0, 1, 0, 1], baseFret: 1 },
  "Daug":     { frets: [-1, -1, 0, 3, 3, 2], baseFret: 1 },
  "D/F#":     { frets: [2, 0, 0, 2, 3, 2], baseFret: 1 },
  "D/E":      { frets: [0, 0, 0, 2, 3, 2], baseFret: 1 },
  "D/C":      { frets: [-1, 3, 0, 2, 3, 2], baseFret: 1 },
  "D/A":      { frets: [-1, 0, 0, 2, 3, 2], baseFret: 1 },
  "D/B":      { frets: [-1, 2, 0, 2, 3, 2], baseFret: 1 },
  "D/G":      { frets: [3, -1, 0, 2, 3, 2], baseFret: 1 },
  "Dsus4/F#": { frets: [2, 0, 0, 2, 3, 3], baseFret: 1 },
  "D2/F#":    { frets: [2, 0, 0, 2, 3, 0], baseFret: 1 },
  "Dm/C":     { frets: [-1, 3, 0, 2, 3, 1], baseFret: 1 },
  "Dm/F":     { frets: [1, -1, 0, 2, 3, 1], baseFret: 1 },
  "Dm/A":     { frets: [-1, 0, 0, 2, 3, 1], baseFret: 1 },
  "Dm/G":     { frets: [3, -1, 0, 2, 3, 1], baseFret: 1 },
  "Dm7/C":    { frets: [-1, 3, 0, 2, 1, 1], baseFret: 1 },
  "Dm7/G":    { frets: [3, -1, 0, 2, 1, 1], baseFret: 1 },

  // Eb / D# family
  "Eb":      { frets: [-1, -1, 1, 3, 4, 3], baseFret: 1 },
  "Ebmaj7":  { frets: [-1, -1, 1, 3, 3, 3], baseFret: 1 },
  "Eb7":     { frets: [-1, -1, 1, 3, 2, 3], baseFret: 1 },
  "Ebm":     { frets: [-1, -1, 1, 3, 4, 2], baseFret: 1 },
  "Ebm7":    { frets: [-1, -1, 1, 3, 2, 2], baseFret: 1 },
  "Eb5":     { frets: [-1, 1, 3, 3, -1, -1], baseFret: 6 },
  "Eb/G":    { frets: [-1, -1, 3, 1, 2, 1], baseFret: 3, barres: [{ fret: 1, from: 3, to: 5 }] },
  "Eb/Bb":   { frets: [1, 1, 3, 3, 3, 1], baseFret: 6, barres: [{ fret: 1, from: 0, to: 5 }] },

  // E family
  "E":       { frets: [0, 2, 2, 1, 0, 0], baseFret: 1 },
  "E2":      { frets: [0, 2, 4, 1, 0, 0], baseFret: 1 },
  "E4":      { frets: [0, 2, 2, 2, 0, 0], baseFret: 1 },
  "Esus4":   { frets: [0, 2, 2, 2, 0, 0], baseFret: 1 },
  "Esus2":   { frets: [0, 2, 4, 4, 0, 0], baseFret: 1 },
  "Eadd9":   { frets: [0, 2, 4, 1, 0, 0], baseFret: 1 },
  "Emaj7":   { frets: [0, 2, 1, 1, 0, 0], baseFret: 1 },
  "E7":      { frets: [0, 2, 0, 1, 0, 0], baseFret: 1 },
  "E7sus4":  { frets: [0, 2, 0, 2, 0, 0], baseFret: 1 },
  "E9":      { frets: [0, 2, 0, 1, 0, 2], baseFret: 1 },
  "E7#9":    { frets: [0, 2, 0, 1, 3, 3], baseFret: 1 },
  "E7b9":    { frets: [0, 2, 0, 1, 3, 1], baseFret: 1 },
  "E6":      { frets: [0, 2, 2, 1, 2, 0], baseFret: 1 },
  "E5":      { frets: [0, 2, 2, -1, -1, -1], baseFret: 1 },
  "Em":      { frets: [0, 2, 2, 0, 0, 0], baseFret: 1 },
  "Em7":     { frets: [0, 2, 2, 0, 3, 0], baseFret: 1 },
  "Em9":     { frets: [0, 2, 0, 0, 0, 2], baseFret: 1 },
  "Em6":     { frets: [0, 2, 2, 0, 2, 0], baseFret: 1 },
  "Emmaj7":  { frets: [0, 2, 1, 0, 0, 0], baseFret: 1 },
  "Em7b5":   { frets: [0, 1, 2, 0, 3, 0], baseFret: 1 },
  "Edim":    { frets: [0, 1, 2, 0, 2, 0], baseFret: 1 },
  "Eaug":    { frets: [0, 3, 2, 1, 1, 0], baseFret: 1 },
  "E/G#":    { frets: [4, 2, 2, 1, 0, 0], baseFret: 1 },
  "E/B":     { frets: [-1, 2, 2, 1, 0, 0], baseFret: 1 },
  "E/D":     { frets: [-1, -1, 0, 1, 0, 0], baseFret: 1 },
  "E/F#":    { frets: [2, 2, 2, 1, 0, 0], baseFret: 1 },
  "E2/G#":   { frets: [4, 2, 4, 1, 0, 0], baseFret: 1 },
  "Em/D":    { frets: [-1, -1, 0, 0, 0, 0], baseFret: 1 },
  "Em/G":    { frets: [3, 2, 2, 0, 0, 0], baseFret: 1 },
  "Em/B":    { frets: [-1, 2, 2, 0, 0, 0], baseFret: 1 },
  "Em/F#":   { frets: [2, 2, 2, 0, 0, 0], baseFret: 1 },
  "Em7/D":   { frets: [-1, -1, 0, 0, 3, 0], baseFret: 1 },
  "Em7/G":   { frets: [3, 2, 2, 0, 3, 0], baseFret: 1 },
  "Em7/B":   { frets: [-1, 2, 2, 0, 3, 0], baseFret: 1 },

  // F family
  "F":       { frets: [1, 3, 3, 2, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "F2":      { frets: [-1, -1, 3, 0, 1, 1], baseFret: 1 },
  "Fmaj7":   { frets: [-1, -1, 3, 2, 1, 0], baseFret: 1 },
  "F7":      { frets: [1, 3, 1, 2, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fsus4":   { frets: [1, 3, 3, 3, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fsus2":   { frets: [-1, -1, 3, 0, 1, 1], baseFret: 1 },
  "Fadd9":   { frets: [-1, -1, 3, 2, 1, 3], baseFret: 1 },
  "F6":      { frets: [-1, -1, 3, 2, 3, 1], baseFret: 1 },
  "F5":      { frets: [1, 3, 3, -1, -1, -1], baseFret: 1 },
  "Fm":      { frets: [1, 3, 3, 1, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fm7":     { frets: [1, 3, 1, 1, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Fdim":    { frets: [-1, -1, 3, 1, 0, 1], baseFret: 1 },
  "Faug":    { frets: [-1, -1, 3, 2, 2, 1], baseFret: 1 },
  "F/A":     { frets: [-1, 0, 3, 2, 1, 1], baseFret: 1 },
  "F/C":     { frets: [-1, 3, 3, 2, 1, 1], baseFret: 1 },
  "F/G":     { frets: [3, -1, 3, 2, 1, 1], baseFret: 1 },
  "F/E":     { frets: [0, -1, 3, 2, 1, 1], baseFret: 1 },
  "Fmaj7/C": { frets: [-1, 3, 3, 2, 1, 0], baseFret: 1 },
  "Fmaj7/A": { frets: [-1, 0, 3, 2, 1, 0], baseFret: 1 },
  "F2/A":    { frets: [-1, 0, 3, 0, 1, 1], baseFret: 1 },

  // F# / Gb family
  "F#":      { frets: [1, 3, 3, 2, 1, 1], baseFret: 2, barres: [{ fret: 1, from: 0, to: 5 }] },
  "F#5":     { frets: [1, 3, 3, -1, -1, -1], baseFret: 2 },
  "F#m":     { frets: [1, 3, 3, 1, 1, 1], baseFret: 2, barres: [{ fret: 1, from: 0, to: 5 }] },
  "F#m7":    { frets: [1, 3, 1, 1, 1, 1], baseFret: 2, barres: [{ fret: 1, from: 0, to: 5 }] },
  "F#m7b5":  { frets: [2, -1, 2, 2, 1, -1], baseFret: 1 },
  "F#m/E":   { frets: [0, -1, 4, 2, 2, 2], baseFret: 1 },
  "F#m/C#":  { frets: [-1, 4, 4, 2, 2, 2], baseFret: 1 },

  // G family
  "G":        { frets: [3, 2, 0, 0, 3, 3], baseFret: 1 },
  "G2":       { frets: [3, 0, 0, 2, 3, 3], baseFret: 1 },
  "G4":       { frets: [3, 3, 0, 0, 1, 3], baseFret: 1 },
  "Gsus4":    { frets: [3, 3, 0, 0, 1, 3], baseFret: 1 },
  "Gsus2":    { frets: [3, 0, 0, 0, 3, 3], baseFret: 1 },
  "Gadd9":    { frets: [3, 0, 0, 2, 0, 3], baseFret: 1 },
  "Gmaj7":    { frets: [3, 2, 0, 0, 0, 2], baseFret: 1 },
  "G7":       { frets: [3, 2, 0, 0, 0, 1], baseFret: 1 },
  "G7sus4":   { frets: [3, 3, 0, 0, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 4, to: 5 }] },
  "G9":       { frets: [3, 2, 0, 2, 0, 1], baseFret: 1 },
  "G6":       { frets: [3, 2, 0, 0, 0, 0], baseFret: 1 },
  "G5":       { frets: [3, 5, 5, -1, -1, -1], baseFret: 1 },
  "Gm":       { frets: [1, 3, 3, 1, 1, 1], baseFret: 3, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Gm7":      { frets: [1, 3, 1, 1, 1, 1], baseFret: 3, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Gdim":     { frets: [-1, -1, 2, 3, 2, 3], baseFret: 1 },
  "Gaug":     { frets: [3, 2, 1, 0, 0, 3], baseFret: 1 },
  "G/B":      { frets: [-1, 2, 0, 0, 3, 3], baseFret: 1 },
  "G/D":      { frets: [-1, -1, 0, 0, 3, 3], baseFret: 1 },
  "G/F#":     { frets: [2, 2, 0, 0, 3, 3], baseFret: 1 },
  "G/A":      { frets: [-1, 0, 0, 0, 0, 3], baseFret: 1 },
  "G/C":      { frets: [-1, 3, 0, 0, 0, 3], baseFret: 1 },
  "G/E":      { frets: [0, 2, 0, 0, 3, 3], baseFret: 1 },
  "Gsus4/F#": { frets: [2, 3, 0, 0, 1, 3], baseFret: 1 },
  "G2/B":     { frets: [-1, 2, 0, 2, 3, 3], baseFret: 1 },

  // G# / Ab family
  "G#":      { frets: [1, 3, 3, 2, 1, 1], baseFret: 4, barres: [{ fret: 1, from: 0, to: 5 }] },
  "G#5":     { frets: [1, 3, 3, -1, -1, -1], baseFret: 4 },
  "G#m":     { frets: [1, 3, 3, 1, 1, 1], baseFret: 4, barres: [{ fret: 1, from: 0, to: 5 }] },
  "G#m7":    { frets: [1, 3, 1, 1, 1, 1], baseFret: 4, barres: [{ fret: 1, from: 0, to: 5 }] },
  "G#m/F#":  { frets: [-1, -1, 1, 1, 1, 1], baseFret: 4, barres: [{ fret: 1, from: 2, to: 5 }] },
  "Ab":      { frets: [1, 3, 3, 2, 1, 1], baseFret: 4, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Abmaj7":  { frets: [-1, -1, 1, 1, 1, 3], baseFret: 1, barres: [{ fret: 1, from: 2, to: 4 }] },
  "Ab/C":    { frets: [-1, 3, 1, 1, 1, -1], baseFret: 1, barres: [{ fret: 1, from: 2, to: 4 }] },
  "Ab/Eb":   { frets: [-1, 3, 3, 2, 1, 1], baseFret: 4, barres: [{ fret: 1, from: 4, to: 5 }] },

  // A family
  "A":       { frets: [-1, 0, 2, 2, 2, 0], baseFret: 1 },
  "A2":      { frets: [-1, 0, 2, 2, 0, 0], baseFret: 1 },
  "A4":      { frets: [-1, 0, 2, 2, 3, 0], baseFret: 1 },
  "Asus4":   { frets: [-1, 0, 2, 2, 3, 0], baseFret: 1 },
  "Asus2":   { frets: [-1, 0, 2, 2, 0, 0], baseFret: 1 },
  "Aadd9":   { frets: [-1, 0, 2, 4, 2, 0], baseFret: 1 },
  "Amaj7":   { frets: [-1, 0, 2, 1, 2, 0], baseFret: 1 },
  "Amaj9":   { frets: [-1, 0, 2, 1, 0, 0], baseFret: 1 },
  "A7":      { frets: [-1, 0, 2, 0, 2, 0], baseFret: 1 },
  "A7sus4":  { frets: [-1, 0, 2, 0, 3, 0], baseFret: 1 },
  "A9":      { frets: [-1, 0, 2, 4, 2, 3], baseFret: 1 },
  "A7b9":    { frets: [-1, 0, 2, 3, 2, 3], baseFret: 1 },
  "A6":      { frets: [-1, 0, 2, 2, 2, 2], baseFret: 1 },
  "A13":     { frets: [-1, 0, 2, 0, 2, 2], baseFret: 1 },
  "A5":      { frets: [-1, 0, 2, 2, -1, -1], baseFret: 1 },
  "Am":      { frets: [-1, 0, 2, 2, 1, 0], baseFret: 1 },
  "Am7":     { frets: [-1, 0, 2, 0, 1, 0], baseFret: 1 },
  "Am9":     { frets: [-1, 0, 2, 4, 1, 3], baseFret: 1 },
  "Am6":     { frets: [-1, 0, 2, 2, 1, 2], baseFret: 1 },
  "Ammaj7":  { frets: [-1, 0, 2, 1, 1, 0], baseFret: 1 },
  "Am7b5":   { frets: [-1, 0, 1, 0, 1, 0], baseFret: 1 },
  "Adim":    { frets: [-1, 0, 1, 2, 1, -1], baseFret: 1 },
  "Adim7":   { frets: [-1, 0, 1, 2, 1, 2], baseFret: 1 },
  "Aaug":    { frets: [-1, 0, 3, 2, 2, 1], baseFret: 1 },
  "A/C#":    { frets: [-1, 4, 2, 2, 2, 0], baseFret: 1 },
  "A/E":     { frets: [0, 0, 2, 2, 2, 0], baseFret: 1 },
  "A/G":     { frets: [3, 0, 2, 2, 2, 0], baseFret: 1 },
  "A/G#":    { frets: [4, 0, 2, 2, 2, 0], baseFret: 1 },
  "A/B":     { frets: [-1, 2, 2, 2, 2, 0], baseFret: 1 },
  "A2/C#":   { frets: [-1, 4, 2, 2, 0, 0], baseFret: 1 },
  "Asus4/E": { frets: [0, 0, 2, 2, 3, 0], baseFret: 1 },
  "Am/G":    { frets: [3, 0, 2, 2, 1, 0], baseFret: 1 },
  "Am/E":    { frets: [0, 0, 2, 2, 1, 0], baseFret: 1 },
  "Am/F#":   { frets: [2, 0, 2, 2, 1, 0], baseFret: 1 },
  "Am/F":    { frets: [1, 0, 2, 2, 1, 0], baseFret: 1 },
  "Am/C":    { frets: [-1, 3, 2, 2, 1, 0], baseFret: 1 },
  "Am7/G":   { frets: [3, 0, 2, 0, 1, 0], baseFret: 1 },
  "Am7/E":   { frets: [0, 0, 2, 0, 1, 0], baseFret: 1 },

  // Bb / A# family
  "Bb":      { frets: [-1, 1, 3, 3, 3, 1], baseFret: 1, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bb2":     { frets: [-1, 1, 3, 3, 1, 1], baseFret: 1, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bbmaj7":  { frets: [-1, 1, 3, 2, 3, 1], baseFret: 1, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bb7":     { frets: [-1, 1, 3, 1, 3, 1], baseFret: 1, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bb5":     { frets: [-1, 1, 3, 3, -1, -1], baseFret: 1 },
  "Bbm":     { frets: [-1, 1, 3, 3, 2, 1], baseFret: 1, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bbm7":    { frets: [-1, 1, 3, 1, 2, 1], baseFret: 1, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bb/D":    { frets: [-1, -1, 0, 3, 3, 1], baseFret: 1 },
  "Bb/F":    { frets: [1, 1, 3, 3, 3, 1], baseFret: 1, barres: [{ fret: 1, from: 0, to: 5 }] },

  // B family
  "B":       { frets: [-1, 1, 3, 3, 3, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "B2":      { frets: [-1, 1, 3, 3, 1, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bsus4":   { frets: [-1, 1, 3, 3, 4, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bsus2":   { frets: [-1, 1, 3, 3, 1, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bmaj7":   { frets: [-1, 1, 3, 2, 3, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "B7":      { frets: [-1, 2, 1, 2, 0, 2], baseFret: 1 },
  "B5":      { frets: [-1, 2, 4, 4, -1, -1], baseFret: 1 },
  "Bm":      { frets: [-1, 1, 3, 3, 2, 1], baseFret: 2, barres: [{ fret: 1, from: 1, to: 5 }] },
  "Bm7":     { frets: [-1, 2, 0, 2, 0, 2], baseFret: 1 },
  "Bm11":    { frets: [-1, 2, 2, 2, 3, 2], baseFret: 1, barres: [{ fret: 2, from: 1, to: 5 }] },
  "Bdim":    { frets: [-1, 2, 3, 4, 3, -1], baseFret: 1 },
  "Bdim7":   { frets: [-1, 2, 3, 1, 3, -1], baseFret: 1 },
  "Baug":    { frets: [-1, 2, 1, 0, 0, 3], baseFret: 1 },
  "B/D#":    { frets: [-1, -1, 1, 4, 4, 2], baseFret: 1 },
  "B/F#":    { frets: [1, 1, 3, 3, 3, 1], baseFret: 2, barres: [{ fret: 1, from: 0, to: 5 }] },
  "B/A":     { frets: [-1, 0, 4, 4, 4, 2], baseFret: 1 },
  "Bm/A":    { frets: [-1, 0, 4, 4, 3, 2], baseFret: 1 },
  "Bm/F#":   { frets: [1, 1, 3, 3, 2, 1], baseFret: 2, barres: [{ fret: 1, from: 0, to: 5 }] },
  "Bm/D":    { frets: [-1, -1, 0, 4, 3, 2], baseFret: 1 }
};

const OPEN_STRING_PITCHES = [4, 9, 2, 7, 11, 4]; // E A D G B e

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

  const pitch = NOTE_TO_PITCH[parsed.root];
  const sharpRoot = CHROMATIC_SHARPS[pitch];
  const flatRoot = CHROMATIC_FLATS[pitch];
  const rootNames = Array.from(new Set([parsed.root, sharpRoot, flatRoot]));

  const bassNames = parsed.bass
    ? Array.from(new Set([
        parsed.bass,
        CHROMATIC_SHARPS[NOTE_TO_PITCH[parsed.bass]],
        CHROMATIC_FLATS[NOTE_TO_PITCH[parsed.bass]]
      ]))
    : [null];

  const normQual = normalizeVoicingQuality(parsed.quality);
  const qualCandidates = Array.from(new Set([parsed.quality, normQual]));

  for (const q of qualCandidates) {
    for (const r of rootNames) {
      for (const b of bassNames) {
        const candidate = r + q + (b ? "/" + b : "");
        if (BUILTIN_VOICINGS[candidate]) return BUILTIN_VOICINGS[candidate];
      }
    }
  }

  let baseVoicing = null;
  for (const q of qualCandidates) {
    for (const r of rootNames) {
      const candidate = r + q;
      if (BUILTIN_VOICINGS[candidate]) {
        baseVoicing = BUILTIN_VOICINGS[candidate];
        break;
      }
    }
    if (baseVoicing) break;
  }

  if (!baseVoicing) {
    baseVoicing = generateMovableVoicing(pitch, normQual);
  }
  if (!baseVoicing || !parsed.bass) return baseVoicing;

  return applySlashBass(baseVoicing, NOTE_TO_PITCH[parsed.bass]);
}

function normalizeVoicingQuality(q) {
  if (!q) return "";
  const clean = q.replace(/[()]/g, "");
  const map = {
    "min": "m", "-": "m",
    "M7": "maj7", "Δ": "maj7", "Δ7": "maj7",
    "M9": "maj9", "Δ9": "maj9",
    "M11": "maj11", "M13": "maj13",
    "min7": "m7", "-7": "m7",
    "min9": "m9", "-9": "m9",
    "min11": "m11", "-11": "m11",
    "min6": "m6",
    "min7b5": "m7b5", "ø": "m7b5", "ø7": "m7b5",
    "°": "dim", "°7": "dim7",
    "+": "aug", "+7": "aug7",
    "sus": "sus4", "4": "sus4",
    "2": "sus2", "add2": "sus2",
    "69": "6/9",
    "add4": "add11"
  };
  return map[clean] || clean;
}

function fretForPitchOnString(stringIdx, targetPitch, baseFret) {
  const openPitch = OPEN_STRING_PITCHES[stringIdx];
  if (openPitch === targetPitch) return 0;
  for (let rel = 1; rel <= 4; rel++) {
    const absFret = baseFret + rel - 1;
    if ((openPitch + absFret) % 12 === targetPitch) return rel;
  }
  return null;
}

function applySlashBass(voicing, bassPitch) {
  const frets = [...voicing.frets];
  const baseFret = voicing.baseFret || 1;
  const barres = Array.isArray(voicing.barres) ? voicing.barres.map((b) => ({ ...b })) : [];

  // Already has the requested bass note on the lowest sounding string.
  const firstSounding = frets.findIndex((f) => f >= 0);
  if (firstSounding !== -1) {
    const f = frets[firstSounding];
    const abs = f === 0 ? 0 : baseFret + f - 1;
    if ((OPEN_STRING_PITCHES[firstSounding] + abs) % 12 === bassPitch) {
      return voicing;
    }
  }

  // Try placing the bass note on string 0 (low E), 1 (A), or 2 (D), muting lower strings.
  for (const s of [0, 1, 2]) {
    const placed = fretForPitchOnString(s, bassPitch, baseFret);
    if (placed === null) continue;
    const nextFrets = [...frets];
    for (let i = 0; i < s; i++) nextFrets[i] = -1;
    nextFrets[s] = placed;
    const nextBarres = barres
      .map((b) => {
        const minString = placed === b.fret ? s : s + 1;
        const from = Math.max(b.from, minString);
        return from < b.to ? { ...b, from } : null;
      })
      .filter(Boolean);
    if (nextFrets.filter((f) => f >= 0).length >= 3) {
      return { frets: nextFrets, baseFret, barres: nextBarres };
    }
  }
  return voicing;
}

function movableCoreFallback(quality) {
  if (/^m(?:aj|in)?.*7b5/.test(quality)) return "m7b5";
  if (/^mmaj/.test(quality)) return "mmaj7";
  if (/^m(?:9|11|13)/.test(quality)) return "m7";
  if (/^m/.test(quality)) return "m";
  if (/^maj/.test(quality)) return "maj7";
  if (/^dim/.test(quality)) return "dim7";
  if (/^aug|7#5|\+/.test(quality)) return "aug7";
  if (/sus4/.test(quality)) return "sus4";
  if (/sus2/.test(quality)) return "sus2";
  if (/^(?:7|9|11|13)/.test(quality)) return "7";
  return "";
}

function generateMovableVoicing(pitch, quality) {
  const eFret = ((pitch - 4) % 12 + 12) % 12 || 12;
  const aFret = ((pitch - 9) % 12 + 12) % 12 || 12;

  const shiftDown = (delta, spec, fallbackSpec) => (aFret >= delta + 1
    ? { ...spec, baseFret: aFret - delta }
    : fallbackSpec);

  const shapesA = {
    "":         { frets: [-1, 1, 3, 3, 3, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "m":        { frets: [-1, 1, 3, 3, 2, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "5":        { frets: [-1, 1, 3, 3, -1, -1], baseFret: aFret, barres: [] },
    "7":        { frets: [-1, 1, 3, 1, 3, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "maj7":     { frets: [-1, 1, 3, 2, 3, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "m7":       { frets: [-1, 1, 3, 1, 2, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "6":        { frets: [-1, 1, 3, 3, 3, 3], baseFret: aFret, barres: [] },
    "m6":       { frets: [-1, 1, 3, 3, 2, 3], baseFret: aFret, barres: [] },
    "6/9":      shiftDown(1, { frets: [-1, 2, 1, 1, 2, 2], barres: [{ fret: 1, from: 2, to: 3 }] }, { frets: [-1, 1, 0, 0, 1, 1], baseFret: 1, barres: [] }),
    "9":        shiftDown(1, { frets: [-1, 2, 1, 2, 2, 2], barres: [] }, { frets: [-1, 1, 0, 1, 1, 1], baseFret: 1, barres: [] }),
    "maj9":     shiftDown(1, { frets: [-1, 2, 1, 3, 2, -1], barres: [] }, { frets: [-1, 1, 0, 2, 1, -1], baseFret: 1, barres: [] }),
    "m9":       shiftDown(2, { frets: [-1, 3, 1, 3, 3, -1], barres: [] }, { frets: [-1, 1, 3, 1, 2, 3], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] }),
    "11":       { frets: [-1, 1, 1, 1, 1, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "m11":      { frets: [-1, 1, 1, 1, 2, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "13":       { frets: [-1, 1, 3, 1, 3, 3], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 3 }] },
    "maj13":    { frets: [-1, 1, 3, 2, 3, 3], baseFret: aFret, barres: [] },
    "m13":      { frets: [-1, 1, 3, 1, 2, 3], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 3 }] },
    "sus2":     { frets: [-1, 1, 3, 3, 1, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "sus4":     { frets: [-1, 1, 3, 3, 4, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "7sus4":    { frets: [-1, 1, 3, 1, 4, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "7sus2":    { frets: [-1, 1, 3, 1, 1, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "9sus4":    { frets: [-1, 1, 1, 1, 1, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "sus2sus4": { frets: [-1, 1, 1, 3, 1, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "add9":     { frets: [-1, 1, 3, 5, 3, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "add11":    { frets: [-1, 1, 1, 3, 3, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "dim":      { frets: [-1, 1, 2, 3, 2, -1], baseFret: aFret, barres: [] },
    "dim7":     shiftDown(1, { frets: [-1, 2, 3, 1, 3, -1], barres: [] }, { frets: [-1, 1, 2, 0, 2, -1], baseFret: 1, barres: [] }),
    "m7b5":     { frets: [-1, 1, 2, 1, 2, -1], baseFret: aFret, barres: [] },
    "mmaj7":    { frets: [-1, 1, 3, 2, 2, 1], baseFret: aFret, barres: [{ fret: 1, from: 1, to: 5 }] },
    "aug":      { frets: [-1, 1, 4, 3, 3, -1], baseFret: aFret, barres: [] },
    "aug7":     { frets: [-1, 1, 4, 1, 3, -1], baseFret: aFret, barres: [] },
    "7#9":      shiftDown(1, { frets: [-1, 2, 1, 2, 3, -1], barres: [] }, { frets: [-1, 1, 0, 1, 2, -1], baseFret: 1, barres: [] }),
    "7b9":      shiftDown(1, { frets: [-1, 2, 1, 2, 1, -1], barres: [] }, { frets: [-1, 1, 0, 1, 0, -1], baseFret: 1, barres: [] }),
    "7#5":      { frets: [-1, 1, 4, 1, 3, -1], baseFret: aFret, barres: [] },
    "7b5":      { frets: [-1, 1, 2, 1, 3, -1], baseFret: aFret, barres: [] }
  };

  const shiftDownE = (delta, spec, fallbackSpec) => (eFret >= delta + 1
    ? { ...spec, baseFret: eFret - delta }
    : fallbackSpec);

  const shapesE = {
    "":         { frets: [1, 3, 3, 2, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "m":        { frets: [1, 3, 3, 1, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "5":        { frets: [1, 3, 3, -1, -1, -1], baseFret: eFret, barres: [] },
    "7":        { frets: [1, 3, 1, 2, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "maj7":     { frets: [1, -1, 2, 2, 1, -1], baseFret: eFret, barres: [] },
    "m7":       { frets: [1, 3, 1, 1, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "6":        { frets: [1, -1, 0, 2, 1, -1], baseFret: eFret, barres: [] },
    "m6":       { frets: [1, 3, 3, 1, 3, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "6/9":      shiftDownE(1, { frets: [2, 1, 1, 1, 2, 2], barres: [{ fret: 1, from: 1, to: 3 }] }, { frets: [1, 0, 0, 0, 1, 1], baseFret: 1, barres: [] }),
    "9":        { frets: [1, 3, 1, 2, 1, 3], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "maj9":     { frets: [1, 3, 2, 2, 1, 3], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 4 }] },
    "m9":       { frets: [1, 3, 1, 1, 1, 3], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "11":       { frets: [1, -1, 1, 2, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "m11":      shiftDownE(2, { frets: [3, -1, 3, 3, 1, -1], barres: [] }, shapesA["m11"]),
    "13":       { frets: [1, -1, 1, 2, 3, -1], baseFret: eFret, barres: [] },
    "maj13":    { frets: [1, -1, 2, 2, 3, -1], baseFret: eFret, barres: [] },
    "m13":      { frets: [1, -1, 1, 1, 3, -1], baseFret: eFret, barres: [] },
    "sus2":     { frets: [1, 3, 5, 5, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "sus4":     { frets: [1, 3, 3, 3, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "7sus4":    { frets: [1, 3, 1, 3, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "7sus2":    { frets: [1, -1, 1, 3, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "9sus4":    { frets: [1, 3, 1, 3, 1, 3], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 4 }] },
    "sus2sus4": { frets: [1, 3, 3, 3, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "add9":     { frets: [1, 3, 5, 2, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "add11":    { frets: [1, 3, 3, 3, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "dim":      { frets: [1, -1, 1, 2, 1, -1], baseFret: eFret, barres: [] },
    "dim7":     shiftDownE(1, { frets: [2, -1, 1, 2, 1, -1], barres: [] }, { frets: [1, -1, 0, 1, 0, -1], baseFret: 1, barres: [] }),
    "m7b5":     shiftDownE(1, { frets: [2, -1, 2, 2, 1, -1], barres: [] }, { frets: [1, -1, 1, 1, 0, -1], baseFret: 1, barres: [] }),
    "mmaj7":    { frets: [1, 3, 2, 1, 1, 1], baseFret: eFret, barres: [{ fret: 1, from: 0, to: 5 }] },
    "aug":      { frets: [1, -1, 3, 2, 2, -1], baseFret: eFret, barres: [] },
    "aug7":     { frets: [1, -1, 1, 2, 2, -1], baseFret: eFret, barres: [] },
    "7#9":      shapesA["7#9"],
    "7b9":      shapesA["7b9"],
    "7#5":      { frets: [1, -1, 1, 2, 2, -1], baseFret: eFret, barres: [] },
    "7b5":      shiftDownE(1, { frets: [2, -1, 2, 3, 1, -1], barres: [] }, { frets: [1, -1, 1, 2, 0, -1], baseFret: 1, barres: [] })
  };
  // E6 uses an open D-string fallback when eFret is above 1; compute accurately when eFret >= 3.
  if (eFret >= 3) shapesE["6"] = { frets: [2, -1, 1, 2, 2, -1], baseFret: eFret - 1, barres: [] };
  else shapesE["6"] = shapesA["6"];

  const useAShape = aFret <= 6 && aFret < eFret;
  const resolved = Object.prototype.hasOwnProperty.call(shapesA, quality) ? quality : movableCoreFallback(quality);
  const chosen = useAShape ? shapesA[resolved] : shapesE[resolved];
  if (chosen) return chosen;
  return shapesA[""] || shapesE[""];
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
