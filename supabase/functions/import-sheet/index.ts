// Supabase Edge Function: import-sheet
//
// Accepts messy/ugly pasted chord text, 1-6 screenshot snips / camera photos,
// a PDF document upload, or a public link. Uses Claude Sonnet 4.6 for everything:
// rebuilding a messy paste into clean lines is the hard part, and imports are rare.
// Validates output through the Chord Net (every [chord] token parses under
// the Chord Book grammar; sections non-empty) and repairs once if needed.
//
// Request body (JSON):
//   { type: "text", text: "<pasted text>", note?: "<optional steer>" }
//   { type: "image", images: [{ mediaType: "image/jpeg"|"image/png"|"image/webp", data: "<base64>" }], note?: "<optional steer>" }
//   { type: "pdf", pdfData: "<base64>", fileName?: "...", note?: "<optional steer>" }
//   { type: "url", url: "<public sheet page>", note?: "<optional steer>" }
//
// Response: always HTTP 200 with
//   { result: { title, artist, key, capo, tempo, time_signature, tuning, genre, form, chordpro, notes } }
// or { error: "..." }

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL_TEXT = "claude-sonnet-4-6";
const MODEL_VISION = "claude-sonnet-4-6";
const DAILY_IMPORT_LIMIT = 20;
const LIMIT_CHECK_FAILED = "Couldn’t check today’s limit — try again in a minute.";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_IMAGES = 6;
const MAX_NOTE_CHARS = 350;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
function supabaseClientKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const key = typeof keys.default === "string"
      ? keys.default
      : Object.values(keys).find((v) => typeof v === "string");
    if (key) return key as string;
  } catch { /* not JSON */ }
  console.error("SUPABASE_PUBLISHABLE_KEYS is missing — database calls will fail.");
  return "";
}
const SUPABASE_CLIENT_KEY = supabaseClientKey();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

