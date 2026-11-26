// Melody range (js/melody.js)
// A song's key alone doesn't say whether you can sing it: the lowest and highest notes of the
// melody do. Each song keeps those two notes in layout_prefs.melody, measured against the key the
// sheet is written in (no capo, standard tuning), so transposing, a capo, or a half-step-down
// tuning move them along with the chords:
//   { low: 45, high: 64, key: "G", source: "ai" | "you", confidence?: "high"|"medium"|"low",
//     recording_key?: "A",
//     original?: { key: "A", low: 47, high: 66, source: "ai" | "you", confidence } }
// `low`/`high`/`key` are the one saved source for this sheet; what you sing now is worked out from
// them (sungRange), never saved separately. `original` is the recording's own key and notes in
// concert pitch, kept as a reference that never moves when the sheet is transposed or rewritten.
// Notes are MIDI numbers (60 = middle C, C4). Singers choose their octave (a man sings a woman's
// song an octave down), so fitting a song to a voice tries the octave above and below too.

import { loadLocal, saveLocal } from "./core.js";
import { NOTE_TO_PITCH, normalizeKeyName, transposeKey, getTuning, getKeyCenter, parseChord, inferKeyFromChords } from "./chords.js";
import { parse } from "./chordpro.js";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// The notes the pickers offer: C2 (a low bass note) to C6 (a high soprano note).
export const NOTE_LOWEST = 36;
export const NOTE_HIGHEST = 84;

