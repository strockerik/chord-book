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
ok("Songs still missing a melody are listed for lookup", m.songsMissingMelody(lib).map((x) => x.id).join() === "4");

const rec = a.getIdealVocalRangeRecommendations(lib[2], lib);
ok("A too-high song gets a rewrite that brings every note inside",
   rec.range && !rec.range.fits && rec.pureTranspose?.targetShapesKey === "A" && rec.range.after?.miss === 0,
   JSON.stringify({ range: rec.range, pt: rec.pureTranspose }));
ok("A song whose notes fit counts as a good fit in any key", a.getIdealVocalRangeRecommendations(lib[0], lib).isAlreadyIdeal === true);

m.setManualVocalRange({ low: 43, high: 72 });
ok("A range you set wins over the songs", m.getVocalRange(lib).from === "you" && m.getVocalRange(lib).high === 72);
ok("With your wider range the high song fits", a.getIdealVocalRangeRecommendations(lib[2], lib).range.fits === true);
m.setManualVocalRange(null);

const page = a.renderAnalyticsDashboardHTML(lib);
ok("My Keys shows your range", page.includes("Your vocal range") && page.includes("A2–G4"));
ok("Bad fit lists the too-high song with the notes it would sing",
   /Bad fit \(1\)/.test(page) && /Sings D3–A#4 • Rewrite in A to sing B2–G4/.test(page), page.match(/fit-song-sub">[^<]*/g));
ok("My Keys offers to look up the missing melody", page.includes("Look up 1 melody range with AI"));
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
