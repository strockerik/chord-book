#!/usr/bin/env python3
"""Melody range checks for js/melody.js and the range-aware key advice in js/analytics.js.

Serves the repo on a local port and loads the real modules in headless Chrome (no network, no spend).
"""

import html
import json
import re
import socket
import subprocess
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

TEST_JS = r"""
import * as m from "./js/melody.js";
import * as a from "./js/analytics.js";
import { APP_VERSION } from "./js/core.js";
import { REVISIONS } from "./js/revisions.js";
const results = [];
const ok = (name, cond, detail = "") => results.push({ name, pass: !!cond, detail: String(detail) });
try { localStorage.clear(); } catch {}
const sheet = (key) => `{title: T}\n{key: ${key}}\n\n{start_of_verse}\n[${key}]la la [D]la\n{end_of_verse}`;

// The recording is in A; the sheet is G shapes with capo 2, so you sing the recording's notes.
const s1 = { id: "1", title: "One", key: "G", capo: 2, chordpro: sheet("G"), layout_prefs: {} };
s1.layout_prefs.melody = m.melodyFromRecording(s1, { recording_key: "A", low: 45, high: 64 });
const sung1 = m.sungRange(s1);
ok("Capo song sings the recording's notes", sung1.low === 45 && sung1.high === 64, JSON.stringify(sung1));
ok("The original recording's key is saved with the notes",
   s1.layout_prefs.melody.recording_key === "A" && s1.layout_prefs.melody.key === "G" && m.storedMelody(s1).recordingKey === "A");
ok("Correcting the notes by hand keeps the recording's key",
   m.melodyFromSung(s1, 44, 63).recording_key === "A" && m.melodyFromSung(s1, 44, 63).source === "you");
ok("Transposing up 2 raises the sung notes 2", m.sungRange({ ...s1, preferred_transpose: 2 }).high === 66);
ok("Half step down tuning lowers the sung notes", m.sungRange({ ...s1, tuning: "Eb Ab Db Gb Bb Eb" }).high === 63);
ok("A sheet rewritten in a new key keeps the melody with it",
   m.storedMelody({ ...s1, key: "A" }).low === s1.layout_prefs.melody.low + 2);
const s2 = { id: "2", title: "Two", key: "Em", capo: 0, chordpro: sheet("Em"), layout_prefs: {} };
s2.layout_prefs.melody = m.melodyFromRecording(s2, { recording_key: "G", low: 52, high: 67 });
ok("A relative major recording maps onto a minor sheet with no shift", m.sungRange(s2).low === 52);
ok("Note names", m.midiToNote(60) === "C4" && m.midiToNote(54) === "F#3" && m.noteToMidi("Bb3") === 58);
ok("Sung notes set by hand are saved against the written key",
   m.melodyFromSung({ ...s1, preferred_transpose: 1 }, 46, 65).low === 45 - 2);

const voice = { low: 45, high: 64 };
ok("A melody inside your range fits", m.rangeFit({ low: 47, high: 62 }, voice).miss === 0);
const her = m.rangeFit({ low: 57, high: 76 }, voice);
ok("A woman's melody fits an octave down", her.miss === 0 && her.octave === -12, JSON.stringify(her));
const best = m.bestRangeShift({ low: 48, high: 67 }, voice, "C");
ok("Three half steps too high moves down three", best.shift === -3 && best.fit.miss === 0, JSON.stringify(best));
const roomy = m.bestRangeShift({ low: 48, high: 60 }, { low: 45, high: 64 }, "C");
ok("A melody that already fits with room to spare stays where it is", roomy.shift === 0 && roomy.room === 2, JSON.stringify(roomy));
const tight = m.bestRangeShift({ low: 46, high: 65 }, { low: 45, high: 64 }, "C");
ok("A melody one step too high moves for room, not just to squeak inside",
   tight.fit.miss === 0 && tight.fit.high <= 64 && tight.fit.low >= 45 && tight.shift === -1, JSON.stringify(tight));
ok("A melody wider than your range can't fit", m.bestRangeShift({ low: 40, high: 70 }, voice, "C").fit.miss > 0);

const lib = [
  { ...s1, vocal_comfort: "sweet_spot" },
  { ...s2, vocal_rating: 5 },
  { id: "3", title: "High", key: "C", chordpro: sheet("C"), vocal_comfort: "high_stretch",
    layout_prefs: { melody: { low: 50, high: 70, key: "C", source: "ai" } } },
  { id: "4", title: "Unknown", key: "D", chordpro: sheet("D"), layout_prefs: {} }
];
const r = m.deriveVocalRange(lib);
ok("Your range comes from the songs you sing well", r && r.low === 45 && r.high === 67 && r.stretchHigh === 70, JSON.stringify(r));
ok("Fewer than two rated songs with a melody gives no range", m.deriveVocalRange([lib[0]]) === null);
ok("Songs still missing a melody (or an old AI range without the original) are listed for lookup",
   m.songsMissingMelody(lib).map((x) => x.id).join() === "3,4", m.songsMissingMelody(lib).map((x) => x.id).join());

const rec = a.getIdealVocalRangeRecommendations(lib[2], lib);
ok("A too-high song moves to the key that leaves room at both ends of your range",
   rec.range && !rec.range.fits && rec.pureTranspose?.targetShapesKey === "Ab" && rec.range.after?.miss === 0
   && rec.range.after.low > r.low && rec.range.after.high < r.high,
   JSON.stringify({ range: rec.range, pt: rec.pureTranspose }));
ok("A song whose notes fit counts as a good fit in any key", a.getIdealVocalRangeRecommendations(lib[0], lib).isAlreadyIdeal === true);

// How it feels beats the estimate: a song marked too high moves down even when its notes "fit".
const feltHigh = { ...lib[0], id: "5", vocal_comfort: "high_stretch" };
const recHigh = a.getIdealVocalRangeRecommendations(feltHigh, [...lib, feltHigh]);
ok("A song you marked too high always gets a lower key", !recHigh.isAlreadyIdeal && recHigh.felt
   && recHigh.pureTranspose?.semitoneShiftFromCurrent < 0, JSON.stringify({ felt: recHigh.felt, pt: recHigh.pureTranspose }));
const feltLow = { id: "6", title: "Low", key: "E", chordpro: sheet("E"), vocal_comfort: "too_low", layout_prefs: {} };
const recLow = a.getIdealVocalRangeRecommendations(feltLow, [...lib, feltLow]);
ok("A song you marked too low always gets a higher key", recLow.felt && recLow.pureTranspose?.semitoneShiftFromCurrent > 0,
   JSON.stringify(recLow.pureTranspose));
const feltOne = { id: "7", title: "One star", key: "A", chordpro: sheet("A"), vocal_rating: 1, layout_prefs: {} };
ok("A 1★ song gets a key to try", !!a.getIdealVocalRangeRecommendations(feltOne, [...lib, feltOne]).pureTranspose);

m.setManualVocalRange({ low: 43, high: 72 });
ok("A range you set wins over the songs", m.getVocalRange(lib).from === "you" && m.getVocalRange(lib).high === 72);
ok("With your wider range the high song fits", a.getIdealVocalRangeRecommendations(lib[2], lib).range.fits === true);
m.setManualVocalRange(null);

const page = a.renderAnalyticsDashboardHTML(lib);
ok("My Keys shows your range", page.includes("Your vocal range") && page.includes("A2–G4"));
ok("Bad fit lists the too-high song with the notes it would sing",
   /Bad fit \(1\)/.test(page) && /Sings D3–A#4 • Rewrite in Ab to sing A#2–F#4/.test(page), page.match(/fit-song-sub">[^<]*/g));
ok("My Keys offers to look up the missing melodies", page.includes("Look up 2 melody ranges with AI"));
ok("What's new lists this release first", REVISIONS[0]?.version === APP_VERSION && REVISIONS[0].notes.length > 0,
   `${REVISIONS[0]?.version} vs ${APP_VERSION}`);
// Original recording and this sheet, side by side. Made-up songs; the numbers are what matter.
const progression = (chords) => `{title: T}\n\n{start_of_verse}\n` +
  Array.from({ length: 3 }, () => chords.map((c) => `[${c}]la`).join(" ")).join("\n") + "\n{end_of_verse}";
// A band tuned down a half step plays C#m shapes, so the recording sounds in Cm (G3–G4).
// This sheet is in Am, standard tuning: 3 half steps lower.
const ain = { id: "a1", title: "Half Step Song", key: "Am", capo: 0, chordpro: progression(["Am", "G", "F", "C"]), layout_prefs: {} };
ain.layout_prefs.melody = m.melodyFromRecording(ain, { recording_key: "Cm", low: 55, high: 67, confidence: "high" });
const ainSung = m.sungRange(ain);
ok("The original recording is saved exactly as the AI gave it",
   JSON.stringify(m.originalMelody(ain)) === JSON.stringify({ key: "Cm", low: 55, high: 67, source: "ai", confidence: "high" }), JSON.stringify(ain.layout_prefs.melody));
ok("A sheet 3 half steps below the original sings 3 half steps lower",
   ainSung.low === 52 && ainSung.high === 64 && m.shiftFromOriginal(ain) === -3, JSON.stringify({ ainSung, d: m.shiftFromOriginal(ain) }));
const same = { id: "a2", title: "Same", key: "F", capo: 2, chordpro: progression(["F", "C", "Dm", "Bb"]), layout_prefs: {} };
same.layout_prefs.melody = m.melodyFromRecording(same, { recording_key: "G", low: 50, high: 64 });
ok("A sheet that sounds in the original key (F shapes, capo 2 = G) sings the original notes",
   m.sungRange(same).low === 50 && m.sungRange(same).high === 64 && m.shiftFromOriginal(same) === 0);
const half = { id: "a3", title: "Tuned Down", key: "C#m", capo: 0, tuning: "Eb Ab Db Gb Bb Eb", chordpro: progression(["C#m", "B", "A", "E"]), layout_prefs: {} };
half.layout_prefs.melody = m.melodyFromRecording(half, { recording_key: "Cm", low: 55, high: 67 });
ok("C#m shapes tuned down a half step sound in Cm: the original notes, no shift",
   m.sungRange(half).low === 55 && m.shiftFromOriginal(half) === 0, JSON.stringify(m.sungRange(half)));
const moved = { ...ain, capo: 2, preferred_transpose: -1 };
ok("Capo and transpose move this sheet's notes but never the original",
   m.originalMelody(moved).low === 55 && m.sungRange(moved).low === 53 && m.shiftFromOriginal(moved) === -2);
const handSet = m.melodyFromSung(ain, 50, 62);
ok("Setting this sheet's notes by hand keeps the original recording", handSet.source === "you" && handSet.original?.key === "Cm" && handSet.original.low === 55);

// Old AI ranges (saved before originals were kept) get looked up again; yours never do.
const oldAi = { id: "o1", title: "Old", key: "G", chordpro: progression(["G", "C", "D", "Em"]), layout_prefs: { melody: { low: 45, high: 62, key: "G", source: "ai", recording_key: "G" } } };
const oldYou = { ...oldAi, id: "o2", layout_prefs: { melody: { low: 45, high: 62, key: "G", source: "you" } } };
const oldUnknown = { ...oldAi, id: "o3", layout_prefs: { melody: { ...oldAi.layout_prefs.melody, original_unknown: true } } };
const refresh = m.songsMissingMelody([oldAi, oldYou, oldUnknown, ain]).map((x) => x.id).join();
ok("Old AI ranges without the original are looked up again; ranges you set are left alone", refresh === "o1", refresh);
ok("An old range still works while it waits for the refresh", m.sungRange(oldAi).low === 45);

// The sheet's key label against its chords.
const wrongLabel = { id: "k1", title: "Wrong", key: "E", chordpro: progression(["Am", "G", "F", "C"]), layout_prefs: {} };
const mm = m.sheetKeyMismatch(wrongLabel);
ok("Chords in Am under a key of E are flagged, with a key that fits the chords",
   mm && mm.written === "E" && mm.chords === "Am", JSON.stringify(mm));
ok("Am and C count as the same key (same chords): no flag",
   m.sheetKeyMismatch({ ...wrongLabel, key: "C" }) === null && m.sheetKeyMismatch({ ...wrongLabel, key: "Am" }) === null);
ok("A song that borrows a chord (D, C, G in D) isn't flagged",
   m.sheetKeyMismatch({ ...wrongLabel, key: "D", chordpro: progression(["D", "C", "G", "D"]) }) === null);
wrongLabel.layout_prefs.melody = m.melodyFromRecording(wrongLabel, { recording_key: "Cm", low: 55, high: 67 });
const fixedMelody = m.melodyAfterKeyFix(wrongLabel, "Am");
const fixedSong = { ...wrongLabel, key: "Am", layout_prefs: { melody: fixedMelody } };
ok("Fixing a wrong key label works the range out again from the original",
   m.sungRange(fixedSong).low === 52 && m.originalMelody(fixedSong).low === 55, JSON.stringify(m.sungRange(fixedSong)));

document.getElementById("out").textContent = JSON.stringify(results);
"""


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/__melody_test.html"):
            body = f'<!doctype html><meta charset="utf-8"><pre id="out"></pre><script type="module">{TEST_JS}</script>'.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        dom = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=5000",
             "--dump-dom", f"http://127.0.0.1:{port}/__melody_test.html"],
            capture_output=True, text=True, timeout=60,
        ).stdout
    finally:
        server.shutdown()
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m or not m.group(1).strip():
        print("FAIL: Chrome did not produce output:\n", dom[:2000], file=sys.stderr)
        sys.exit(2)
    results = json.loads(html.unescape(m.group(1)))
    failed = [r for r in results if not r["pass"]]
    for r in results:
        print(f"[{'PASS' if r['pass'] else 'FAIL'}] {r['name']}" + (f" — {r['detail']}" if not r["pass"] else ""))
    print(f"\nmelody_test: {len(results) - len(failed)}/{len(results)} passed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
