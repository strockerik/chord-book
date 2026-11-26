#!/usr/bin/env python3
"""Live test of AI import (paste, link, photo, PDF) against the deployed import-sheet function.

It SPENDS money (Sonnet 4.6, a few cents per import) and the test account's daily import
quota, so it only runs with --spend.

  python3 testing-skills/ai_import_live_test.py --spend            # every case
  python3 testing-skills/ai_import_live_test.py --spend --only pdf  # cases whose id contains "pdf"
  python3 testing-skills/ai_import_live_test.py --grade-only RUN_DIR

What it uses, none of which is in this repo:
  - Test inputs in the git-ignored "House Index Test/" folder (real songs).
  - The houseindextest login: TEST_EMAIL / TEST_PASSWORD in House Index's git-ignored
    notes.md. It signs in as an ordinary user with the publishable key, never an admin key,
    and never prints the login.
  - Known answers from the git-ignored "Chords to Add/Chord Book - Load Into Supabase.sql".

Each imported song is saved to the test account (tag "import-test"), replacing that case's
songs from earlier runs, so the owner can sign in and review them. Raw results go to
the git-ignored ai_test_runs/.
"""

import argparse
import base64
import concurrent.futures
import datetime
import difflib
import json
import re
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_DIR = ROOT / "House Index Test"
KNOWN_SQL = ROOT / "Chords to Add" / "Chord Book - Load Into Supabase.sql"
NOTES = ROOT.parent / "Strock-Recipes" / "notes.md"
RUNS = ROOT / "ai_test_runs"
SSL_CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")

ELEVATE = ["10,000 Reasons (Bless The Lord)", "Jesus Paid It All (O Praise The One)",
           "His Mercy Is More", "All Glory Be To Christ"]

# (id, what it tests, type, inputs, known titles in the owner's library)
CASES = [
    ("photo-great-are-you-lord", "Phone photo of a printed chart with bar-line intro", "image", ["IMG_5320.jpeg"], []),
    ("photo-all-must-be-well", "Sideways phone photo, chords on verse 1 only", "image", ["IMG_5321.jpeg"], []),
    ("photo-all-must-be-well-upright", "The same page photographed upright", "image", ["IMG_5321 rotated.jpeg"], []),
    ("shot-amazing-grace-user", "Screenshot of a two-column chord site page", "image", ["Amazing Grace-user.png"], []),
    ("photo-come-thou-fount", "Phone photo of a hymn, chords on verse 1 only", "image", ["IMG_5322.jpeg"], []),
    ("photo-jesus-i-come", "Two photos of the same sideways, two-column page", "image", ["IMG_5323.jpeg", "IMG_5323 2.jpeg"], []),
    ("shot-im-on-fire", "One screenshot of a chords-over-lyrics site", "image", ["Pasted 2026-11-24 at 3.13.51 PM.png"], []),
    ("shots-start-nowhere", "Five overlapping screenshots, one repeated", "image", "Start Nowhere/*", []),
    # The owner's reference for this song is the screen grabs; the Chordie copy of it is wrong.
    ("shots-so-last-summer", "Five phone screenshots from a chord app", "image", "Youre So Last Summer Screen Grabs/*", []),
    ("pdf-how-deep", "One-song PDF already in the library", "pdf", "How Deep the Fathers Love.pdf", ["How Deep The Father's Love For Us"]),
    ("pdf-elevate-hope", "Four-song set list PDF, all in the library", "pdf", "2026-1203-Elevate Hope Songs.pdf", ELEVATE),
    ("text-ug-amazing-grace", "Ultimate Guitar copy with a chord diagram and a mislabeled section", "text", "Other Sources/Amazing Grace - Ultimate Guitar copy.txt", []),
    ("text-jm-til-the-right-one", "John Mayer Chords copy, chords over lyrics", "text", "Other Sources/Til the Right One Comes - John Mayer Chords copy.txt", []),
    ("text-jm-gravity", "John Mayer Chords copy, mostly guitar tab", "text", "Other Sources/Gravity - John Mayer Chords copy.txt", []),
    ("text-davetabs-crash", "DaveTabs copy, tab only with no chords or lyrics", "text", "Other Sources/Crash Into Me - DaveTabs copy.txt", []),
    ("link-ug-so-last-summer", "Link: the Ultimate Guitar page the screen grabs came from", "url", "https://tabs.ultimate-guitar.com/tab/taking-back-sunday/youre-so-last-summer-chords-668210", []),
    # Many identical "Let it be" lines in the chorus, each with its own chords.
    ("link-ug-let-it-be", "Link: Ultimate Guitar page with a chorus of repeated short lines", "url", "https://tabs.ultimate-guitar.com/tab/the-beatles/let-it-be-chords-17427", []),
    ("link-hymnal-amazing-grace", "Link: hymnal.net page with chords", "url", "https://www.hymnal.net/en/hymn/h/313", []),
    ("link-jm-split-screen", "Link: John Mayer Chords page", "url", "https://johnmayerchords.com/albums/Heavier%20Things/Split%20Screen%20Sadness/Studio", []),
]