// ==== CHORD NET ====
const NOTE_NAMES = new Set([
  "C", "B#", "C#", "Db", "D", "D#", "Eb", "E", "Fb", "F", "E#",
  "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B", "Cb"
]);
const QUALITY_RE = /^(?:maj13|maj11|maj9|maj7|M7|Δ7|Δ|min11|min9|min7b5|min7|min6|min|m13|m11|m9|m7b5|m7|m6|mmaj7|m|-(?:7|9|11)?|dim7|dim|°7|°|ø7|ø|aug7|aug|\+7|\+|sus2sus4|sus4|sus2|sus|add11|add9|add4|add2|7sus4|7sus2|9sus4|13|11|9|7|6\/9|69|6|5)?(?:(?:\(?[b#](?:5|9|11|13)\)?)*)$/;
const ROOT_RE = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/;

function isValidChordToken(token: string): boolean {
  if (!token || typeof token !== "string") return false;
  const trimmed = token.trim();
  if (trimmed === "N.C." || trimmed === "NC") return true;
  const m = trimmed.match(ROOT_RE);
  if (!m) return false;
  const [, root, quality, bass] = m;
  if (!NOTE_NAMES.has(root)) return false;
  if (bass && !NOTE_NAMES.has(bass)) return false;
  return QUALITY_RE.test(quality || "");
}

function validateSheetOutput(sheet: {
  title?: string;
  key?: string;
  capo?: number;
  sections?: Array<{ type?: string; label?: string | null; lines?: Array<{ text?: string; tab?: boolean }> }>;
}): string[] {
  const problems: string[] = [];
  if (!sheet || typeof sheet !== "object") return ["Missing sheet output"];
  if (!sheet.title || !String(sheet.title).trim()) problems.push("Missing song title");
  if (!sheet.key || !isValidChordToken(String(sheet.key).trim())) {
    problems.push(`Invalid or missing key: ${sheet.key}`);
  }
  const sections = Array.isArray(sheet.sections) ? sheet.sections : [];
  if (sections.length === 0) {
    problems.push("Sheet has no sections");
  }
  let totalLines = 0;
  const badChords: string[] = [];
  for (const sec of sections) {
    const lines = Array.isArray(sec.lines) ? sec.lines : [];
    if (sec.type === "chorus_repeat") continue;
    if (lines.length === 0) {
      problems.push(`Empty section "${sec.label || sec.type || "section"}"`);
    }
    for (const l of lines) {
      totalLines++;
      const txt = String(l.text || "");
      if (l.tab) continue;
      const re = /\[([^\]]+)\]/g;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const tok = m[1].trim();
        if (!isValidChordToken(tok) && !badChords.includes(tok)) {
          badChords.push(tok);
        }
      }
    }
  }
  if (totalLines > 200) {
    problems.push(`Too many lines (${totalLines}, max 200)`);
  }
  if (badChords.length > 0) {
    problems.push(`Invalid chord tokens inside brackets: ${badChords.join(", ")}`);
  }
  return problems;
}
// ==== END CHORD NET ====

const TUNING_VALUES: Record<string, string> = {
  standard: "E A D G B E",
  half: "Eb Ab Db Gb Bb Eb",
  drop_d: "D A D G B E",
  other: "Other"
};
const GENRES = ["worship", "country", "rock", "pop"];

// Convert validated structured sheet JSON into canonical ChordPro
function sheetToChordPro(sheet: {
  title: string;
  artist?: string | null;
  key: string;
  capo?: number;
  tempo?: number | null;
  time_signature?: string | null;
  tuning?: string | null;
  sections: Array<{
    type: string;
    label?: string | null;
    sidebar_note?: string | null;
    lines: Array<{ text: string; tab?: boolean }>;
  }>;
}): string {
  const out: string[] = [];
  out.push(`{title: ${sheet.title.trim()}}`);
  if (sheet.artist && sheet.artist.trim()) out.push(`{artist: ${sheet.artist.trim()}}`);
  if (sheet.key && sheet.key.trim()) out.push(`{key: ${sheet.key.trim()}}`);
  if (sheet.capo && sheet.capo > 0) out.push(`{capo: ${sheet.capo}}`);
  if (sheet.tempo && sheet.tempo > 0) out.push(`{tempo: ${sheet.tempo}}`);
  if (sheet.time_signature && sheet.time_signature.trim()) out.push(`{time: ${sheet.time_signature.trim()}}`);
  const tuning = TUNING_VALUES[sheet.tuning || "standard"];
  if (tuning && tuning !== TUNING_VALUES.standard) out.push(`{tuning: ${tuning}}`);
  out.push("");

  sheet.sections.forEach((sec, idx) => {
    const t = (sec.type || "verse").toLowerCase();
    if (t === "chorus_repeat") {
      out.push("{chorus}");
      if (idx < sheet.sections.length - 1) out.push("");
      return;
    }
    const tag = ["verse", "chorus", "bridge", "intro", "outro", "instrumental", "pre_chorus", "tab"].includes(t) ? t : "verse";
    const label = sec.label ? sec.label.trim() : "";
    out.push(label ? `{start_of_${tag}: ${label}}` : `{start_of_${tag}}`);
    if (sec.sidebar_note && sec.sidebar_note.trim()) {
      out.push(`{note: ${sec.sidebar_note.trim()}}`);
    }
    for (const l of sec.lines || []) {
      if (l.text == null) continue;
      const text = String(l.text);
      // A line that is only a note in parentheses, like "(Repeat 4x)", prints as a comment.
      if (!l.tab && /^\((?:repeat|x\d|\d+x)[^)]*\)$/i.test(text.trim())) {
        out.push(`{comment: ${text.trim().slice(1, -1)}}`);
      } else {
        out.push(text);
      }
    }
    out.push(`{end_of_${tag}}`);
    if (idx < sheet.sections.length - 1) out.push("");
  });
  return out.join("\n");
}

// URL safety helpers (copied from House Index)
function parseAllowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes("[")) return null;
  const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return null;
    }
  }
  return url;
}

function isPrivateAddress(addr: string): boolean {
  const v4 = addr.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const low = addr.toLowerCase();
  return low === "::1" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd");
}

async function resolvesPublic(host: string): Promise<boolean> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateAddress(host);
  const resolve = (Deno as unknown as { resolveDns?: (q: string, t: "A" | "AAAA") => Promise<string[]> }).resolveDns;
  if (typeof resolve !== "function") return true;
  const lookups = await Promise.allSettled([resolve(host, "A"), resolve(host, "AAAA")]);
  const addrs = lookups.flatMap((r) => (r.status === "fulfilled" ? (r.value as string[]) : []));
  if (!addrs.length) return true;
  return addrs.every((a) => !isPrivateAddress(a));
}

