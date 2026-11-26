// Chord placement & Track A checks for supabase/functions/import-sheet/ modules (made-up songs only).
// Run: deno run --allow-read testing-skills/import_layout_test.ts
// Imports the real TypeScript modules directly (nothing paid runs).
import { isValidChordToken } from "../supabase/functions/import-sheet/chord_net.ts";
import {
  layoutFromSourceText,
  realignToLayout,
  applyPlacementNotes,
  restoreChangedChoruses,
  chordColumns
} from "../supabase/functions/import-sheet/layout.ts";
import { pageDataForImport, parseUgDirect } from "../supabase/functions/import-sheet/ug.ts";
import { chordsOf, extractColumnLines } from "../supabase/functions/import-sheet/pdf.ts";

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const ok = (name: string, cond: boolean, detail: unknown = "") =>
  results.push({ name, pass: !!cond, detail: String(detail) });

// 1. A source line with the same word four times, each with its own chord.
const source = [
  "        D             A             G             D",
  "Morning road, morning road, morning road, morning road",
  "D                 A              G  D/F# Em7 D",
  "Walking down to the river, morning road",
].join("\n");
const layout = layoutFromSourceText(source, isValidChordToken);
ok("Source layout puts each chord on its own repeated word",
   layout[0] === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", layout[0]);

// 2. Native UG [ch] tags preserve exact visual columns.
const ugTagged = [
  "[tab]        [ch]D[/ch]             [ch]A[/ch]             [ch]G[/ch]             [ch]D[/ch]",
  "Morning road, morning road, morning road, morning road[/tab]"
].join("\n");
const ugLayout = layoutFromSourceText(ugTagged, isValidChordToken);
ok("UG [ch] tags align chords to exact visual columns on repeated words",
   ugLayout[0] === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", ugLayout[0]);
ok("chordColumns rejects mixed lyric + [ch] lines",
   chordColumns("Hello [ch]G[/ch] world", isValidChordToken) === null);

// 3. Unified PDF chordsOf accepts 6/9, Δ, -7, mmaj7.
const mkGlyphs = (s: string) => [...s].map((ch, idx) => ({ ch, x: idx * 7, w: 7 }));
const pdfChords = chordsOf(mkGlyphs("C6/9   GΔ   D-7   Emmaj7"), isValidChordToken);
ok("PDF chordsOf uses unified isValidChordToken (6/9, Δ, -7, mmaj7)",
   !!pdfChords && pdfChords.length === 4 && pdfChords[0].chord === "C6/9" && pdfChords[1].chord === "GΔ",
   JSON.stringify(pdfChords));

// 4. PDF extractColumnLines preserves section headers & chord-only lines.
const col = extractColumnLines([
  { str: "Intro", x: 40, y: 100, width: 35, size: 11, mono: false },
  { str: "G   D   Em   C", x: 40, y: 118, width: 110, size: 11, mono: true },
  { str: "Verse 1", x: 40, y: 150, width: 45, size: 11, mono: false },
  { str: "G          C", x: 40, y: 168, width: 90, size: 11, mono: true },
  { str: "Walking down the road", x: 40, y: 182, width: 140, size: 11, mono: true },
], isValidChordToken);
ok("PDF extractColumnLines keeps section headers and chord-only lines",
   col.sectionHeaderCount === 2 && col.structuredLines.includes("[Intro]") && col.structuredLines.includes("[G]   [D]   [Em]   [C]"),
   JSON.stringify(col));

// 5. The AI's notes name the same word four times; the line it wrote is already right.
const right = { text: "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", tab: false,
  placement: "D over road, A over road, G over road, D over road" };
applyPlacementNotes([{ lines: [right] }]);
ok("A line that already matches its notes is kept", right.text === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", right.text);

// 6. The line it wrote has them on the wrong words; the notes put one on each "road" in turn.
const stacked = { text: "[D]Morning [A]road, [G]morning road, [D]morning road, morning road", tab: false,
  placement: "D over road, A over road, G over road, D over road" };
applyPlacementNotes([{ lines: [stacked] }]);
ok("Notes naming the same word again move to its next appearance",
   stacked.text === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", stacked.text);

// 7. Quick chords on a word that appears once stay together on it.
const quick = { text: "Walking [D]down to the [A]river, morning [G]road [D/F#] [Em7] [D]", tab: false,
  placement: "D over down, A over river, G over road, D/F# over road, Em7 over road, D over road" };
applyPlacementNotes([{ lines: [quick] }]);
ok("Several chords on a word that appears once stay together", /\[G\]\s*\[D\/F#\]\s*\[Em7\]\s*\[D\]road|\[G\]road/.test(quick.text), quick.text);

// 8. The AI repeated the end of a line; the source line wins.
const sections = [{ type: "verse", lines: [
  { text: "[D]Walking [A]down to the [G]ri[D/F#]ver, [Em7]morning [D]road, morning road, morning road", tab: false },
  { text: "Morning [D][A][G][D]road, morning road, morning road, morning road", tab: false }
] }];
realignToLayout(sections, layout, isValidChordToken);
ok("A line with its ending repeated by the AI goes back to the source line",
   sections[0].lines[0].text === layout[1], sections[0].lines[0].text);
ok("A stacked line goes back to the source layout", sections[0].lines[1].text === layout[0], sections[0].lines[1].text);

// 9. A chorus the AI marked "same again" whose words differ in the source comes back in full.
const named = [
  "[Verse 1]", "D            A", "Out along the river", "",
  "[Chorus]", "G            D", "Carry me home tonight", "A               D", "Over the hill and far", "",
  "[Verse 2]", "D            A", "Back along the river", "",
  "[Chorus]", "G            D", "Carry me home tonight", "A                D", "Under the stars we are", "",
  "[Chorus]", "G            D", "Carry me home tonight", "A               D", "Over the hill and far",
].join("\n");
const v2 = (t: string) => ({ text: t, tab: false });
const sheet = [
  { type: "verse", label: "Verse 1", lines: [v2("[D]Out along the [A]river")] },
  { type: "chorus", label: "Chorus", lines: [v2("[G]Carry me home to[D]night"), v2("[A]Over the hill and [D]far")] },
  { type: "verse", label: "Verse 2", lines: [v2("[D]Back along the [A]river")] },
  { type: "chorus_repeat", label: "Chorus", lines: [] },
  { type: "chorus_repeat", label: "Chorus", lines: [] },
];
const back = restoreChangedChoruses(sheet, named, isValidChordToken);
ok("A repeat whose words differ in the source is written out from the source",
   back === 1 && sheet[3].type === "chorus" && sheet[3].lines.map((l: { text: string }) => l.text).join(" / ").includes("Under the stars"),
   JSON.stringify(sheet[3]));
ok("A repeat that matches the source stays a repeat", sheet[4].type === "chorus_repeat", sheet[4].type);
const unnamed = [{ type: "chorus", label: "Chorus", lines: [v2("[G]Carry me home to[D]night")] }, { type: "chorus_repeat", label: "Chorus", lines: [] }];
ok("Without section names in the source nothing changes", restoreChangedChoruses(unnamed, named.replace(/\[[^\]]+\]/g, ""), isValidChordToken) === 0);

// 10. Track A UG direct parse handles [tab] wrappers properly and detects real guitar tab.
const ugHtml = `<div class="js-store" data-content="${JSON.stringify({
  store: { page: { data: {
    tab: { song_name: "MORNING ROAD", artist_name: "River Band" },
    tab_view: { meta: { capo: 2, tonality: "G" }, wiki_tab: { content: [
      "[Intro]", "[tab][ch]G[/ch]  [ch]D[/ch]  [ch]Em[/ch]  [ch]C[/ch][/tab]",
      "[Verse 1]", ugTagged,
      "[Chorus]", "[tab][ch]G[/ch]          [ch]D[/ch]\nCarry me home tonight[/tab]",
      "[tab][ch]A[/ch]          [ch]D[/ch]\nOver the hill and far[/tab]",
      "[Solo]", "e|---3---5---7---|", "B|---3---5---8---|"
    ].join("\n") } }
  } } }
}).replace(/"/g, "&quot;")}"></div>`;
const ugPage = pageDataForImport(ugHtml);
const ugRes = parseUgDirect(ugPage.ug!);
ok("Track A parseUgDirect succeeds and keeps [tab] lines as lyrics/chords",
   ugRes.confidence === "high" && ugRes.sheet.title === "Morning Road" && ugRes.sheet.sections.filter((s: { type: string }) => s.type === "tab").length === 1,
   JSON.stringify({ conf: ugRes.confidence, reason: ugRes.reason }));

// 11. A page's preamble, chord shapes, and playing cues aren't sung lines; unreadable chord
// lines send the song to the AI.
const ugPageOf = (lines: string[]) => pageDataForImport(`<div class="js-store" data-content="${JSON.stringify({
  store: { page: { data: {
    tab: { song_name: "Morning Road", artist_name: "River Band" },
    tab_view: { meta: { tonality: "G" }, wiki_tab: { content: lines.join("\n") } }
  } } }
}).replace(/"/g, "&quot;")}"></div>`).ug!;
const body = [
  "[Verse 1]",
  "[tab]        [ch]G[/ch]            [ch]D[/ch]\nWalking down the morning road[/tab]",
  "[tab][ch]Em[/ch]                [ch]C[/ch]\nCarry me home along the river[/tab]",
  "[Chorus]",
  "[tab][ch]G[/ch]          [ch]D[/ch]\nCarry me home tonight[/tab]",
  "[tab][ch]C[/ch]                 [ch]G[/ch]\nOver the hill and far away[/tab]"
];
const withPreamble = parseUgDirect(ugPageOf([
  "River Band", "Morning Road", "Some Album", "2002", "Chords:", "[ch]Em[/ch] -   022000",
  "", "[Intro]", "[tab][ch]G[/ch] [ch]D[/ch]    (x4)", "Palm muted[/tab]", "", ...body
]));
const firstSection = withPreamble.sheet.sections[0];
ok("Track A skips the page preamble before the first section name",
   withPreamble.confidence === "high" && firstSection.type === "intro",
   JSON.stringify({ conf: withPreamble.confidence, reason: withPreamble.reason, first: firstSection }));
ok("A playing cue under chords becomes the section note, and the repeat count stays on the chords",
   firstSection.sidebar_note === "Palm muted" && firstSection.lines.length === 1 && firstSection.lines[0].text === "[G]   [D] (x4)",
   JSON.stringify(firstSection));
ok("A chord-shape code like x24432 is not read as a repeat count",
   chordColumns("[ch]Bm[/ch] -   x24432", isValidChordToken) === null);
const oddChord = parseUgDirect(ugPageOf([...body, "[Bridge]", "[tab][ch]G6add13sus[/ch]      [ch]D[/ch]\nHold me close tonight[/tab]"]));
ok("A [ch] line with a chord it can't read sends the song to the AI", oddChord.confidence === "low", JSON.stringify({ conf: oddChord.confidence, reason: oddChord.reason }));

for (const r of results) console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}` + (r.pass ? "" : ` — ${r.detail}`));
const failed = results.filter((r) => !r.pass).length;
console.log(`\nimport_layout_test: ${results.length - failed}/${results.length} passed.`);
Deno.exit(failed ? 1 : 0);