def config():
    text = (ROOT / "config.js").read_text()
    url = re.search(r'SUPABASE_URL\s*=\s*"([^"]+)"', text).group(1)
    key = re.search(r'SUPABASE_ANON_KEY\s*=\s*"([^"]+)"', text).group(1)
    notes = NOTES.read_text() if NOTES.exists() else ""
    email = (re.search(r"^TEST_EMAIL=(.+)$", notes, re.M) or [None, None])[1]
    password = (re.search(r"^TEST_PASSWORD=(.+)$", notes, re.M) or [None, None])[1]
    if not (email and password):
        sys.exit("TEST_EMAIL / TEST_PASSWORD missing from House Index notes.md")
    return url, key, email.strip(), password.strip()


def http(method, url, headers, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as res:
            raw = res.read().decode()
            return res.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def sign_in(url, key, email, password):
    status, data = http("POST", f"{url}/auth/v1/token?grant_type=password", {"apikey": key},
                        {"email": email, "password": password})
    if status != 200 or not isinstance(data, dict) or not data.get("access_token"):
        sys.exit(f"Test sign-in failed (HTTP {status}). Check TEST_EMAIL / TEST_PASSWORD.")
    return data["access_token"]


CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def app_layout(text):
    """What the app sends with a paste: its column-exact lines (js/ai.js does the same)."""
    def inline(path):
        code = path.read_text()
        code = re.sub(r"^\s*import\s+[\s\S]*?from\s+['\"].*?['\"];\s*$", "", code, flags=re.M)
        return re.sub(r"\bexport\s+(const|let|var|function|class|async function)\b", r"\1", code)
    js = inline(ROOT / "js" / "chords.js") + "\n" + inline(ROOT / "js" / "chordpro.js")
    page = f"""<!doctype html><meta charset=utf-8><pre id=out></pre><script>{js}
const d = smartImportText({json.dumps(text.strip())});
const lines = ["chords_over_lyrics", "split_lines"].includes(d.format)
  ? d.chordpro.split("\\n").filter((l) => l.includes("[") && !l.trim().startsWith("{{")) : [];
document.getElementById("out").textContent = JSON.stringify(lines);
</script>"""
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "layout.html"
        f.write_text(page)
        dom = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=2000",
                              "--dump-dom", f.as_uri()], capture_output=True, text=True, timeout=60).stdout
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    import html as _html
    return json.loads(_html.unescape(m.group(1))) if m else []