const MAX_PAGE_BYTES = 5_000_000;
async function readCapped(res: Response, maxBytes = MAX_PAGE_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total >= maxBytes) await reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, buf.length - off);
    buf.set(c.subarray(0, n), off);
    off += n;
    if (off >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

const SHEET_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Song title only (not the artist, album, or site name)" },
    artist: { type: ["string", "null"] },
    key: { type: "string", description: "Key of the chord shapes as written, e.g. 'G', 'D', 'Em', 'Bb'" },
    capo: { type: "integer", description: "Capo fret 0-12 (0 if none)" },
    tuning: { type: "string", enum: ["standard", "half", "drop_d", "other"], description: "'half' = half step down (Eb tuning)" },
    tempo: { type: "integer", description: "Beats per minute. Use the stated tempo; otherwise the tempo of the well-known recording; otherwise your best estimate for the style." },
    time_signature: { type: "string", description: "e.g. '4/4', '3/4', '6/8'" },
    genre: { type: "string", enum: ["worship", "country", "rock", "pop"], description: "worship = Christian worship or hymns; country = country and folk; rock = rock, punk, emo, indie, alternative; pop = everything else" },
    form: { type: "string", description: "The order the song is played, e.g. 'Intro (4x) • V1 • Chorus • V2 • Chorus • Bridge (2x) • Chorus • Outro'" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["verse", "chorus", "chorus_repeat", "pre_chorus", "bridge", "intro", "outro", "instrumental", "tab"] },
          label: { type: ["string", "null"], description: "e.g. 'Intro (4x)', 'Verse 1', 'Chorus', 'Bridge (2x)'" },
          sidebar_note: { type: ["string", "null"], description: "Short playing cue from the source for this section, e.g. 'Palm muted', 'Bass comes in'" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "One sung line with each [Chord] directly before the syllable it is played on, e.g. '[G]Rivers run [C]down to the [D]sea'. Chord-only lines look like '[G]   [C]   [D]'." },
                tab: { type: "boolean" }
              },
              required: ["text", "tab"]
            }
          }
        },
        required: ["type", "label", "sidebar_note", "lines"]
      }
    },
    notes: { type: ["string", "null"], description: "Anything a player needs that isn't in a section, or null" }
  },
  required: ["title", "artist", "key", "capo", "tuning", "tempo", "time_signature", "genre", "form", "sections", "notes"]
};

const SYSTEM_PROMPT = `You turn guitar chord sheets into clean Chord Book sheets. People read them while playing guitar and singing, so every chord must sit on the right word and every line must read like the song.

The input may be a messy copy from a chord website, screenshots, a photo, a PDF, or an existing sheet to check.

READ THE MESS:
- Phone copies from sites like Chordie or AZChords put each chord and the word under it on separate lines, and break one sung line into many short pieces. A chord on its own line belongs on the word right after it. Put the pieces back into the original sung lines, about one phrase per line.
- Drop site clutter: album names, years, "this is 100% correct", ratings, chord voicing lists like "D - x57775", fret numbers, ads, and page buttons.
- Sites often list the artist first, then the title. Return the song title as title and the band or singer as artist.
- Read "Key:", "Capo:", tuning notes ("half step down", "Eb tuning", "Drop D"), and tempo when given.

KEEP IT FAITHFUL:
- Never change, add, or simplify chords. Never rewrite lyrics. Keep backing vocals in parentheses as their own lines.
- A dashed chord run like "A/C#-D" means quick changes: write it as "[A/C#] [D]".
- "G (hold)" means hold that chord: put [G] on the next word and keep "(hold)" right after it.
- Every [ ] holds only a real chord, like [G], [G/B], [Dsus4], [F#m], [Am7]. Section names never go in brackets.
- Place each chord before the stressed syllable it is played on. A chord in the middle of a word goes in the middle: "un[Bm]less".

ORGANIZE IT:
- One section per part, in the order it is played, labeled Intro, Verse 1, Verse 2, Pre-Chorus, Chorus, Bridge, Outro, or Interlude. Always call the chorus "Chorus", never "Refrain".
- Write the chorus out in full the first time. Each later time it is played, add a section of type "chorus_repeat" with no lines. Do this for "(Repeat Chorus)" notes too.
- When a whole section repeats, put the count in its label: "Bridge (2x)". When only some lines repeat, add a line "(Repeat 4x)" after them.
- Notes after a section name, like "Intro: ... Palm muted" or "Verse 1: Bass will enter", become that section's sidebar_note. Chords written after "Intro:" become the intro's chord line.
- "form" lists every section as played, using V1, V2 for verses and "Chorus" for each chorus, with repeat counts.`;