export function midiToNote(midi) {
  if (!Number.isFinite(midi)) return "";
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

// "F#3" or "Bb4" -> MIDI number, or null.
export function noteToMidi(note) {
  const m = String(note || "").trim().match(/^([A-Ga-g])([#b]?)(-?\d)$/);
  if (!m) return null;
  const pitch = NOTE_TO_PITCH[m[1].toUpperCase() + m[2]];
  return pitch == null ? null : (Number(m[3]) + 1) * 12 + pitch;
}

export function rangeText(r) {
  return r ? `${midiToNote(r.low)}–${midiToNote(r.high)}` : "";
}

// Smallest move between two keys, -6..+5 half steps. A minor key counts as its relative major.
function keyInterval(fromKey, toKey) {
  const d = (((getKeyCenter(toKey).pitch - getKeyCenter(fromKey).pitch) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

function sheetBasics(song) {
  const parsed = parse(song?.chordpro || "");
  return {
    writtenKey: normalizeKeyName(song?.key || parsed.meta.key || parsed.meta.inferredKey || "G"),
    capo: Number(song?.capo ?? parsed.meta.capo ?? 0) || 0,
    tuningOffset: getTuning(song?.tuning || parsed.meta.tuning).offset || 0
  };
}

/** Half steps from the written key (no capo, standard tuning) to what you hear now. */
export function soundingShift(song) {
  const b = sheetBasics(song);
  return Number(song?.preferred_transpose || 0) + b.capo + b.tuningOffset;
}

/** The original recording's key and notes (concert pitch), or null when not known. */
export function originalMelody(song) {
  const o = song?.layout_prefs?.melody?.original;
  if (!o || !o.key || !Number.isFinite(o.low) || !Number.isFinite(o.high) || o.high <= o.low) return null;
  return { key: o.key, low: o.low, high: o.high, source: o.source || "ai", confidence: o.confidence || null };
}

/** The stored melody, moved to the sheet's current written key, or null. */
export function storedMelody(song) {
  const m = song?.layout_prefs?.melody;
  if (!m || !Number.isFinite(m.low) || !Number.isFinite(m.high) || m.high <= m.low) return null;
  const shift = m.key ? keyInterval(m.key, sheetBasics(song).writtenKey) : 0;
  return {
    low: m.low + shift,
    high: m.high + shift,
    source: m.source || "ai",
    confidence: m.confidence || null,
    recordingKey: m.recording_key || null
  };
}

/** The notes you sing the song on now, with its transpose, capo, and tuning, or null. */
export function sungRange(song) {
  const m = storedMelody(song);
  if (!m) return null;
  const shift = soundingShift(song);
  return { ...m, low: m.low + shift, high: m.high + shift };
}

/** A melody you sing on `low`..`high` right now, saved against the written key. */
export function melodyFromSung(song, low, high, source = "you") {
  const shift = soundingShift(song);
  const melody = { low: low - shift, high: high - shift, key: sheetBasics(song).writtenKey, source };
  // Correcting this sheet's notes by hand doesn't change the original recording.
  const prev = song?.layout_prefs?.melody;
  if (prev?.recording_key) melody.recording_key = prev.recording_key;
  if (prev?.original) melody.original = prev.original;
  return melody;
}

/**
 * The AI's notes come from the recording, in its key. The sheet as written (with its capo and
 * tuning) may sit in another key, so move the notes to the sheet first.
 */
export function melodyFromRecording(song, { recording_key, low, high, confidence }, source = "ai") {
  const b = sheetBasics(song);
  const soundsAt = transposeKey(b.writtenKey, b.capo + b.tuningOffset);
  const toSheet = recording_key ? keyInterval(recording_key, soundsAt) : 0;
  const shift = toSheet - b.capo - b.tuningOffset;
  const key = recording_key ? normalizeKeyName(recording_key) : null;
  return {
    low: low + shift,
    high: high + shift,
    key: b.writtenKey,
    source,
    confidence: confidence || null,
    recording_key: key,
    // The recording as the AI (or you) gave it: the reference that never moves.
    original: key ? { key, low, high, source, confidence: confidence || null } : null
  };
}

/** Half steps from the original recording to what you sing on this sheet now, or null. */
export function shiftFromOriginal(song) {
  const o = originalMelody(song);
  const sung = sungRange(song);
  if (!o || !sung) return null;
  // Compare the bottom notes in the octave nearest the original (singers pick their octave).
  const d = sung.low - o.low;
  return d - Math.round(d / 12) * 12;
}

// ---------------------------------------------------------------------------
// Does the sheet's key match its chords?
// ---------------------------------------------------------------------------
const MAJOR_TRIADS = { 0: "maj", 2: "min", 4: "min", 5: "maj", 7: "maj", 9: "min", 11: "dim" };

function chordFitsKey(chord, center) {
  const p = parseChord(chord);
  if (!p || p.isNC) return null;
  const rel = (((NOTE_TO_PITCH[p.root] ?? 0) - center) % 12 + 12) % 12;
  const q = p.quality || "";
  const kind = /^(dim|°|ø|m7b5)/.test(q) ? "dim" : (/^m(?!aj)|^min|^-/.test(q) ? "min" : "maj");
  const want = MAJOR_TRIADS[rel];
  return want === kind || (want === "dim" && kind === "min");
}

/**
 * The sheet's key and the key its chords point to, when they clearly disagree; otherwise null.
 * Relative keys count as one (Am and C share their chords). Quiet on purpose: songs that borrow a
 * chord or two (D–C–G in D) stay unflagged, and only a clear winner is suggested.
 */
export function sheetKeyMismatch(song) {
  const parsed = parse(song?.chordpro || "");
  // Every chord as it's played (allChords lists each name once).
  const chords = [];
  for (const sec of parsed.sections || []) {
    for (const line of sec.lines || []) {
      for (const seg of line.segments || []) {
        const pc = seg.chord && parseChord(seg.chord);
        if (pc && !pc.isNC) chords.push(seg.chord);
      }
    }
  }
  if (chords.length < 8 || new Set(chords).size < 3) return null;
  const written = sheetBasics(song).writtenKey;
  const fit = (center) => chords.filter((c) => chordFitsKey(c, center)).length / chords.length;
  const writtenCenter = getKeyCenter(written).pitch;
  let best = { center: writtenCenter, score: fit(writtenCenter) };
  for (let c = 0; c < 12; c++) {
    const score = fit(c);
    if (score > best.score) best = { center: c, score };
  }
  if (best.center === writtenCenter || fit(writtenCenter) >= 0.5 || best.score < 0.85) return null;
  // Name it the way the song does: a song that opens on the minor home chord (Am in C/Am) is in
  // the minor key; one that opens on the major home chord is major; otherwise the best guess.
  const center = getKeyCenter(transposeKey("C", best.center));
  const first = parseChord(chords[0]);
  const firstPitch = NOTE_TO_PITCH[first.root];
  const firstMinor = /^m(?!aj)|^min|^-/.test(first.quality || "");
  let named;
  if (firstMinor && firstPitch === (best.center + 9) % 12) named = center.minor;
  else if (!firstMinor && firstPitch === best.center) named = center.major;
  else {
    const guess = inferKeyFromChords(chords);
    named = getKeyCenter(guess).pitch === best.center ? guess : center.major;
  }
  return { written, chords: normalizeKeyName(named) };
}

/**
 * The sheet's key label was wrong, but its chords didn't move: re-anchor the melody so you still
 * sing the same notes, and work the recording's shift out again from the original when known.
 */
export function melodyAfterKeyFix(song, newKey) {
  const m = song?.layout_prefs?.melody;
  if (!m) return null;
  const fixed = { ...song, key: newKey };
  const o = originalMelody(song);
  if (o && m.source !== "you") return melodyFromRecording(fixed, { recording_key: o.key, low: o.low, high: o.high, confidence: o.confidence }, o.source);
  const now = sungRange(song);
  return now ? { ...melodyFromSung(fixed, now.low, now.high, m.source || "you"), source: m.source || "you" } : m;
}

// ---------------------------------------------------------------------------
// Your range
// ---------------------------------------------------------------------------
export function getManualVocalRange() {
  const r = loadLocal("vocal_range", null);
  return r && Number.isFinite(r.low) && Number.isFinite(r.high) && r.high > r.low ? { low: r.low, high: r.high } : null;
}

export function setManualVocalRange(range) {
  saveLocal("vocal_range", range && range.high > range.low ? { low: range.low, high: range.high } : null);
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? (v[Math.floor((v.length - 1) / 2)] + v[Math.ceil((v.length - 1) / 2)]) / 2 : 0;
}

// Put a range in the octave whose middle sits nearest `center`.
function nearOctave(r, center) {
  const o = Math.round((center - (r.low + r.high) / 2) / 12) * 12;
  return { ...r, low: r.low + o, high: r.high + o };
}

const singsWell = (s) => s.vocal_comfort === "sweet_spot" || Number(s.vocal_rating) >= 4;

/**
 * Your range from the songs you sing well (Sweet spot, or 4★ and up) that have a melody:
 * their lowest low to their highest high. Also what felt too high or too low, which marks
 * the edges. Null until two such songs have a melody.
 */
export function deriveVocalRange(songs = []) {
  const good = songs.filter(singsWell).map(sungRange).filter(Boolean);
  if (good.length < 2) return null;
  const center = median(good.map((r) => (r.low + r.high) / 2));
  const placed = good.map((r) => nearOctave(r, center));
  const low = Math.min(...placed.map((r) => r.low));
  const high = Math.max(...placed.map((r) => r.high));
  const mid = (low + high) / 2;
  const tooHigh = songs.filter((s) => s.vocal_comfort === "high_stretch").map(sungRange).filter(Boolean).map((r) => nearOctave(r, mid));
  const tooLow = songs.filter((s) => s.vocal_comfort === "too_low").map(sungRange).filter(Boolean).map((r) => nearOctave(r, mid));
  return {
    low,
    high,
    count: good.length,
    stretchHigh: tooHigh.length ? Math.min(...tooHigh.map((r) => r.high)) : null,
    stretchLow: tooLow.length ? Math.max(...tooLow.map((r) => r.low)) : null
  };
}

/** The range songs are matched against: yours if you set it, otherwise worked out from your songs. */
export function getVocalRange(songs = []) {
  const manual = getManualVocalRange();
  if (manual) return { ...manual, from: "you" };
  const derived = deriveVocalRange(songs);
  return derived ? { ...derived, from: "songs" } : null;
}

// ---------------------------------------------------------------------------
// Fitting a song to your range
// ---------------------------------------------------------------------------
/** How far a sung range runs past yours, in its best octave. miss 0 = it fits. */
export function rangeFit(sung, range) {
  let best = null;
  for (const o of [0, -12, 12]) {
    const low = sung.low + o;
    const high = sung.high + o;
    const over = Math.max(0, high - range.high);
    const under = Math.max(0, range.low - low);
    const miss = over + under;
    if (!best || miss < best.miss) best = { low, high, over, under, miss, octave: o };
  }
  return best;
}

/**
 * The key change that puts the melody best inside your range: every note inside first, then
 * room to spare at both ends (up to a whole step each side), then the smallest move, then landing
 * on one of `idealPitches` (your favourite keys). `shifts` limits the moves tried (default -6..+6).
 */
export function bestRangeShift(sung, range, soundingKey, idealPitches = [], shifts = null) {
  let best = null;
  for (const s of shifts || Array.from({ length: 13 }, (_, i) => i - 6)) {
    const fit = rangeFit({ low: sung.low + s, high: sung.high + s }, range);
    const room = Math.min(2, fit.low - range.low, range.high - fit.high);
    const inIdeal = idealPitches.includes(getKeyCenter(transposeKey(soundingKey, s)).pitch);
    const score = fit.miss * 100 - Math.max(0, room) * 10 + Math.abs(s) * 2 - (inIdeal ? 1 : 0);
    if (!best || score < best.score) best = { shift: s, fit, score, room: Math.max(0, room) };
  }
  return best;
}

/**
 * Songs that need the AI lookup: no melody yet, or an AI range saved before the original
 * recording's notes were kept (looked up again to fill them in; ranges you set are never touched,
 * and a failed or unknown lookup leaves the old range as it was).
 */
export function songsMissingMelody(songs = []) {
  return songs.filter((s) => {
    if (!s?.id || !s.title) return false;
    const m = s.layout_prefs?.melody;
    if (!storedMelody(s)) return !s.layout_prefs?.melody_unknown;
    return (m.source || "ai") === "ai" && !originalMelody(s) && !m.original_unknown;
  });
}
