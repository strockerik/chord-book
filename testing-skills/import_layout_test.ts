// Chord placement checks for supabase/functions/import-sheet/index.ts (made-up songs only).
// Run: deno run --allow-read --allow-write testing-skills/import_layout_test.ts
// Pulls the LAYOUT block and applyPlacementNotes out of the function so nothing paid runs.
const root = new URL("..", import.meta.url);
const src = Deno.readTextFileSync(new URL("supabase/functions/import-sheet/index.ts", root));
const slice = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));
const fn = (name: string) => {
  const start = src.indexOf(`function ${name}(`);
  const head = src.lastIndexOf("\n", src.lastIndexOf("\n", start) - 1);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
};
const code = slice("// ==== CHORD NET ====", "// ==== END CHORD NET ====") +
  slice("// ==== LAYOUT ====", "// ==== END LAYOUT ====") + fn("applyPlacementNotes") +
  "\nexport { layoutFromSourceText, realignToLayout, applyPlacementNotes, isValidChordToken };\n";
const tmp = Deno.makeTempFileSync({ suffix: ".ts" });
Deno.writeTextFileSync(tmp, code);
const m = await import("file://" + tmp);

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const ok = (name: string, cond: boolean, detail: unknown = "") => results.push({ name, pass: !!cond, detail: String(detail) });

// A source line with the same word four times, each with its own chord.
const source = [
  "        D             A             G             D",
  "Morning road, morning road, morning road, morning road",
  "D                 A              G  D/F# Em7 D",
  "Walking down to the river, morning road",
].join("\n");
const layout = m.layoutFromSourceText(source, m.isValidChordToken);
ok("Source layout puts each chord on its own repeated word",
   layout[0] === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", layout[0]);

// The AI's notes name the same word four times; the line it wrote is already right.
const right = { text: "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", tab: false,
  placement: "D over road, A over road, G over road, D over road" };
m.applyPlacementNotes([{ lines: [right] }]);
ok("A line that already matches its notes is kept", right.text === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", right.text);

// The line it wrote has them on the wrong words; the notes put one on each "road" in turn.
const stacked = { text: "[D]Morning [A]road, [G]morning road, [D]morning road, morning road", tab: false,
  placement: "D over road, A over road, G over road, D over road" };
m.applyPlacementNotes([{ lines: [stacked] }]);
ok("Notes naming the same word again move to its next appearance",
   stacked.text === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", stacked.text);

// Quick chords on a word that appears once stay together on it.
const quick = { text: "Walking [D]down to the [A]river, morning [G]road [D/F#] [Em7] [D]", tab: false,
  placement: "D over down, A over river, G over road, D/F# over road, Em7 over road, D over road" };
m.applyPlacementNotes([{ lines: [quick] }]);
ok("Several chords on a word that appears once stay together", /\[G\]\s*\[D\/F#\]\s*\[Em7\]\s*\[D\]road|\[G\]road/.test(quick.text), quick.text);

// The AI repeated the end of a line; the source line wins.
const sections = [{ type: "verse", lines: [
  { text: "[D]Walking [A]down to the [G]ri[D/F#]ver, [Em7]morning [D]road, morning road, morning road", tab: false },
  { text: "Morning [D][A][G][D]road, morning road, morning road, morning road", tab: false }
] }];
m.realignToLayout(sections, layout, m.isValidChordToken);
ok("A line with its ending repeated by the AI goes back to the source line",
   sections[0].lines[0].text === layout[1], sections[0].lines[0].text);
ok("A stacked line goes back to the source layout", sections[0].lines[1].text === layout[0], sections[0].lines[1].text);

Deno.removeSync(tmp);
for (const r of results) console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}` + (r.pass ? "" : ` — ${r.detail}`));
const failed = results.filter((r) => !r.pass).length;
console.log(`\nimport_layout_test: ${results.length - failed}/${results.length} passed.`);
Deno.exit(failed ? 1 : 0);