// Same RPC and token accounting as House Index (supabase/sql/v1.9-part1.sql). Never throws.
// deno-lint-ignore no-explicit-any
async function logAiCall(client: any, task: string, model: string, valid: boolean, ms: number, usage?: any, userId?: string) {
  try {
    const input = usage?.input_tokens;
    const { error } = await client.rpc("log_ai_call", {
      p_task: task,
      p_model: model,
      p_valid: valid,
      p_latency_ms: Math.round(ms),
      p_escalated: false,
      p_input_tokens: input == null ? null : input + (usage?.cache_creation_input_tokens ?? 0),
      p_output_tokens: usage?.output_tokens ?? null,
      p_cache_read_tokens: usage?.cache_read_input_tokens ?? null,
      p_web_searches: null,
      p_user_id: userId ?? null
    });
    if (error) console.error("log_ai_call failed:", error.message ?? error);
  } catch (e) {
    console.error("log_ai_call failed:", e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" });

  // 1. Check caller is signed in before anything paid
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Please sign in to use AI import." });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_CLIENT_KEY, {
    global: { headers: { Authorization: authHeader } }
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Please sign in to use AI import." });
  }
  const userId = userData.user.id;

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "AI import is not configured on this server (missing ANTHROPIC_API_KEY)." });
  }

  // 2. Validate input before checking cap
  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON request body." });
  }

  const reqType = String(body?.type || "");
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE_CHARS) : "";
  // deno-lint-ignore no-explicit-any
  const userContent: any[] = [];
  let model = MODEL_TEXT;

  if (reqType === "text") {
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length < 10) return json({ error: "Paste a chord sheet first." });
    if (text.length > 40_000) return json({ error: "Pasted text is too long (max 40,000 characters)." });
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") + `Transcribe and align this chord sheet:\n\n${text}`
    });
    model = MODEL_TEXT;
  } else if (reqType === "image") {
    const imgs = Array.isArray(body?.images) ? body.images : [];
    if (!imgs.length || imgs.length > MAX_IMAGES) {
      return json({ error: `Attach between 1 and ${MAX_IMAGES} images.` });
    }
    for (const img of imgs) {
      if (!ALLOWED_IMAGE_TYPES.includes(img?.mediaType) || typeof img?.data !== "string" || !img.data) {
        return json({ error: "Unsupported image format (use JPEG, PNG, or WebP)." });
      }
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data }
      });
    }
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") +
        "Transcribe the guitar chord sheet from these image(s). If multiple screenshots overlap, stitch and deduplicate them into one complete song with exact [Chord] placement over each syllable."
    });
    model = MODEL_VISION;
  } else if (reqType === "pdf") {
    const pdfData = typeof body?.pdfData === "string" ? body.pdfData.trim() : "";
    if (!pdfData) return json({ error: "Attach a PDF file first." });
    if (pdfData.length > 7_500_000) return json({ error: "PDF is too large (max 5 MB)." });
    userContent.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfData }
    });
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") +
        "Transcribe the guitar chord sheet from this PDF into structured sections with inline [Chord] placement."
    });
    model = MODEL_VISION;
  } else if (reqType === "url") {
    const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";
    const url = parseAllowedUrl(rawUrl);
    if (!url || !(await resolvesPublic(url.hostname))) {
      return json({ error: "That doesn’t look like a valid public link." });
    }
    let pageHtml = "";
    try {
      const pageRes = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ChordBook/0.1)",
          "Accept": "text/html,text/plain"
        }
      });
      const landed = pageRes.redirected ? parseAllowedUrl(pageRes.url) : url;
      if (!landed || (pageRes.redirected && !(await resolvesPublic(landed.hostname)))) {
        await pageRes.body?.cancel();
        return json({ error: "That link redirects somewhere we can’t read — copy and paste the sheet instead." });
      }
      pageHtml = await readCapped(pageRes);
      if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
    } catch {
      return json({ error: "Couldn’t load that page — copy the chords and paste them instead." });
    }
    const stripped = pageHtml
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .slice(0, 25_000);
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") + `Extract the chord sheet from this page:\n\n${stripped}`
    });
    model = MODEL_TEXT;
  } else {
    return json({ error: "Unsupported import type." });
  }

  // 3. Check daily cap right before paid call (fail closed!)
  const { data: capCount, error: capErr } = await supabase.rpc("increment_ai_usage", {
    usage_kind: "cb_import",
    daily_limit: DAILY_IMPORT_LIMIT
  });
  if (capErr || typeof capCount !== "number") {
    console.error("increment_ai_usage failed:", capErr);
    return json({ error: LIMIT_CHECK_FAILED });
  }
  if (capCount < 0) {
    return json({ error: `You’ve reached today’s limit of ${DAILY_IMPORT_LIMIT} AI imports. Free paste import still works anytime.` });
  }

  // 4. Call Anthropic with tool schema + Chord Net validation + 1 repair attempt
  // deno-lint-ignore no-explicit-any
  async function callClaude(messages: any[]) {
    const t0 = performance.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model,
        // Billed on actual output, so a long song's headroom costs nothing extra.
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: [{
          name: "save_chord_sheet",
          description: "Return the transcribed guitar chord sheet",
          input_schema: SHEET_SCHEMA
        }],
        tool_choice: { type: "tool", name: "save_chord_sheet" },
        messages
      })
    });
    const ms = performance.now() - t0;
    const payload = await res.json();
    if (!res.ok) {
      await logAiCall(supabase, "cb_import", model, false, ms, payload?.usage, userId);
      throw new Error(payload?.error?.message || `Anthropic HTTP ${res.status}`);
    }
    if (payload?.stop_reason === "refusal") throw new Error("REFUSED");
    if (payload?.stop_reason === "max_tokens") throw new Error("TOO_LONG");
    // deno-lint-ignore no-explicit-any
    const toolBlock = (payload?.content || []).find((b: any) => b.type === "tool_use" && b.name === "save_chord_sheet");
    return { toolInput: toolBlock?.input || null, usage: payload?.usage, ms, stopReason: payload?.stop_reason };
  }

  try {
    // deno-lint-ignore no-explicit-any
    const messages: any[] = [{ role: "user", content: userContent }];
    let attempt = await callClaude(messages);
    let problems = validateSheetOutput(attempt.toolInput);
    await logAiCall(supabase, "cb_import", model, problems.length === 0, attempt.ms, attempt.usage, userId);

    if (problems.length > 0 && attempt.toolInput) {
      // Repair once
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: "repair_1", name: "save_chord_sheet", input: attempt.toolInput }]
      });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "repair_1",
          content: `Validation failed: ${problems.join("; ")}. Fix every problem and call save_chord_sheet again.`
        }]
      });
      attempt = await callClaude(messages);
      problems = validateSheetOutput(attempt.toolInput);
      await logAiCall(supabase, "cb_import_repair", model, problems.length === 0, attempt.ms, attempt.usage, userId);
    }

    if (problems.length > 0 || !attempt.toolInput) {
      return json({ error: `Couldn’t validate the transcribed chords (${problems.join(", ")}). Try pasting the text directly.` });
    }

    const sheet = attempt.toolInput;
    const chordpro = sheetToChordPro(sheet);
    const tempo = Number(sheet.tempo);
    return json({
      result: {
        title: sheet.title,
        artist: sheet.artist,
        key: sheet.key,
        capo: sheet.capo || 0,
        tempo: tempo >= 20 && tempo <= 300 ? Math.round(tempo) : null,
        time_signature: sheet.time_signature || "4/4",
        tuning: TUNING_VALUES[sheet.tuning] || TUNING_VALUES.standard,
        genre: GENRES.includes(sheet.genre) ? sheet.genre : "pop",
        form: typeof sheet.form === "string" ? sheet.form.replace(/^form:\s*/i, "").trim() : "",
        notes: sheet.notes,
        chordpro
      }
    });
  } catch (err) {
    console.error("import-sheet error:", err);
    const msg = err instanceof Error ? err.message : "";
    if (msg === "REFUSED") return json({ error: "The AI declined to read that. Try the pasted text instead." });
    if (msg === "TOO_LONG") return json({ error: "That song was too long to read in one go. Try pasting it in two parts." });
    return json({ error: "The AI couldn’t read that. Try again, or the app can format it without AI." });
  }
});
