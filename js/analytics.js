// Vocal Range, Singing Key & Guitar Playability Analytics Engine (js/analytics.js)
// Analyzes all saved songs in the user's library to determine:
// 1. Best Singing Keys (Sounding Pitch Keys where vocal_rating is 4-5★ or vocal_comfort === 'sweet_spot')
// 2. Tonal Center Profile (Major / Relative Minor key signature clusters)
// 3. Transposition & Capo Habits (how the user adjusts songs from their written key)
// 4. Smart Song & Key Recommendations ("Songs That Fit You Best" + per-song Key/Capo suggestions)

import { esc, loadLocal, saveLocal } from "./core.js";
import {
  ALL_MAJOR_KEYS,
  NOTE_TO_PITCH,
  EASY_OPEN_CHORDS,
  normalizeKeyName,
  transposeKey,
  transposeChord,
  soundingKeyWithTuning,
  getTuning,
  capoShapesKey,
  getKeyCenter,
  suggestCapoPositions,
  parseChord
} from "./chords.js";
import { parse } from "./chordpro.js";
import {
  getVocalRange,
  getManualVocalRange,
  sungRange,
  rangeFit,
  bestRangeShift,
  rangeText,
  midiToNote,
  songsMissingMelody,
  NOTE_LOWEST,
  NOTE_HIGHEST,
  JOHN_MAYER_RANGE
} from "./melody.js";

/**
 * Compute the effective Shapes Key and Concert Sounding Key for a song row.
 */
export function getSongEffectiveKeys(song) {
  const parsed = parse(song.chordpro || "");
  const writtenKey = normalizeKeyName(song.key || parsed.meta.key || parsed.meta.inferredKey || "G");
  const transpose = Number(song.preferred_transpose || 0);
  const capo = Number(song.capo ?? parsed.meta.capo ?? 0);

  // Shapes key = writtenKey shifted by user's preferred_transpose
  const shapesKey = transposeKey(writtenKey, transpose);
  // Concert sounding key = shapesKey + capo semitones + tuning (half step down is -1)
  const soundingKey = soundingKeyWithTuning(shapesKey, capo, song.tuning || parsed.meta.tuning);
  const center = getKeyCenter(soundingKey);

  // Compute open-chord playability % in the current shapes key
  const allChords = parsed.allChords || [];
  let openHits = 0;
  for (const ch of allChords) {
    const p = parseChord(ch);
    if (!p) continue;
    if (EASY_OPEN_CHORDS.has(ch) || EASY_OPEN_CHORDS.has(p.root)) {
      openHits++;
    }
  }
  const playability = allChords.length ? Math.round((openHits / allChords.length) * 100) : 100;

  return {
    writtenKey,
    transpose,
    capo,
    shapesKey,
    soundingKey,
    center,
    playability,
    chordCount: allChords.length
  };
}

/**
 * Run comprehensive analytics across all songs in the library.
 */
