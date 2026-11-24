#!/usr/bin/env python3
"""Edge Function policy + Chord Net validation harness (no backend, no spend).

Verifies:
1. supabase/functions/import-sheet/index.ts follows all House Index security & cost policies:
   - Reads SUPABASE_PUBLISHABLE_KEYS (no legacy SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY)
   - Enforces daily cap via increment_ai_usage and fails closed with LIMIT_CHECK_FAILED
   - Logs every paid AI call via log_ai_call with token counts
   - Uses parseAllowedUrl, resolvesPublic, and readCapped for link safety
2. Extracts the real ==== CHORD NET ==== TypeScript block, strips types, and runs it in headless Chrome
   against valid and invalid AI outputs.
"""

import html
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FUNC_PATH = ROOT / "supabase" / "functions" / "import-sheet" / "index.ts"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BLOCK_RE = re.compile(r"// ==== CHORD NET ====\n.*?// ==== END CHORD NET ====\n", re.S)


def strip_ts_types(ts: str) -> str:
    js = ts
    # Remove multi-line parameter type annotations on validateSheetOutput
    js = re.sub(
        r"function validateSheetOutput\(sheet:\s*\{[\s\S]*?\}\):\s*string\[\]\s*\{",
        "function validateSheetOutput(sheet) {",
        js,
    )
    js = re.sub(r"function isValidChordToken\(token:\s*string\):\s*boolean\s*\{", "function isValidChordToken(token) {", js)
    js = re.sub(r":\s*string\[\]\s*=", " =", js)
    return js


def main():
    src = FUNC_PATH.read_text(encoding="utf-8")
    results = []

    def check(name, cond, detail=""):
        results.append({"name": name, "pass": bool(cond), "detail": str(detail)})

    # 1. Policy checks
    check("Uses SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_PUBLISHABLE_KEYS" in src)
    check("No legacy SUPABASE_ANON_KEY or SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY" not in src and "SUPABASE_SERVICE_ROLE_KEY" not in src)
    check("Enforces increment_ai_usage daily cap", 'rpc("increment_ai_usage"' in src)
    check("Fails closed with LIMIT_CHECK_FAILED", "LIMIT_CHECK_FAILED" in src and "typeof capCount !== \"number\"" in src)
    check("Logs AI calls with token usage via log_ai_call", 'rpc("log_ai_call"' in src and "p_input_tokens" in src)
    check("Logs the caller's user id like House Index", "p_user_id: userId" in src)
    check("Returns genre, tuning, form, and tempo for the sheet",
          all(f in src for f in ('genre:', 'tuning:', 'form:', 'tempo:')) and '"chorus_repeat"' in src)
    check("A repeated chorus may have no lines", 'sec.type === "chorus_repeat") continue' in src)
    check("No real lyrics in the prompt (made-up examples only)", "Rivers run" in src and "slit" not in src)
    check("Puts chords back where the source has them before checking",
          "// ==== LAYOUT ====" in src and src.count("realignToLayout(attempt.toolInput.sections, layout, isValidChordToken)") == 2
          and "pdfLayoutLines(bytes)" in src and "snapLayoutLine(l)" in src)
    check("Daily limit skips only accounts listed in the CB_UNLIMITED_EMAILS secret",
          'Deno.env.get("CB_UNLIMITED_EMAILS")' in src and "if (!unlimited) {" in src and "@" not in src.split("CB_UNLIMITED_EMAILS")[1][:400])
    check("Retries once when the AI is busy", "[429, 500, 502, 503, 529].includes(res.status)" in src and '"BUSY"' in src)
    check("Accepts A2 and Asus4-style chord names", "|6\\/9|69|6|5|4|2)?" in src)
    check("Uses SSRF safety helpers (parseAllowedUrl, resolvesPublic, readCapped)",
          "parseAllowedUrl(" in src and "resolvesPublic(" in src and "readCapped(" in src)
    check("Supports text, multi-snip image, PDF document, and url modes",
          'reqType === "text"' in src and 'reqType === "image"' in src and 'reqType === "pdf"' in src and 'type: "document"' in src)

    # 2. Extract and run real CHORD NET block in headless Chrome
    m = BLOCK_RE.search(src)
    if not m:
        print("FAIL: Missing ==== CHORD NET ==== block in import-sheet/index.ts", file=sys.stderr)
        sys.exit(2)

    js_net = strip_ts_types(m.group(0))
    page_html = f"""<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
{js_net}

const R = [];
function ok(name, cond, detail = "") {{
  R.push({{ name, pass: !!cond, detail: String(detail) }});
}}

// Good sheet passes
const goodSheet = {{
  title: "Wildflower Road",
  key: "G",
  capo: 2,
  sections: [
    {{
      type: "verse",
      label: "Verse 1",
      lines: [
        {{ text: "[G]Light the [G/B]way for [C]night, [G]Mary.", tab: false }},
        {{ text: "Walk the long dirt [C]road [Dsus4]back [D]home. [G]", tab: false }}
      ]
    }}
  ]
}};
const goodProblems = validateSheetOutput(goodSheet);
ok("Chord Net accepts valid sheet", goodProblems.length === 0, JSON.stringify(goodProblems));

// Bad chord tokens inside brackets are caught
const badChordsSheet = {{
  title: "Bad Sheet",
  key: "G",
  sections: [
    {{
      type: "verse",
      label: "Verse 1",
      lines: [
        {{ text: "[G]Hello [Hmaj7]world [Verse 2]", tab: false }}
      ]
    }}
  ]
}};
const badProblems = validateSheetOutput(badChordsSheet);
ok("Chord Net rejects invalid chord tokens [Hmaj7] and [Verse 2]",
   badProblems.some(p => p.includes("Hmaj7") && p.includes("Verse 2")),
   JSON.stringify(badProblems));

// Empty section is caught
const emptySecSheet = {{
  title: "Empty Sec",
  key: "C",
  sections: [{{ type: "chorus", label: "Chorus", lines: [] }}]
}};
const emptyProblems = validateSheetOutput(emptySecSheet);
ok("Chord Net rejects empty section", emptyProblems.some(p => p.includes("Empty section")), JSON.stringify(emptyProblems));

document.getElementById("out").textContent = JSON.stringify(R);
</script>"""

    with tempfile.TemporaryDirectory() as tmp:
        p = pathlib.Path(tmp) / "net.html"
        p.write_text(page_html, encoding="utf-8")
        dom = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=2000", "--dump-dom", p.as_uri()],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout

    out_m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not out_m or not out_m.group(1).strip():
        print("FAIL: Chrome did not run Chord Net:\n", dom, file=sys.stderr)
        sys.exit(2)

    results.extend(json.loads(html.unescape(out_m.group(1))))
    failed = [r for r in results if not r["pass"]]
    for r in results:
        status = "PASS" if r["pass"] else "FAIL"
        print(f"[{status}] {r['name']}" + (f" — {r['detail']}" if not r["pass"] else ""))
    print(f"\nedge_function_policy_test: {len(results) - len(failed)}/{len(results)} passed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
