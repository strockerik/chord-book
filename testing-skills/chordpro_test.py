#!/usr/bin/env python3
"""Unit harness for js/chordpro.js: round-trip parse/serialize, chords-over-lyrics, and ugly single-line paste."""

import html
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixtures import UGLY_PASTE, SPLIT_LINE_PASTE

ROOT = Path(__file__).resolve().parent.parent
CHORDS_JS = ROOT / "js" / "chords.js"
CHORDPRO_JS = ROOT / "js" / "chordpro.js"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def inline_module(path: Path) -> str:
    code = path.read_text(encoding="utf-8")
    code = re.sub(r"^\s*import\s+[\s\S]*?from\s+['\"].*?['\"];\s*$", "", code, flags=re.M)
    code = re.sub(r"\bexport\s+(const|let|var|function|class)\b", r"\1", code)
    return code


CHORDS_OVER_LYRICS_SAMPLE = """Tuning: E A D G B E   Capo: 2nd fret
Wildflower Road - The Porch Lights
(All throughout the song you can play Cadd9 for C)

[Intro]
C  G  C  G

[Verse]
G         G/B     C      G
Light the way for night, Mary.
              C      Dsus4 D   G
Walk the long dirt road back home.
            D/E       Em
Bring your old tin cup and spoon,
  D       C
Now sing along,
   Am7   G/B    Dsus4 D
And wait for the morning.
"""

CANONICAL_SAMPLE = """{title: Wildflower Road}
{artist: Erik Strock}
{key: G}
{capo: 2}
{tempo: 96}
{time: 4/4}
{define: Dsus4 base-fret 1 frets x x 0 2 3 3}

{start_of_verse: Verse 1}
{note: [dynamic] Start quiet and get louder over this verse}
[G]Walking down the [C]wildflower [G]road
[Em]Sun on my [C]shoulders, [D]light on the [G]load
{end_of_verse}

{start_of_chorus}
[C]Oh, the [G]long way [D]home
{end_of_chorus}

{start_of_tab}
e|-----0-----|
B|---1---1---|
{end_of_tab}"""