def image_payload(path):
    """Same downscale as the app: longest side 1600px, JPEG."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "img.jpg"
        subprocess.run(["sips", "-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "85", str(path), "--out", str(out)],
                       capture_output=True, check=True)
        return {"mediaType": "image/jpeg", "data": base64.b64encode(out.read_bytes()).decode()}


def request_body(kind, inputs):
    if kind == "image":
        files = sorted((TEST_DIR / inputs[:-2]).glob("*")) if isinstance(inputs, str) else [TEST_DIR / f for f in inputs]
        files = [f for f in files if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".heic")]
        return {"type": "image", "images": [image_payload(f) for f in files]}, f"{len(files)} image(s)"
    if kind == "pdf":
        data = (TEST_DIR / inputs).read_bytes()
        return {"type": "pdf", "pdfData": base64.b64encode(data).decode(), "fileName": Path(inputs).name}, f"{len(data)//1024} KB PDF"
    if kind == "text":
        text = (TEST_DIR / inputs).read_text()
        body = {"type": "text", "text": text}
        layout = app_layout(text)
        if layout:
            body["layout"] = layout
        return body, f"{len(text)} chars" + (f", {len(layout)} layout lines" if layout else "")
    return {"type": "url", "url": inputs}, inputs


def chord_word_pairs(chordpro):
    """(chord, the word it sits on) for every chord in the lyrics."""
    pairs = []
    for line in chordpro.split("\n"):
        if line.startswith("{") or "|" in line:
            continue
        for m in re.finditer(r"\[([^\]]+)\]\s*([A-Za-z']*)", line):
            pairs.append((m.group(1), m.group(2).lower()))
    return pairs


def lyric_words(chordpro):
    text = "\n".join(l for l in chordpro.split("\n") if not l.startswith("{"))
    return re.findall(r"[a-z']+", re.sub(r"\[[^\]]+\]", "", text).lower())


def section_labels(chordpro):
    return re.findall(r"\{(?:start_of_\w+(?::\s*([^}]*))?|chorus)\}", chordpro)


def known_songs():
    if not KNOWN_SQL.exists():
        return {}
    sql = KNOWN_SQL.read_text()
    out = {}
    for m in re.finditer(r"\{title: ([^}]+)\}", sql):
        end = sql.find("$cb$", m.start())
        out.setdefault(m.group(1).strip(), sql[m.start():end])
    return out


def norm_title(t):
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower().replace("10000", "10,000"))


def grade_against_known(result, known):
    """Compares an import with the owner's finished sheet of the same song."""
    mine, theirs = result["chordpro"], known
    words = difflib.SequenceMatcher(None, lyric_words(mine), lyric_words(theirs)).ratio()
    chords_a = [c for c, _ in chord_word_pairs(mine)]
    chords_b = [c for c, _ in chord_word_pairs(theirs)]
    chords = difflib.SequenceMatcher(None, chords_a, chords_b).ratio()
    placed = difflib.SequenceMatcher(None, chord_word_pairs(mine), chord_word_pairs(theirs)).ratio()
    key_b = (re.search(r"\{key: ([^}]+)\}", theirs) or [None, ""])[1]
    capo_b = int((re.search(r"\{capo: (\d+)\}", theirs) or [None, "0"])[1])
    return {
        "lyrics_match": round(words, 2),
        "chord_order_match": round(chords, 2),
        "chord_placement_match": round(placed, 2),
        "key": f"{result.get('key')} (library {key_b})",
        "capo": f"{result.get('capo')} (library {capo_b})",
    }


def checks(result):
    """Goal checks that apply to every sheet."""
    pro = result["chordpro"]
    problems = []
    title = result.get("title") or ""
    if not title or title.isupper() or title.lower() in ("imported song", "untitled song"):
        problems.append(f"title looks wrong: {title!r}")
    if re.search(r"\brefrain\b", pro, re.I) and "{start_of" in pro:
        if re.search(r"\{start_of_\w+:[^}]*refrain", pro, re.I):
            problems.append("uses Refrain instead of Chorus")
    if re.search(r"x\d{5}|\d{6}\b|CCLI|copyright|©|submitted by|view lyrics", pro, re.I):
        problems.append("kept site clutter (voicings, CCLI, credits)")
    if not result.get("form"):
        problems.append("no Form line")
    if not result.get("tempo"):
        problems.append("no tempo")
    sections = re.findall(r"\{start_of_(\w+)(?::\s*([^}]*))?\}([\s\S]*?)\{end_of_\w+\}", pro)
    verses = [(lbl, body) for kind, lbl, body in sections if kind == "verse"]
    bare = [lbl or "Verse" for lbl, body in verses if body.strip() and "[" not in body]
    if bare:
        problems.append(f"verses with no chords: {', '.join(bare)}")
    return problems


def run_case(case, base, key, token):
    cid, what, kind, inputs, known = case
    body, size = request_body(kind, inputs)
    t0 = time.time()
    status, data = http("POST", f"{base}/functions/v1/import-sheet",
                        {"apikey": key, "Authorization": f"Bearer {token}"}, body, timeout=400)
    secs = time.time() - t0
    return {"id": cid, "what": what, "kind": kind, "input": size, "seconds": round(secs, 1),
            "http": status, "data": data, "known": known}


def save_to_account(base, key, token, outcome):
    """Replaces this case's songs in the test account with the new results."""
    headers = {"apikey": key, "Authorization": f"Bearer {token}", "Prefer": "return=minimal"}
    source = f"Import test: {outcome['id']}"
    http("DELETE", f"{base}/rest/v1/cb_songs?source=eq.{urllib.parse.quote(source)}", headers)
    saved = 0
    for r in outcome["results"]:
        row = {
            "title": r["title"], "artist": r.get("artist") or "", "chordpro": r["chordpro"],
            "key": r.get("key") or "G", "capo": r.get("capo") or 0, "tempo": r.get("tempo"),
            "time_signature": r.get("time_signature") or "4/4", "tuning": r.get("tuning") or "E A D G B E",
            "tags": ["import-test"], "source": source,
            "notes": f"Form: {r['form']}" if r.get("form") else (r.get("notes") or ""),
            "layout_prefs": {"page_mode": "1-sheet", "columns": "auto", "compact_chorus": False, "show_diagrams": False,
                             "font_offset": 0, "accidental_pref": "auto", "sidebar_notes": {}, "genre": r.get("genre") or "pop"},
        }
        status, data = http("POST", f"{base}/rest/v1/cb_songs", headers, row)
        if status in (200, 201, 204):
            saved += 1
        else:
            print(f"   save failed for {r['title']!r}: HTTP {status} {str(data)[:200]}")
    return saved


