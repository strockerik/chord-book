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
  soundingKeyFromShapes,
  capoShapesKey,
  getKeyCenter,
  suggestCapoPositions,
  parseChord
} from "./chords.js";
import { parse } from "./chordpro.js";

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
  // Concert sounding key = shapesKey + capo semitones
  const soundingKey = soundingKeyFromShapes(shapesKey, capo);
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
  const currentSoundingKey = currentCapo > 0
    ? soundingKeyFromShapes(currentShapesKey, currentCapo)
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

  const allOptions = idealCenters.map((center, idx) => {
    const targetSoundingKey = isMinorSong ? center.minor : center.major;
    const targetRoot = targetSoundingKey.endsWith("m") ? targetSoundingKey.slice(0, -1) : targetSoundingKey;
    const targetPitch = NOTE_TO_PITCH[targetRoot] ?? 0;

    // Distance from current sounding pitch (for minimal vocal jump)
    const rawFromCurrent = ((targetPitch - currentSoundingPitch) % 12 + 12) % 12;
    const shiftFromCurrent = rawFromCurrent > 6 ? rawFromCurrent - 12 : rawFromCurrent;

    // Semitone shift from written key to reach targetSoundingKey with Capo 0
    const rawFromWritten = ((targetPitch - writtenPitch) % 12 + 12) % 12;
    const shiftFromWritten = rawFromWritten > 6 ? rawFromWritten - 12 : rawFromWritten;

    // Score pure transpose (capo 0) open-chord playability
    const pureChords = rawChords.map((c) => transposeChord(c, shiftFromWritten, targetSoundingKey));
    let pureOpen = 0;
    for (const c of pureChords) {
      const p = parseChord(c);
      if (p && (EASY_OPEN_CHORDS.has(c) || EASY_OPEN_CHORDS.has(p.root))) pureOpen++;
    }
    const purePlayability = pureChords.length ? Math.round((pureOpen / pureChords.length) * 100) : 100;

    // Also compute best easy open-chord Capo option (capo 1..6) that still sounds in targetSoundingKey
    const capoCandidates = suggestCapoPositions(pureChords, targetSoundingKey)
      .filter((c) => c.capo >= 1 && c.capo <= 6);
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
      centerLabel: center.label,
      pureOption: {
        kind: "transpose",
        targetSoundingKey,
        targetShapesKey: targetSoundingKey,
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
  });

  // Order by closest pitch shift first (preferring non-zero shift when song isn't already in that key)
  allOptions.sort((a, b) => a.absDist - b.absDist || a.priority - b.priority);

  // Pick top pure transpose option (if already in one ideal key, also expose the next closest non-current ideal key)
  const nonZeroPure = allOptions.find((o) => o.absDist > 0)?.pureOption || allOptions[0]?.pureOption || null;
  const bestMatch = allOptions[0] || null;
  const pureTranspose = !isAlreadyIdeal ? bestMatch?.pureOption : nonZeroPure;
  const easyCapo = bestMatch?.capoOption || allOptions.find((o) => o.capoOption)?.capoOption || null;

  return {
    writtenKey,
    currentShapesKey,
    currentCapo,
    currentSoundingKey,
    isAlreadyIdeal,
    idealMajorKeys,
    idealLabels,
    pureTranspose,
    easyCapo,
    allOptions
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
        Tap the keys you sing best in. Songs outside them will suggest a better key.
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
  const unratedCount = songs.filter((s) => s.vocal_rating == null && !s.vocal_comfort).length;

  return `
    <div class="analytics-grid">
      ${pinnedHtml}
      ${unratedCount ? `<p class="keys-unrated-hint">${unratedCount} of ${songs.length} songs aren’t rated yet. Open a song and tap <strong>More</strong> to rate how it feels to sing.</p>` : ""}
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
    </div>
  `;
}