def main():
    js_code = inline_module(CHORDS_JS) + "\n" + inline_module(CHORDPRO_JS)
    page_html = f"""<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
{js_code}

const results = [];
function assert(name, cond, detail = "") {{
  results.push({{ name, pass: !!cond, detail: String(detail) }});
}}

// 1. Canonical round-trip (parse -> serialize -> parse)
const canonical = {json.dumps(CANONICAL_SAMPLE)};
const model1 = parse(canonical);
const reserialized = serialize(model1);
assert("round-trip preserves exact canonical ChordPro", reserialized === canonical, "DIFF:\\n" + reserialized);
assert("parsed sidebar note & kind", model1.sections[0].sidebarNote === "Start quiet and get louder over this verse" && model1.sections[0].sidebarKind === "dynamic", JSON.stringify(model1.sections[0]));
assert("parsed custom define", !!model1.meta.defines["Dsus4"], JSON.stringify(model1.meta.defines));
assert("parsed tab verbatim", model1.sections[2].lines[0].tab.includes("e|-----0-----|"), JSON.stringify(model1.sections[2]));

// 2. Standard chords-over-lyrics import
const colSample = {json.dumps(CHORDS_OVER_LYRICS_SAMPLE)};
const colPro = fromChordsOverLyrics(colSample);
const colParsed = parse(colPro);
assert("chords-over-lyrics extracts title & artist", colParsed.meta.title === "Wildflower Road" && colParsed.meta.artist === "The Porch Lights", JSON.stringify(colParsed.meta));
assert("chords-over-lyrics extracts capo 2", colParsed.meta.capo === 2, String(colParsed.meta.capo));
assert("chords-over-lyrics aligns [G/B] over 'way' and [C] over 'night'",
  colPro.includes("[G]Light the [G/B]way for [C]night, [G]Mary."),
  colPro
);

// 3. Ugly single-line paste
const uglySample = {json.dumps(UGLY_PASTE)};
const smart = smartImportText(uglySample);
assert("smartImportText detects ugly_paste format", smart.format === "ugly_paste", smart.format);
const uglyParsed = parse(smart.chordpro);
assert("ugly paste extracts title", uglyParsed.meta.title === "Wildflower Road", uglyParsed.meta.title);
assert("ugly paste extracts artist", uglyParsed.meta.artist === "The Porch Lights", uglyParsed.meta.artist);
assert("ugly paste extracts performance note about Cadd9", uglyParsed.meta.note.includes("play Cadd9 for C"), uglyParsed.meta.note);
assert("ugly paste infers key G", uglyParsed.meta.key === "G", uglyParsed.meta.key);
assert("ugly paste creates 4 sections (Intro, Verse 1, Verse 2, Chorus)",
  uglyParsed.sections.length === 4 &&
  uglyParsed.sections[0].label === "Intro" &&
  uglyParsed.sections[1].label === "Verse 1" &&
  uglyParsed.sections[2].label === "Verse 2" &&
  uglyParsed.sections[3].label === "Chorus",
  uglyParsed.sections.map(s => s.label).join(", ")
);
assert("ugly paste preserves 'Now all I know' and 'Am' chords properly",
  smart.chordpro.includes("Now") &&
  smart.chordpro.includes("[Am]") &&
  smart.chordpro.includes("[D/F#]"),
  smart.chordpro
);

// 3b. A chord site copied on a phone (chords and words on separate lines)
const split = smartImportText({json.dumps(SPLIT_LINE_PASTE)}.trim());
const splitParsed = parse(split.chordpro);
assert("phone copy is detected as split lines", split.format === "split_lines", split.format);
assert("phone copy finds title and artist, not the album or year",
  splitParsed.meta.title === "Lantern Hill" && splitParsed.meta.artist === "The Porch Lights", JSON.stringify(splitParsed.meta));
assert("phone copy reads the stated key", splitParsed.meta.key === "G", splitParsed.meta.key);
assert("phone copy drops voicings and site notes",
  !/x[0-9]{{4}}|320033|100%|Chords:|Back Roads|2019/.test(split.chordpro), split.chordpro);
assert("phone copy builds labeled sections in order",
  splitParsed.sections.map((s) => s.label).join("|") === "Intro (2x)|Verse 1|Chorus|Verse 2|Chorus|Bridge (2x)",
  splitParsed.sections.map((s) => s.label).join("|"));
assert("intro chords and its note come from the header",
  split.chordpro.includes("[C/E]   [G]") && splitParsed.sections[0].sidebarNote === "Let it ring", split.chordpro);
assert("words rejoin into whole lines with each chord on its word",
  split.chordpro.includes("Down the road[C/E] [G]where the [C/E]lan[G]tern glows") &&
  split.chordpro.includes("[Em]Porch light shining on the gravel rows"), split.chordpro);
assert("chorus line rejoins across chord breaks",
  split.chordpro.includes("[G]Hold on [D]to the [Em]hill") && split.chordpro.includes("(Hold on, hold on)"), split.chordpro);
assert("a held chord lands on the next line",
  split.chordpro.includes("[G](hold) Fireflies are getting old"), split.chordpro);
assert("(Repeat Chorus) becomes a chorus repeat", split.chordpro.includes("{{chorus}}"), split.chordpro);
assert("end note is kept", split.chordpro.includes("{{comment: End on G}}"), split.chordpro);
assert("form line follows the sections",
  split.info.form === "Form: Intro (2x) • V1 • Chorus • V2 • Chorus • Bridge (2x)", split.info.form);
assert("non-worship words are not filed as Worship", split.info.genre !== "worship", split.info.genre);
assert("a normal paste is not mistaken for a phone copy", smartImportText({json.dumps(CHORDS_OVER_LYRICS_SAMPLE)}).format !== "split_lines");

// 4. Transpose entire ChordPro sheet and back
const up2 = transposeChordPro(smart.chordpro, 2);
const up2Parsed = parse(up2);
assert("transposeChordPro +2 changes key G -> A and D/F# -> E/G#",
  up2Parsed.meta.key === "A" && up2.includes("[E/G#]"),
  up2Parsed.meta.key
);
const backToG = transposeChordPro(up2, -2);
assert("transposeChordPro +2 then -2 returns exact original sheet", backToG === smart.chordpro);

// 5. Layer 1 Chord Alignment Quality Check & Auto-Fixer
const messySheet = `{{title: QC Test}}
{{key: G}}

{{start_of_verse: Verse 1}}
[D]The lantern of harbor
We sing [C]and wa[G]lked home paid.[D]Now
A chord on a real syllable a[G]bides
{{end_of_verse}}

{{start_of_chorus: Chorus}}
[E]Sunlight, sunlight, [E]we rise again
{{end_of_chorus}}`;
const qcReport = auditChordAlignment(messySheet);
assert("auditChordAlignment detects pickup downbeat, mid-word split, punctuation spacing, and redundant chord",
  qcReport.autoFixCount >= 4 &&
  qcReport.fixedChordpro.includes("The [D]lantern") &&
  qcReport.fixedChordpro.includes("[G]walked") &&
  qcReport.fixedChordpro.includes("a[G]bides") &&
  qcReport.fixedChordpro.includes("paid. [D]Now") &&
  !qcReport.fixedChordpro.includes("[E]we"),
  JSON.stringify(qcReport.issues)
);

// 6. Layer 2 Interactive Nudge Right & Left
const nudgeStart = `{{title: Nudge Test}}
{{key: G}}

{{start_of_verse: Verse 1}}
[G]Walking down the road
{{end_of_verse}}`;
const nudgedRight = nudgeChordInChordPro(nudgeStart, 0, 0, 0, 1);
assert("nudgeChordInChordPro(+1) shifts [G] right one word",
  nudgedRight.includes("Walking [G]down the road"),
  nudgedRight
);
const nudgedLeft = nudgeChordInChordPro(nudgedRight, 0, 0, 1, -1);
assert("nudgeChordInChordPro(-1) shifts [G] back left to 'Walking'",
  nudgedLeft.includes("[G]Walking down the road"),
  nudgedLeft
);

// 7. "Chorus" is the one section word, while lyrics and titles keep their own words
const refrainSheet = `{{title: Refrain Of Grace}}
{{meta_note: Form: V1 • Refrain}}

{{start_of_chorus: Refrain}}
{{note: [cue] Soft on the refrain}}
I cannot [G]refrain from singing
{{end_of_chorus}}`;
const refrainParsed = parse(refrainSheet);
const refrainEditor = chorusWordingInChordPro(refrainSheet);
assert("Refrain labels and notes display as Chorus",
  refrainParsed.sections[0].label === "Chorus" &&
  refrainParsed.sections[0].sidebarNote === "Soft on the chorus" &&
  refrainParsed.meta.note === "Form: V1 • Chorus",
  JSON.stringify(refrainParsed.sections[0])
);
assert("Lyrics and titles keep the word refrain",
  refrainParsed.meta.title === "Refrain Of Grace" &&
  refrainParsed.sections[0].lines.some((l) => (l.segments || []).some((s) => s.lyric.includes("refrain"))) &&
  refrainEditor.includes("{{title: Refrain Of Grace}}") &&
  refrainEditor.includes("I cannot [G]refrain from singing") &&
  refrainEditor.includes("{{start_of_chorus: Chorus}}"),
  refrainEditor
);

document.getElementById("out").textContent = JSON.stringify(results);
</script>"""

    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "test.html"
        p.write_text(page_html, encoding="utf-8")
        dom = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=2000", "--dump-dom", p.as_uri()],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout

    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m or not m.group(1).strip():
        print("FAIL: Chrome did not produce output:\n", dom, file=sys.stderr)
        sys.exit(2)

    results = json.loads(html.unescape(m.group(1)))
    failed = [r for r in results if not r["pass"]]
    for r in results:
        status = "PASS" if r["pass"] else "FAIL"
        print(f"[{status}] {r['name']}" + (f" — {r['detail']}" if not r["pass"] else ""))
    print(f"\nchordpro_test: {len(results) - len(failed)}/{len(results)} passed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