export function computeLibraryAnalytics(songs = []) {
  const keyMap = {};
  ALL_MAJOR_KEYS.forEach((maj) => {
    const c = getKeyCenter(maj);
    keyMap[c.label] = {
      label: c.label,
      major: c.major,
      minor: c.minor,
      pitch: c.pitch,
      songCount: 0,
      ratedCount: 0,
      ratingSum: 0,
      sweetSpotCount: 0,
      tooLowCount: 0,
      highStretchCount: 0,
      avgScore: 0,
      songs: []
    };
  });

  let totalTransposeDown = 0;
  let totalTransposeUp = 0;
  let capoSongsCount = 0;
  const enrichedSongs = [];

  for (const song of songs) {
    const k = getSongEffectiveKeys(song);
    const bucket = keyMap[k.center.label] || keyMap["G / Em"];
    bucket.songCount++;
    bucket.songs.push(song);

    const rating = Number(song.vocal_rating || 0);
    const comfort = song.vocal_comfort || "";
    if (rating > 0) {
      bucket.ratedCount++;
      bucket.ratingSum += rating;
    }
    if (comfort === "sweet_spot" || rating >= 4) {
      bucket.sweetSpotCount++;
    } else if (comfort === "too_low") {
      bucket.tooLowCount++;
    } else if (comfort === "high_stretch") {
      bucket.highStretchCount++;
    }

    if (k.transpose < 0) totalTransposeDown++;
    if (k.transpose > 0) totalTransposeUp++;
    if (k.capo > 0) capoSongsCount++;

    enrichedSongs.push({
      song,
      keys: k,
      rating,
      comfort
    });
  }

  // Score each tonal center for how well the user sings in it
  const keyProfiles = Object.values(keyMap).map((b) => {
    const avgRating = b.ratedCount > 0 ? b.ratingSum / b.ratedCount : (b.songCount > 0 ? 3.8 : 0);
    // Weighted affinity score combining rating, sweetSpot tags, and frequency
    const affinity =
      b.sweetSpotCount * 3.0 +
      b.songCount * 1.2 +
      (b.ratedCount > 0 ? (avgRating - 2.5) * 2.5 : 0) -
      (b.tooLowCount + b.highStretchCount) * 1.5;
    return {
      ...b,
      avgRating: Number(avgRating.toFixed(1)),
      affinity: Number(affinity.toFixed(2))
    };
  });

  const activeProfiles = keyProfiles
    .filter((p) => p.songCount > 0)
    .sort((a, b) => b.affinity - a.affinity || b.songCount - a.songCount);

  const topKeyCenters = activeProfiles.slice(0, 3);
  const bestKeyCenter = topKeyCenters[0] || keyMap["A / F#m"];

  // Compute per-song "Fit Score" (0..100) for ranking "Songs That Fit You Best"
  const topPitches = new Set(topKeyCenters.map((t) => t.pitch));
  for (const item of enrichedSongs) {
    const isTopPitch = topPitches.has(item.keys.center.pitch);
    const minSemitoneDist = topKeyCenters.length
      ? Math.min(
          ...topKeyCenters.map((t) => {
            const diff = Math.abs(item.keys.center.pitch - t.pitch);
            return Math.min(diff, 12 - diff);
          })
        )
      : 0;

    let vocalScore = 70;
    if (item.comfort === "sweet_spot") vocalScore += 22;
    if (item.comfort === "high_stretch" || item.comfort === "too_low") vocalScore -= 25;
    if (item.rating > 0) vocalScore += (item.rating - 3) * 10;
    if (isTopPitch) vocalScore += 10;
    else vocalScore -= minSemitoneDist * 4;

    const totalFit = Math.max(15, Math.min(100, Math.round(vocalScore * 0.65 + item.keys.playability * 0.35)));
    item.fitScore = totalFit;
    item.minSemitoneDist = minSemitoneDist;
  }

  enrichedSongs.sort((a, b) => b.fitScore - a.fitScore);

  return {
    totalSongs: songs.length,
    capoSongsCount,
    totalTransposeDown,
    totalTransposeUp,
    bestKeyCenter,
    topKeyCenters,
    activeProfiles,
    allProfiles: keyProfiles,
    rankedSongs: enrichedSongs
  };
}

/**
 * Recommend the best singing key + capo combination for a specific song
 * based on the user's library vocal analytics.
 */
export function recommendKeyAndCapoForSong(song, librarySongs = []) {
  const analytics = computeLibraryAnalytics(librarySongs);
  const current = getSongEffectiveKeys(song);
  const parsed = parse(song.chordpro || "");
  const targetCenter = analytics.bestKeyCenter;

  if (!targetCenter) return null;

  const isMinorSong = current.soundingKey.endsWith("m");
  const recommendedSoundingKey = isMinorSong ? targetCenter.minor : targetCenter.major;

  // Semitone shift from current written key to recommended sounding key
  const writtenRoot = current.writtenKey.endsWith("m") ? current.writtenKey.slice(0, -1) : current.writtenKey;
  const targetRoot = recommendedSoundingKey.endsWith("m") ? recommendedSoundingKey.slice(0, -1) : recommendedSoundingKey;
  const rawShift = ((NOTE_TO_PITCH[targetRoot] - NOTE_TO_PITCH[writtenRoot]) % 12 + 12) % 12;
  const signedShift = rawShift > 6 ? rawShift - 12 : rawShift;

  // Sounding chords in the recommended key
  const soundingChords = (parsed.allChords || []).map((c) => {
    const p = parseChord(c);
    return p ? c : "";
  }).filter(Boolean);

  // Suggest easiest open-chord capo position to sound in recommendedSoundingKey
  const capoOptions = suggestCapoPositions(soundingChords, recommendedSoundingKey);
  const bestCapo = capoOptions[0] || { capo: 0, shapesKey: recommendedSoundingKey, score: 85 };

  return {
    current,
    recommendedSoundingKey,
    targetCenterLabel: targetCenter.label,
    signedShift,
    bestCapo,
    alreadyInTopKey: analytics.topKeyCenters.some((tc) => tc.pitch === current.center.pitch)
  };
}

