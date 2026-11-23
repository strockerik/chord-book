#!/usr/bin/env python3
"""Unit harness for js/chords.js (runs in headless Chrome with zero network/spend)."""

import html
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHORDS_JS = ROOT / "js" / "chords.js"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def inline_module(path: Path) -> str:
    code = path.read_text(encoding="utf-8")
    code = re.sub(r"^\s*import\s+.*?;\s*$", "", code, flags=re.M)
    code = re.sub(r"\bexport\s+(const|let|var|function|class)\b", r"\1", code)
    return code


def main():
    js_code = inline_module(CHORDS_JS)
    page_html = f"""<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
{js_code}

const results = [];
function assert(name, cond, detail = "") {{
  results.push({{ name, pass: !!cond, detail: String(detail) }});
}}

// 1. Grammar: every quality in SPEC 5.3
const qualities = [
  "m", "min", "-", "maj7", "M7", "Δ", "7", "9", "11", "13",
  "sus2", "sus4", "add9", "add11", "6", "69", "m6", "m7", "m9",
  "m7b5", "ø", "dim", "°", "dim7", "aug", "+", "5", "7#9", "7b9"
];
for (const q of qualities) {{
  const tok = "F#" + q + "/A";
  const p = parseChord(tok);
  assert("parseChord quality " + q, p && p.root === "F#" && p.quality === q && p.bass === "A", JSON.stringify(p));
}}

// 2. Reject non-chords
for (const word of ["Thank", "Lord", "Heaven", "Bearing", "Hallelujah", "Verse", "Chorus"]) {{
  assert("reject ordinary word " + word, !isChord(word), word);
}}
assert("accept N.C.", isChord("N.C."));

// 3. 12-semitone transpose round trip preserves quality and returns original root
const sampleChords = ["G", "G/B", "Cadd9", "Dsus4", "D/F#", "Em7", "Am7", "F#m7b5/A", "Bbmaj7/D"];
for (const c of sampleChords) {{
  let cur = c;
  const p0 = parseChord(c);
  const origPref = (p0.root.includes("b") || (p0.bass && p0.bass.includes("b"))) ? "flats" : "sharps";
  for (let i = 0; i < 12; i++) {{
    cur = transposeChord(cur, 1, null, origPref);
  }}
  assert("12-step round trip " + c, cur === c, "got " + cur);
}}

// 4. Key-based sharp / flat spelling (SPEC 5.3)
assert("Bb key uses flats (Eb)", transposeChord("C", 3, "Bb") === "Eb", transposeChord("C", 3, "Bb"));
assert("F key uses flats (Bb)", transposeChord("G", 3, "F") === "Bb", transposeChord("G", 3, "F"));
assert("G key uses sharps (F#m)", transposeChord("Em", 2, "G") === "F#m", transposeChord("Em", 2, "G"));
assert("D/F# transposed +2 in A is E/G#", transposeChord("D/F#", 2, "A") === "E/G#", transposeChord("D/F#", 2, "A"));

// 5. Capo math & suggestions
assert("Bb sounding with capo 3 plays G shapes", capoShapesKey("Bb", 3) === "G", capoShapesKey("Bb", 3));
assert("G shapes with capo 2 sounds in A", soundingKeyFromShapes("G", 2) === "A", soundingKeyFromShapes("G", 2));
const suggestions = suggestCapoPositions(["Bb", "Eb", "F", "Gm"], "Bb");
assert("suggests capo 3 (G) or capo 1 (A) for Bb progression", suggestions[0].capo === 3 || suggestions[0].capo === 1, JSON.stringify(suggestions[0]));

// 6. Nashville numbers
assert("Nashville in G: G=1, C=4, D/F#=5/7, Em7=6m7",
  toNashville("G", "G") === "1" &&
  toNashville("C", "G") === "4" &&
  toNashville("D/F#", "G") === "5/7" &&
  toNashville("Em7", "G") === "6m7",
  [toNashville("G","G"), toNashville("C","G"), toNashville("D/F#","G"), toNashville("Em7","G")].join(", ")
);

// 7. Chord diagrams exist for all chords in a typical worship progression + movable barres
for (const ch of ["C", "G", "G/B", "Dsus4", "D", "D/E", "Em", "Am7", "Em7", "D/F#", "D/C", "Am", "Cadd9", "F#m7", "Bbm"]) {{
  const v = getChordVoicing(ch);
  assert("voicing exists for " + ch, v && Array.isArray(v.frets) && v.frets.length === 6, JSON.stringify(v));
}}

// 8. Key center grouping for vocal analytics
const kcG = getKeyCenter("G");
const kcEm = getKeyCenter("Em");
assert("G and Em share key center G / Em", kcG.label === "G / Em" && kcEm.label === "G / Em", kcG.label + " vs " + kcEm.label);

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
    print(f"\nchords_test: {len(results) - len(failed)}/{len(results)} passed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