def report(outcomes, run_dir):
    known = known_songs()
    lines = [f"# AI import test, {run_dir.name}", ""]
    for o in outcomes:
        data = o["data"] if isinstance(o["data"], dict) else {}
        results = data.get("results") or ([data["result"]] if data.get("result") else [])
        o["results"] = results
        d = o["data"] if isinstance(o.get("data"), dict) else {}
        placed = f" · chords placed by {d['placed_by']} ({d.get('layout_lines', 0)} source lines)" if d.get("placed_by") else ""
        head = f"## {o['id']}: {o['what']}\n{o['input']} · {o['seconds']}s · HTTP {o['http']}{placed}"
        if data.get("error") or not results:
            lines += [head, f"**FAILED:** {data.get('error') or o['data']}", ""]
            continue
        lines.append(head + (f" · {data.get('missed')} song(s) missed" if data.get("missed") else ""))
        for r in results:
            labels = [l or "(chorus repeat)" for l in section_labels(r["chordpro"])]
            lines.append(f"- **{r['title']}** — {r.get('artist')} · key {r.get('key')} capo {r.get('capo')} · "
                         f"{r.get('genre')} · {r.get('tempo')} BPM {r.get('time_signature')} · {r.get('tuning')}")
            lines.append(f"  - Form: {r.get('form')}")
            lines.append(f"  - Sections: {' | '.join(labels)}")
            for p in checks(r):
                lines.append(f"  - ⚠ {p}")
            match = next((k for k in known if norm_title(k) == norm_title(r["title"])), None)
            if match is None:
                match = next((k for k in o["known"] if difflib.SequenceMatcher(None, norm_title(k), norm_title(r["title"])).ratio() > 0.7), None)
            if match and match in known:
                g = grade_against_known(r, known[match])
                lines.append(f"  - vs library: lyrics {g['lyrics_match']}, chord order {g['chord_order_match']}, "
                             f"chord placement {g['chord_placement_match']}, key {g['key']}, capo {g['capo']}")
        lines.append("")
    (run_dir / "report.md").write_text("\n".join(lines))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spend", action="store_true", help="required: this makes paid AI calls")
    ap.add_argument("--only", default="", help="run cases whose id contains this text (comma-separated for several)")
    ap.add_argument("--no-save", action="store_true", help="don't save results to the test account")
    ap.add_argument("--grade-only", default="", help="re-grade a saved run folder without calling the AI")
    args = ap.parse_args()

    if args.grade_only:
        run_dir = Path(args.grade_only)
        outcomes = json.loads((run_dir / "outcomes.json").read_text())
        print(report(outcomes, run_dir))
        return
    if not args.spend:
        sys.exit("This makes paid AI calls. Re-run with --spend.")

    base, key, email, password = config()
    token = sign_in(base, key, email, password)
    cases = [c for c in CASES if any(o.strip() in c[0] for o in args.only.split(","))]
    run_dir = RUNS / datetime.datetime.now().strftime("import-%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    print(f"Running {len(cases)} case(s) → {run_dir.relative_to(ROOT)}")

    outcomes = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(run_case, c, base, key, token): c for c in cases}
        for fut in concurrent.futures.as_completed(futures):
            o = fut.result()
            d = o["data"] if isinstance(o["data"], dict) else {}
            n = len(d.get("results") or ([1] if d.get("result") else []))
            print(f"  {o['id']}: {o['seconds']}s, {n} song(s){'' if n else ' — ' + str(d.get('error') or o['data'])[:160]}")
            outcomes.append(o)
    order = [c[0] for c in cases]
    outcomes.sort(key=lambda o: order.index(o["id"]))
    text = report(outcomes, run_dir)
    (run_dir / "outcomes.json").write_text(json.dumps(outcomes, indent=1))
    for o in outcomes:
        for i, r in enumerate(o.get("results") or []):
            (run_dir / f"{o['id']}-{i + 1}.chordpro").write_text(r["chordpro"])

    if not args.no_save:
        token = sign_in(base, key, email, password)
        total = sum(save_to_account(base, key, token, o) for o in outcomes if o.get("results"))
        print(f"Saved {total} song(s) to the test account (tag import-test).")
    print("\n" + text)


if __name__ == "__main__":
    main()