/**
 * Read/write user's pinned ideal vocal singing keys (per-account localStorage).
 * If none have been manually pinned yet, derives top keys from library analytics.
 */
export function getPinnedIdealKeys(songs = []) {
  const saved = loadLocal("ideal_vocal_keys", null);
  if (Array.isArray(saved) && saved.length > 0) {
    return saved.map((k) => normalizeKeyName(k));
  }
  if (songs && songs.length > 0) {
    const analytics = computeLibraryAnalytics(songs);
    const derived = analytics.topKeyCenters.map((c) => c.major).filter(Boolean);
    if (derived.length > 0) return derived;
  }
  return ["A", "G", "E"];
}

export function setPinnedIdealKeys(keysArray) {
  const clean = Array.from(new Set((keysArray || []).map((k) => normalizeKeyName(k)).filter(Boolean)));
  saveLocal("ideal_vocal_keys", clean);
  return clean;
}

/**
 * Compute concrete 1-tap "Transpose to My Ideal Vocal Range" recommendations for any
 * newly imported chord sheet draft or existing song row.
 */
export function getIdealVocalRangeRecommendations(songDraftOrRow, librarySongs = []) {
  const parsed = parse(songDraftOrRow?.chordpro || "");
  const writtenKey = normalizeKeyName(songDraftOrRow?.key || parsed.meta.key || parsed.meta.inferredKey || "G");
  const currentTranspose = Number(songDraftOrRow?.preferred_transpose || 0);
  const currentCapo = Number(songDraftOrRow?.capo ?? parsed.meta.capo ?? 0);

  const currentShapesKey = transposeKey(writtenKey, currentTranspose);
  const tuningValue = songDraftOrRow?.tuning || parsed.meta.tuning;
  const tuningOffset = getTuning(tuningValue).offset;
  const currentSoundingKey = currentCapo > 0 || tuningOffset
    ? soundingKeyWithTuning(currentShapesKey, currentCapo, tuningValue)
    : currentShapesKey;

  const isMinorSong = writtenKey.endsWith("m");
  const currentCenter = getKeyCenter(currentSoundingKey);

  const idealMajorKeys = getPinnedIdealKeys(librarySongs);
  const idealCenters = idealMajorKeys.map((k) => getKeyCenter(k));
  const idealLabels = idealCenters.map((c) => (isMinorSong ? c.minor : c.major));

  const isAlreadyIdeal = idealCenters.some((c) => c.pitch === currentCenter.pitch);

  const writtenRoot = writtenKey.endsWith("m") ? writtenKey.slice(0, -1) : writtenKey;
  const writtenPitch = NOTE_TO_PITCH[writtenRoot] ?? 0;

  const rawChords = parsed.allChords || [];

  // Score and build options for each ideal vocal center, ordered by smallest vocal pitch shift
  const currentRoot = currentSoundingKey.endsWith("m") ? currentSoundingKey.slice(0, -1) : currentSoundingKey;
  const currentSoundingPitch = NOTE_TO_PITCH[currentRoot] ?? 0;

  const optionFor = (targetSoundingKey, idx, centerLabel) => {
    const targetRoot = targetSoundingKey.endsWith("m") ? targetSoundingKey.slice(0, -1) : targetSoundingKey;
    const targetPitch = NOTE_TO_PITCH[targetRoot] ?? 0;

    // Distance from current sounding pitch (for minimal vocal jump)
    const rawFromCurrent = ((targetPitch - currentSoundingPitch) % 12 + 12) % 12;
    const shiftFromCurrent = rawFromCurrent > 6 ? rawFromCurrent - 12 : rawFromCurrent;

    // What to finger so this guitar's tuning lands on the target key
    const frettedKey = tuningOffset ? transposeKey(targetSoundingKey, -tuningOffset) : targetSoundingKey;
    const frettedRoot = frettedKey.endsWith("m") ? frettedKey.slice(0, -1) : frettedKey;
    const frettedPitch = NOTE_TO_PITCH[frettedRoot] ?? targetPitch;

    // Semitone shift from written key to reach the target with Capo 0
    const rawFromWritten = ((frettedPitch - writtenPitch) % 12 + 12) % 12;
    const shiftFromWritten = rawFromWritten > 6 ? rawFromWritten - 12 : rawFromWritten;

    // Score pure transpose (capo 0) open-chord playability
    const pureChords = rawChords.map((c) => transposeChord(c, shiftFromWritten, frettedKey));
    let pureOpen = 0;
    for (const c of pureChords) {
      const p = parseChord(c);
      if (p && (EASY_OPEN_CHORDS.has(c) || EASY_OPEN_CHORDS.has(p.root))) pureOpen++;
    }
    const purePlayability = pureChords.length ? Math.round((pureOpen / pureChords.length) * 100) : 100;

    // Also compute best easy open-chord Capo option (capo 1..5; higher is rarely practical) that
    // still sounds in targetSoundingKey
    const capoCandidates = suggestCapoPositions(pureChords, frettedKey)
      .filter((c) => c.capo >= 1 && c.capo <= 5);
    const bestCapo = capoCandidates[0] || null;

    let capoOption = null;
    if (bestCapo && bestCapo.score > purePlayability + 5) {
      const capoShapes = bestCapo.shapesKey;
      const capoShapesRoot = capoShapes.endsWith("m") ? capoShapes.slice(0, -1) : capoShapes;
      const rawCapoShift = (((NOTE_TO_PITCH[capoShapesRoot] ?? 0) - writtenPitch) % 12 + 12) % 12;
      const capoShiftFromWritten = rawCapoShift > 6 ? rawCapoShift - 12 : rawCapoShift;

      capoOption = {
        kind: "capo",
        targetSoundingKey,
        targetShapesKey: capoShapes,
        capo: bestCapo.capo,
        semitoneShiftFromWritten: capoShiftFromWritten,
        semitoneShiftFromCurrent: shiftFromCurrent,
        playabilityScore: bestCapo.score,
        label: `Sing in ${targetSoundingKey} (${capoShapes} shapes + Capo ${bestCapo.capo})`
      };
    }

    return {
      priority: idx,
      absDist: Math.abs(shiftFromCurrent),
      targetSoundingKey,
      centerLabel,
      pureOption: {
        kind: "transpose",
        targetSoundingKey,
        targetShapesKey: frettedKey,
        capo: 0,
        semitoneShiftFromWritten: shiftFromWritten,
        semitoneShiftFromCurrent: shiftFromCurrent,
        playabilityScore: purePlayability,
        label: shiftFromCurrent === 0
          ? `Sing in ${targetSoundingKey} (No Capo)`
          : `Transpose to ${targetSoundingKey} (${shiftFromCurrent > 0 ? `+${shiftFromCurrent}` : shiftFromCurrent} st)`
      },
      capoOption
    };
  };
  const allOptions = idealCenters.map((center, idx) =>
    optionFor(isMinorSong ? center.minor : center.major, idx, center.label));

  // Order by closest pitch shift first (preferring non-zero shift when song isn't already in that key)
  allOptions.sort((a, b) => a.absDist - b.absDist || a.priority - b.priority);

  // Pick top pure transpose option (if already in one ideal key, also expose the next closest non-current ideal key)
  const nonZeroPure = allOptions.find((o) => o.absDist > 0)?.pureOption || allOptions[0]?.pureOption || null;
  const bestMatch = allOptions[0] || null;
  let pureTranspose = !isAlreadyIdeal ? bestMatch?.pureOption : nonZeroPure;
  let easyCapo = bestMatch?.capoOption || allOptions.find((o) => o.capoOption)?.capoOption || null;
  let alreadyIdeal = isAlreadyIdeal;

  // When the melody's lowest and highest notes are known, they decide: a song whose notes sit
  // inside your range is a good fit in any key, and one that runs past it moves just far enough.
  let range = null;
  const voice = librarySongs.length ? getVocalRange(librarySongs) : getManualVocalRange();
  const sung = voice ? sungRange({ ...songDraftOrRow, key: writtenKey }) : null;
  if (voice && sung) {
    const now = rangeFit(sung, voice);
    const best = bestRangeShift(sung, voice, currentSoundingKey, idealCenters.map((c) => c.pitch));
    range = { voice, sung: now, fits: now.miss === 0, wide: false, after: null };
    if (range.fits) {
      alreadyIdeal = true;
    } else if (best.shift !== 0 && best.fit.miss < now.miss) {
      const option = optionFor(transposeKey(currentSoundingKey, best.shift), 0, "");
      pureTranspose = { ...option.pureOption, label: `Rewrite in ${option.pureOption.targetShapesKey}` };
      easyCapo = option.capoOption;
      alreadyIdeal = false;
      range.after = best.fit;
    } else {
      // No key brings every note inside: the melody spans more than your range.
      range.wide = true;
      pureTranspose = null;
      easyCapo = null;
      alreadyIdeal = false;
    }
  }

  // How a song feels to sing beats any estimate: one you marked too high, too low, or 1–2★
  // always gets a key to try, moving the way you said (down when it's too high).
  let felt = null;
  const comfort = songDraftOrRow?.vocal_comfort || "";
  const rating = Number(songDraftOrRow?.vocal_rating || 0);
  if (comfort === "high_stretch" || comfort === "too_low" || (rating > 0 && rating <= 2)) {
    let dir = comfort === "high_stretch" ? -1 : comfort === "too_low" ? 1 : 0;
    if (!dir && range) dir = (range.sung.low + range.sung.high) / 2 > (range.voice.low + range.voice.high) / 2 ? -1 : 1;
    const planned = !alreadyIdeal && pureTranspose ? pureTranspose.semitoneShiftFromCurrent : 0;
    if (!planned || (dir && Math.sign(planned) !== dir)) {
      if (!dir) dir = -1; // no other clue: lower is the usual relief
      let shift = 0;
      // With the notes known: the move that way (a whole step or more) that puts them best inside
      // your range.
      if (range) {
        const way = [2, 3, 4, 5, 6].map((k) => dir * k);
        shift = bestRangeShift(range.sung, range.voice, currentSoundingKey, idealCenters.map((c) => c.pitch), way).shift;
      }
      // Otherwise the nearest of your best keys that way, up to 5 half steps; else a whole step.
      for (let k = 1; k <= 5 && !shift; k++) {
        const pitch = getKeyCenter(transposeKey(currentSoundingKey, dir * k)).pitch;
        if (idealCenters.some((c) => c.pitch === pitch)) shift = dir * k;
      }
      if (!shift) shift = 2 * dir;
      const option = optionFor(transposeKey(currentSoundingKey, shift), 0, "");
      pureTranspose = { ...option.pureOption, label: `Rewrite in ${option.pureOption.targetShapesKey}` };
      easyCapo = option.capoOption;
      if (range) {
        range.wide = false;
        range.after = rangeFit({ low: range.sung.low + shift, high: range.sung.high + shift }, range.voice);
      }
    }
    alreadyIdeal = false;
    felt = {
      direction: Math.sign(pureTranspose?.semitoneShiftFromCurrent || dir || -1),
      label: comfort === "high_stretch" ? "too high" : comfort === "too_low" ? "too low" : `${rating}★`
    };
  }

  return {
    writtenKey,
    currentShapesKey,
    currentCapo,
    currentSoundingKey,
    isAlreadyIdeal: alreadyIdeal,
    idealMajorKeys,
    idealLabels,
    pureTranspose,
    easyCapo,
    allOptions,
    range,
    felt
  };
}

