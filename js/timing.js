// Song length estimate for Play mode (js/timing.js)
// Auto-scroll runs at one steady speed: the screen distance divided by this length.
// It counts bars from the sheet (lyrics, chords, intros, interludes, and repeats) and needs no network.

const TYPICAL_BPM = { compound: 60, triple: 92, common: 76 };

function readMeter(timeSignature) {
  const match = String(timeSignature || "").match(/(\d+)\s*\/\s*(\d+)/);
  const top = match ? Number(match[1]) : 4;
  const bottom = match ? Number(match[2]) : 4;
  const compound = bottom === 8 && top % 3 === 0;
  return {
    top,
    compound,
    // Compound meters are counted in dotted-quarter pulses: 6/8 has two.
    pulsesPerBar: compound ? top / 3 : (bottom === 8 ? top / 2 : top),
    kind: compound ? "compound" : (top === 3 ? "triple" : "common")
  };
}

function countSyllables(text) {
  const words = String(text).toLowerCase().match(/[a-z'’]+/g) || [];
  let total = 0;
  for (const word of words) {
    const groups = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").match(/[aeiouy]+/g);
    total += Math.max(1, groups ? groups.length : 1);
  }
  return total;
}

// Music moves in two-bar phrases, so a line rounds up to an even number of bars.
function toPhrase(bars) {
  return bars <= 1 ? 1 : (bars % 2 ? bars + 1 : bars);
}

function lineBars(line, meter) {
  if (line.tab !== undefined) {
    const rows = String(line.tab).split("\n").length;
    return Math.ceil(rows / 6) * 4;
  }
  if (!line.segments) return 0;
  const chords = line.segments.filter((segment) => segment.chord).length;
  const lyric = line.segments.map((segment) => segment.lyric || "").join("");
  if (!/[A-Za-z]/.test(lyric)) return toPhrase(chords);

  const countsPerSyllable = meter.top % 3 === 0 ? 1 : 0.75;
  const barsFromWords = Math.ceil((countSyllables(lyric) * countsPerSyllable) / meter.top);
  const barsFromChords = Math.ceil(chords / (meter.top === 3 ? 1 : 2));
  return toPhrase(Math.max(2, barsFromWords, barsFromChords));
}

function sectionBars(section, meter) {
  return (section?.lines || []).reduce((sum, line) => sum + lineBars(line, meter), 0);
}

function repeatCount(text) {
  const match = String(text || "").match(/(?:\b|\()(\d)\s*x\b|\bx\s*(\d)\b/i);
  return match ? Number(match[1] || match[2]) : 1;
}

function findFormSection(token, sections) {
  const name = token.replace(/\(.*?\)/g, "").trim().toLowerCase();
  const byType = (type) => sections.find((section) => section.type === type);
  const byLabel = (pattern) => sections.find((section) => pattern.test(section.label || ""));

  const verse = name.match(/^v(?:erse)?\s*(\d+)/);
  if (verse) return byLabel(new RegExp(`^verse\\s*${verse[1]}\\b`, "i")) || sections.filter((s) => s.type === "verse")[verse[1] - 1];
  if (/^(ch|chorus|refrain)\b/.test(name)) {
    const key = name.match(/\bin\s+([a-g][#b]?m?)/);
    return (key && byLabel(new RegExp(`\\bin\\s+${key[1].replace("#", "\\#")}\\b`, "i"))) || byType("chorus");
  }
  if (/^turn/.test(name)) return byLabel(/turn/i) || byType("instrumental");
  if (/^(inter|inst)/.test(name)) return byLabel(/interlude|instrumental/i) || byType("instrumental");
  if (/^intro/.test(name)) return byType("intro");
  if (/^out/.test(name)) return byType("outro");
  if (/^bridge/.test(name)) return byType("bridge");
  if (/^tag/.test(name)) return byLabel(/^tag/i) || byType("tag");
  return null;
}

// Reads "Form: Intro • V1 • CH • V2 • CH (2x)" and totals what is actually played.
function barsFromForm(noteText, sections, meter) {
  const form = String(noteText || "").match(/form:\s*(.+)/i);
  if (!form) return null;
  const tokens = form[1].split(/\.\s/)[0].split(/\s*[•–—]\s*|\s+-\s+/).map((t) => t.trim()).filter(Boolean);
  let bars = 0;
  let matched = 0;
  for (const token of tokens) {
    const section = findFormSection(token, sections);
    if (!section) continue;
    matched++;
    bars += sectionBars(section, meter) * repeatCount(token);
  }
  return tokens.length && matched >= tokens.length / 2 ? bars : null;
}

function barsFromSheet(parsed, rendered, meter) {
  const sections = parsed.sections || [];
  const chorus = sections.find((section) => section.type === "chorus");
  const items = rendered || sections.map((sec, origIdx) => ({ sec, origIdx }));
  let bars = 0;
  for (const item of items) {
    const original = sections[item.origIdx] || item.sec;
    bars += sectionBars(original, meter) * repeatCount(original.label);
    if (item.showChorusReminder && chorus) bars += sectionBars(chorus, meter);
  }
  return bars;
}

/**
 * Estimates how long a song takes to play from its sheet.
 * `renderedSections` is the render model's list, which marks where a printed chorus repeats.
 */
export function estimateSongTiming(song, parsed, renderedSections = null) {
  const meter = readMeter(song?.time_signature || parsed?.meta?.time);
  const statedBpm = Number(song?.tempo || parsed?.meta?.tempo || 0);
  const bpm = statedBpm >= 20 && statedBpm <= 300 ? statedBpm : TYPICAL_BPM[meter.kind];
  const noteText = `${song?.notes || ""}\n${parsed?.meta?.note || ""}`;
  const bars = barsFromForm(noteText, parsed?.sections || [], meter) ?? barsFromSheet(parsed || {}, renderedSections, meter);
  const statedSeconds = Number(song?.duration_sec || 0);
  const seconds = statedSeconds > 0
    ? statedSeconds
    : Math.max(30, Math.min(1500, bars * meter.pulsesPerBar * (60 / bpm)));
  return { seconds, bars, bpm, bpmIsTypical: statedBpm < 20 || statedBpm > 300 };
}

export function formatMinutes(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
