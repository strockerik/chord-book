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

// 7. Chord diagrams exist for all chords in a typical worship progression + movable barres + extended/slash chords
const sampleVoicings = [
  "C", "C2", "G", "G2", "G/B", "Dsus4", "D", "D2", "D4", "G4", "D/E", "Em", "Am7", "Em7",
  "D/F#", "D/C", "Am", "Cadd9", "F#m7", "Bbm", "A2", "E2", "E5", "C#5", "F#m7b5", "Bmaj9",
  "G7sus4", "C6/9", "Ammaj7", "E7#9", "A7b9", "F/A", "C#m/B", "Bb/D", "Eb/G", "G#m", "C#m"
];
for (const ch of sampleVoicings) {{
  const v = getChordVoicing(ch);
  assert("voicing exists for " + ch, v && Array.isArray(v.frets) && v.frets.length === 6, JSON.stringify(v));
}}
// Confirm G#m and C#m barres sit on 4th fret
assert("G#m & C#m sit on baseFret 4",
  getChordVoicing("G#m")?.baseFret === 4 && getChordVoicing("C#m")?.baseFret === 4,
  JSON.stringify({{ ghm: getChordVoicing("G#m"), csm: getChordVoicing("C#m") }}));

// 7a-bis. Exhaustive coverage: every quality in SPEC 5.3 + acoustic 2/4/5 across all 12 chromatic roots
const allQualities = [
  "", "m", "min", "-", "maj7", "M7", "Δ", "Δ7", "maj9", "7", "9", "11", "13",
  "sus2", "sus4", "sus", "7sus4", "7sus2", "9sus4", "add9", "add11", "add2", "add4",
  "6", "6/9", "69", "m6", "m7", "min7", "-7", "m9", "m11", "m13", "mmaj7",
  "m7b5", "ø", "ø7", "dim", "°", "dim7", "°7", "aug", "+", "aug7", "5", "4", "2",
  "7#9", "7b9", "7#5", "7b5", "7(b9)", "7(#9)"
];
let missingVoicings = [];
for (const root of CHROMATIC_SHARPS.concat(["Db", "Eb", "Gb", "Ab", "Bb"])) {{
  for (const q of allQualities) {{
    const name = root + q;
    const v = getChordVoicing(name);
    if (!v || !Array.isArray(v.frets) || v.frets.length !== 6 || !(v.baseFret >= 1)) {{
      missingVoicings.push(name);
    }}
  }}
}}
assert("all 17 roots x all qualities return a valid 6-string voicing (0 missing)",
  missingVoicings.length === 0, "missing: " + missingVoicings.slice(0, 10).join(", "));

// 7a-ter. Musical pitch & geometry validator over EVERY entry in BUILTIN_VOICINGS
const OPEN_PITCHES = [4, 9, 2, 7, 11, 4];
let voicingErrors = [];
for (const [name, v] of Object.entries(BUILTIN_VOICINGS)) {{
  if (!v || !Array.isArray(v.frets) || v.frets.length !== 6) {{
    voicingErrors.push(name + ": invalid frets array");
    continue;
  }}
  const bf = v.baseFret || 1;
  if (!Number.isInteger(bf) || bf < 1 || bf > 15) {{
    voicingErrors.push(name + ": bad baseFret " + bf);
  }}
  const nonMuted = v.frets.filter((f) => f >= 0);
  if (nonMuted.length < 3) {{
    voicingErrors.push(name + ": fewer than 3 sounding strings");
  }}
  for (const f of v.frets) {{
    if (!Number.isInteger(f) || f < -1 || f > 5) {{
      voicingErrors.push(name + ": out-of-range fret " + f);
    }}
  }}
  if (Array.isArray(v.barres)) {{
    for (const b of v.barres) {{
      if (!Number.isInteger(b.fret) || b.fret < 1 || b.fret > 5 || b.from < 0 || b.to > 5 || b.from >= b.to) {{
        voicingErrors.push(name + ": invalid barre " + JSON.stringify(b));
      }}
    }}
  }}
  // For every slash chord, verify the lowest sounding string pitch equals the bass pitch class
  const p = parseChord(name);
  if (p && p.bass) {{
    const sIdx = v.frets.findIndex((f) => f >= 0);
    const f = v.frets[sIdx];
    const abs = f === 0 ? 0 : bf + f - 1;
    const bassPitch = (OPEN_PITCHES[sIdx] + abs) % 12;
    const wantPitch = NOTE_TO_PITCH[p.bass];
    if (bassPitch !== wantPitch) {{
      voicingErrors.push(`${{name}}: lowest sounding string pitch ${{bassPitch}} !== ${{p.bass}} (${{wantPitch}})`);
    }}
  }}
}}
assert("every BUILTIN_VOICINGS entry has valid frets/barres and exact slash bass pitch",
  voicingErrors.length === 0, voicingErrors.join("; "));

// Dynamic slash bass placement when not explicitly listed in BUILTIN_VOICINGS
for (const [ch, wantBass] of [["F#m7/E", 4], ["Cadd9/E", 4], ["Gm/F", 5]]) {{
  const v = getChordVoicing(ch);
  const sIdx = v.frets.findIndex((f) => f >= 0);
  const f = v.frets[sIdx];
  const actualBass = (OPEN_PITCHES[sIdx] + (f === 0 ? 0 : (v.baseFret || 1) + f - 1)) % 12;
  assert("dynamic slash voicing puts bass on lowest string for " + ch,
    sIdx >= 0 && actualBass === wantBass, JSON.stringify({{ ch, v, actualBass, wantBass }}));
}}

// 7b. Tunings: half step down lowers the sounding key, and the others keep it
assert("half step down: G shapes sound in F#", soundingKeyWithTuning("G", 0, "Eb Ab Db Gb Bb Eb") === "F#", soundingKeyWithTuning("G", 0, "Eb Ab Db Gb Bb Eb"));
assert("half step down + capo 1 sounds in the written key", soundingKeyWithTuning("G", 1, "Eb Ab Db Gb Bb Eb") === "G");
assert("drop D keeps the key", soundingKeyWithTuning("D", 0, "D A D G B E") === "D" && getTuning("D A D G B E").id === "drop_d");
assert("minor keys stay put and move by pitch", transposeKey("Am", 0) === "Am" && transposeKey("Am", 3) === "Cm" && transposeKey("Em", 2) === "F#m" && transposeKey("C#m", -1) === "Cm",
  [transposeKey("Am", 0), transposeKey("Am", 3), transposeKey("Em", 2), transposeKey("C#m", -1)].join(","));
assert("a minor song with a capo sounds in the right key", soundingKeyWithTuning("Am", 3, "E A D G B E") === "Cm", soundingKeyWithTuning("Am", 3, "E A D G B E"));
assert("standard and custom tunings are recognized", getTuning("E A D G B E").id === "standard" && getTuning("DADGAD").display === "DADGAD");

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