/**
 * Render the Vocal & Key Analytics Dashboard HTML.
 */
export function renderAnalyticsDashboardHTML(songs = []) {
  const pinnedKeys = getPinnedIdealKeys(songs);
  const pinnedHtml = `
    <section class="analytics-panel ideal-keys-config-panel">
      <h4 class="analytics-panel-title">My best keys</h4>
      <p class="analytics-panel-desc">
        Tap the keys you sing best in. They’re only used for a new song before its melody range is known.
      </p>
      <div class="ideal-keys-chips" id="ideal-keys-chips-group">
        ${ALL_MAJOR_KEYS.map((k) => {
          const active = pinnedKeys.includes(k);
          return `<button type="button" class="filter-chip ${active ? "is-active" : ""}" data-toggle-ideal-key="${esc(k)}">${esc(k)}${active ? " ✓" : ""}</button>`;
        }).join("")}
      </div>
    </section>
  `;

  if (!songs.length) {
    return `${pinnedHtml}<p class="empty-hint">Save a few songs and rate how they feel to sing to see your best keys.</p>`;
  }

  const data = computeLibraryAnalytics(songs);
  const best = data.bestKeyCenter;
  const second = data.topKeyCenters[1];

  const maxCount = Math.max(1, ...data.activeProfiles.map((p) => p.songCount));

  // Bad fit: songs you rated hard to sing and songs whose melody runs past your range, each with
  // the simplest fix. The range a song needs matters, not its key, so key alone never puts a song
  // here.
  const voice = getVocalRange(songs);
  const badFits = songs.map((song) => {
    const keys = getSongEffectiveKeys(song);
    const rec = getIdealVocalRangeRecommendations(song, songs);
    const comfort = song.vocal_comfort || "";
    const rating = song.vocal_rating;
    const ratedHard = comfort === "too_low" || comfort === "high_stretch" || (rating != null && rating <= 2);
    const range = rec?.range;
    const outside = !!range && !range.fits;
    if (!ratedHard && !outside) return null;
    let why = comfort === "high_stretch" ? "Too high" : comfort === "too_low" ? "Too low"
      : rating != null && rating <= 2 ? `Rated ${rating}★` : "Outside your range";
    if (!ratedHard && range) why = range.sung.over ? (range.sung.inFalsetto ? "Falsetto" : "Too high") : "Too low";
    const sings = range ? `Sings ${rangeText(range.sung)}` : `Sounds in ${keys.soundingKey}`;
    let fix;
    if (rec?.pureTranspose && (outside || rec.felt)) {
      fix = `Rewrite in ${rec.pureTranspose.targetShapesKey}` +
        (range?.after ? ` to sing ${rangeText(range.after)}` : "") +
        (rec.easyCapo ? `, or ${rec.easyCapo.label}` : "");
    } else if (range && range.wide) {
      fix = `in any key the melody is wider than your ${rangeText(range.voice)} range`;
    } else if (outside && rec.pureTranspose) {
      fix = `Rewrite in ${rec.pureTranspose.targetShapesKey}` +
        (range?.after ? ` to sing ${rangeText(range.after)}` : "") +
        (rec.easyCapo ? `, or ${rec.easyCapo.label}` : "");
    } else {
      const step = comfort === "too_low" ? 2 : -2;
      fix = `Try ${transposeKey(keys.shapesKey, step)} (${step > 0 ? "up" : "down"} a whole step)`;
    }
    // Already written in that key with a capo on: the fix is taking the capo off.
    const capoOnly = rec?.pureTranspose && rec.pureTranspose.semitoneShiftFromWritten === 0 && Number(song.preferred_transpose || 0) === 0;
    if (capoOnly && rec.pureTranspose) fix = fix.replace(`Rewrite in ${rec.pureTranspose.targetShapesKey}`, `Take the capo off (${rec.pureTranspose.targetShapesKey})`);
    const target = rec?.pureTranspose && !rec.isAlreadyIdeal
      ? (capoOnly ? "No capo" : `Rewrite in ${rec.pureTranspose.targetShapesKey}`)
      : null;
    return { song, sings, why, fix, ratedHard, target };
  }).filter(Boolean).sort((a, b) => (b.ratedHard - a.ratedHard) || a.song.title.localeCompare(b.song.title));
  const missingMelody = songsMissingMelody(songs).length;
  const unchecked = voice ? songs.filter((x) => !sungRange(x)).length : songs.length;
  const withMelody = songs.filter((x) => sungRange(x)).length;
  const manual = getManualVocalRange();
  const noteOptions = (selected, blank) => `<option value="">${blank}</option>` +
    Array.from({ length: NOTE_HIGHEST - NOTE_LOWEST + 1 }, (_, i) => NOTE_LOWEST + i)
      .map((m) => `<option value="${m}"${m === selected ? " selected" : ""}>${midiToNote(m)}</option>`).join("");
  const rangePanel = `
      <section class="analytics-panel vocal-range-panel">
        <h4 class="analytics-panel-title">Your vocal range</h4>
        ${voice ? `
          <p class="vocal-range-big"><strong>${esc(rangeText(voice))}</strong>
            <span class="stat-sub">${voice.from === "you" ? "Set by you" : `From ${voice.count} songs you sing well`}${voice.falsettoHigh ? ` • Falsetto ${esc(midiToNote(voice.high + 1))}–${esc(midiToNote(voice.falsettoHigh))}` : ""}</span></p>
          ${voice.from === "songs" && voice.stretchHigh != null ? `<p class="analytics-panel-desc">Songs reaching ${esc(midiToNote(voice.stretchHigh))} felt like a stretch.</p>` : ""}
          ${voice.from === "songs" && voice.stretchLow != null ? `<p class="analytics-panel-desc">Songs going down to ${esc(midiToNote(voice.stretchLow))} felt too low.</p>` : ""}
        ` : `<p class="analytics-panel-desc">Rate two or more songs Sweet spot (or 4★) that have a melody range, or set your range here.</p>`}
        <div class="vocal-range-pickers">
          <label>Lowest <select id="vocal-range-low" class="input-select small-select" aria-label="Your lowest comfortable note">${noteOptions(manual?.low, "Auto")}</select></label>
          <label>Highest <select id="vocal-range-high" class="input-select small-select" aria-label="Your highest comfortable note">${noteOptions(manual?.high, "Auto")}</select></label>
          <label>Falsetto top <select id="vocal-range-falsetto" class="input-select small-select" aria-label="Highest comfortable falsetto note">${noteOptions(manual?.falsettoHigh, "Off")}</select></label>
        </div>
        <p class="analytics-panel-desc">Songs are matched to your standard range; falsetto is shown for reference. Melody known for ${withMelody} of ${songs.length} songs.</p>
        <div class="more-inline">
          <button type="button" class="ghost-btn small-btn" id="apply-john-mayer-range-btn">Use John Mayer range (${esc(rangeText(JOHN_MAYER_RANGE))}, falsetto ${esc(midiToNote(JOHN_MAYER_RANGE.falsettoHigh))})</button>
          ${missingMelody ? `<button type="button" class="ghost-btn small-btn" id="find-melody-ranges-btn">Look up ${missingMelody} melody range${missingMelody === 1 ? "" : "s"} with AI</button>` : ""}
        </div>
      </section>
  `;
  const unratedCount = songs.filter((s) => s.vocal_rating == null && !s.vocal_comfort).length;

  return `
    <div class="analytics-grid">
      ${unratedCount ? `<p class="keys-unrated-hint">${unratedCount} of ${songs.length} songs aren’t rated yet. Open a song and tap <strong>More</strong> to rate how it feels to sing.</p>` : ""}
      ${rangePanel}
      <section class="analytics-panel">
        <h4 class="analytics-panel-title">Bad fit${badFits.length ? ` (${badFits.length})` : ""}</h4>
        ${badFits.length ? `
          <p class="analytics-panel-desc">Songs you rated hard to sing, and songs whose melody runs past your range. Tap the button to change the song to that key (you can undo it), or tap a title to open it.</p>
          <div class="best-fit-songs-list">
            ${badFits.map(({ song, sings, why, fix, target }) => `
              <div class="fit-song-row is-bad-fit-row">
                <div class="fit-song-main" data-open-song="${esc(song.id)}" role="button" tabindex="0" title="Open ${esc(song.title)}">
                  <strong class="fit-song-title">${esc(song.title)}</strong>
                  <span class="fit-song-sub">${esc(sings)} • ${esc(fix)}</span>
                </div>
                <div class="fit-song-badges">
                  <span class="fit-badge is-bad-fit">${esc(why)}</span>
                  ${target ? `<button type="button" class="solid-btn small-btn" data-rewrite-song="${esc(song.id)}">${esc(target)}</button>` : ""}
                </div>
              </div>
            `).join("")}
          </div>
        ` : `<p class="analytics-panel-desc">${voice ? "Every song with a known melody fits your range." : "No songs rated hard to sing."}</p>`}
        ${unchecked ? `<p class="analytics-panel-desc">${voice ? `${unchecked} song${unchecked === 1 ? "" : "s"} can’t be checked yet: no melody range.` : "Set your range above to check every song against it."}</p>` : ""}
      </section>
      <div class="analytics-hero-cards">
        <div class="stat-card is-highlight">
          <span class="stat-eyebrow">Your money key</span>
          <strong class="stat-big-val">${esc(best ? best.label : "A / F#m")}</strong>
          <span class="stat-sub">
            ${best ? `${best.songCount} song${best.songCount === 1 ? "" : "s"} • ${best.avgRating ? `${best.avgRating}★ avg vocal fit` : "Top tonal center"}` : ""}
          </span>
        </div>
        <div class="stat-card">
          <span class="stat-eyebrow">Next best</span>
          <strong class="stat-big-val">${esc(second ? second.label : "G / Em")}</strong>
          <span class="stat-sub">
            ${second ? `${second.songCount} song${second.songCount === 1 ? "" : "s"} (${second.sweetSpotCount} in sweet spot)` : "Rate more songs to refine"}
          </span>
        </div>
      </div>

      <section class="analytics-panel">
        <h4 class="analytics-panel-title">Keys you sing in</h4>
        <p class="analytics-panel-desc">
          Counts each song in the key it actually sounds in, with capo.
        </p>
        <div class="key-bars-list">
          ${data.activeProfiles.map((p) => {
            const pct = Math.round((p.songCount / maxCount) * 100);
            const badge = p.sweetSpotCount > 0
              ? `<span class="key-fit-tag is-sweet">★ ${p.sweetSpotCount} Sweet Spot</span>`
              : (p.highStretchCount > 0 ? `<span class="key-fit-tag is-stretch">High Stretch</span>` : "");
            return `
              <div class="key-bar-row">
                <div class="key-bar-label">
                  <strong>${esc(p.label)}</strong>
                  <span class="key-bar-count">${p.songCount} song${p.songCount === 1 ? "" : "s"}${p.ratedCount ? ` • ${p.avgRating}★` : ""}</span>
                </div>
                <div class="key-bar-track">
                  <div class="key-bar-fill" style="width: ${Math.max(10, pct)}%"></div>
                </div>
                <div class="key-bar-meta">${badge}</div>
              </div>
            `;
          }).join("")}
        </div>
      </section>

      <section class="analytics-panel">
        <h4 class="analytics-panel-title">Songs that fit you best</h4>
        <div class="best-fit-songs-list">
          ${data.rankedSongs.slice(0, 8).map((item) => {
            const { song, keys, fitScore, comfort, rating } = item;
            const comfortLabel =
              comfort === "sweet_spot" ? "Sweet Spot" :
              comfort === "high_stretch" ? "High Stretch" :
              comfort === "too_low" ? "Low Range" : "Unrated";
            return `
              <div class="fit-song-row" data-open-song="${esc(song.id)}">
                <div class="fit-song-main">
                  <strong class="fit-song-title">${esc(song.title)}</strong>
                  <span class="fit-song-sub">${esc(song.artist || "")} • Sing in <strong>${esc(keys.soundingKey)}</strong> (${esc(keys.shapesKey)} shapes${keys.capo ? `, Capo ${keys.capo}` : ""})</span>
                </div>
                <div class="fit-song-badges">
                  <span class="fit-badge">${esc(comfortLabel)}${rating ? ` ${rating}★` : ""}</span>
                  <span class="fit-score-pill">${fitScore}% Fit</span>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </section>

      ${pinnedHtml}
    </div>
  `;
}
