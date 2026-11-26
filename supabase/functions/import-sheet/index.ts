// Supabase Edge Function: import-sheet
//
// Accepts messy/ugly pasted chord text, 1-6 screenshot snips / camera photos,
// a PDF document upload, or a public link.
//
// Architecture (v0.7.0 — Deterministic-First Track A + Sonnet 5.5 Track B):
// - Track A (Direct): Clean Ultimate Guitar links (using native `[ch]` tags) and
//   clean single-song digital text-layer PDFs (keeping section names + chord-only lines)
//   are built deterministically in code with zero AI lyric rewriting, plus an optional
//   tiny metadata-only call (no lyrics sent) for tempo/genre/time_signature. Falls back
//   to Track B whenever the direct parse looks weak or ambiguous.
// - Track B (AI): Photos, screenshots, scanned/multi-song PDFs, and mangled pastes use
//   Claude Sonnet 5.5 (`strict: true`, `tool_choice: { type: "auto" }`), dropping
//   redundant `placement` notes whenever exact source layout exists, and prompt-caching
//   multi-song PDFs across songs 2..N.
// - Melody range lookups default to Sonnet 5.5 and can be trialed with Haiku 5.5 via
//   the optional `CB_MELODY_MODEL` Supabase secret.
//
// Request body (JSON):
//   { type: "text", text: "<pasted text>", layout?: ["[G]lines with exact chord columns"], note?: "<optional steer>" }
//   { type: "image", images: [{ mediaType: "image/jpeg"|"image/png"|"image/webp", data: "<base64>" }], note?: "<optional steer>" }
//   { type: "pdf", pdfData: "<base64>", fileName?: "...", note?: "<optional steer>" }
//   { type: "url", url: "<public sheet page>", note?: "<optional steer>" }
//   { type: "melody", songs: [{ id, title, artist?, key? }] }   (up to 25; no lyrics are sent)
//
// Response: always HTTP 200 with
//   { result: { title, artist, key, capo, tempo, time_signature, tuning, genre, form, chordpro, notes },
//     results: [every song found; a set list PDF can hold several], missed: songs that couldn't be read }
// or { error: "..." }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { isValidChordToken, validateSheetOutput } from "./chord_net.ts";
import {
  TUNING_VALUES,
  GENRES,
  NOT_SONG_SECTION,
  chordColumns,
  layoutFromSourceText,
  snapLayoutLine,
  realignToLayout,
  restoreChangedChoruses,
  applyPlacementNotes,
  collapseWrittenRepeats,
  sheetToChordPro
} from "./layout.ts";
import { pageDataForImport, parseUgDirect } from "./ug.ts";
import { pdfExtract, parsePdfDirect } from "./pdf.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL_TEXT = "claude-sonnet-5-5";
const MODEL_VISION = "claude-sonnet-5-5";
// Optional Haiku 5.5 trial for melody lookups: set CB_MELODY_MODEL=claude-haiku-5-5 in Supabase secrets.
const ALLOWED_MELODY_MODELS = new Set(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-6"]);
const envMelodyModel = (Deno.env.get("CB_MELODY_MODEL") || "").trim();
const MODEL_MELODY = ALLOWED_MELODY_MODELS.has(envMelodyModel) ? envMelodyModel : MODEL_TEXT;
// Lightweight metadata-only call (no lyrics sent) uses Haiku 5.5 for speed & minimal cost.
const MODEL_META = "claude-haiku-5-5";

// These calls copy and look things up; they were tuned without extended thinking. Sonnet 5.5 and
// Haiku 5.5 think by default, and thinking tokens count against max_tokens, so turn it off
// explicitly: Sonnet 5.5 takes "between_tools" (its no-thinking mode, effort high or below);
// Haiku 5.5 takes "disabled" (effort high or below; its default is medium). Older models don't
// think unless asked.
function noThinking(model: string): Record<string, unknown> {
  if (model.startsWith("claude-sonnet-5-5")) return { thinking: { type: "between_tools" } };
  if (model.startsWith("claude-haiku-5-5")) return { thinking: { type: "disabled" } };
  return {};
}

const DAILY_IMPORT_LIMIT = 20;
// Accounts that skip the daily limit (the owner and the test account), set as the Supabase
// secret CB_UNLIMITED_EMAILS, comma-separated. Kept out of this public file.
const UNLIMITED_EMAILS = new Set(
  (Deno.env.get("CB_UNLIMITED_EMAILS") || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const LIMIT_CHECK_FAILED = "Couldn’t check today’s limit — try again in a minute.";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_IMAGES = 6;
const MAX_SONGS_PER_IMPORT = 8;
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

// ---------------------------------------------------------------------------
// Strict Tool Schemas (every object has `additionalProperties: false` for Sonnet 5.5 `strict: true`)
// ---------------------------------------------------------------------------
const PLACEMENT_FIELD = {
  type: "string",
  description: "Write this first. Each chord in the line, left to right, and the letters printed directly under its left edge to the end of that word: 'D over river, A over morning'. Part of a word for a chord inside a word: 'A over ter' for wa-ter. Use 'G at end' for a chord after the last word, and '' for a line with no chords."
};

const SOURCE_TEXT_FIELD = {
  type: "string",
  description: "Write this first. The chord sheet exactly as it appears, line by line in reading order (column one, then column two), each chord line directly above its lyric line, with spaces putting every chord over the exact letter it sits on, as in a monospaced chord chart. Include section names. Leave out clutter."
};

const MONOSPACED_FIELD = {
  type: "boolean",
  description: "Write this first. True when the sheet is set in a fixed-width (typewriter-style) font where letters line up in columns, as in most chord apps; false for ordinary printed type."
};

// Drops `placement` whenever exact source positions already exist (`withPlacement = false`),
// keeping it for photos and unstructured sources (`withPlacement = true`).
function schemaFor(withSource: boolean, withPlacement = true) {
  const lineProps = withPlacement
    ? {
        placement: PLACEMENT_FIELD,
        text: { type: "string", description: "The sung line with each [Chord] placed exactly as in placement, e.g. 'Down the [D]river in the [A]morning'. Chord-only lines look like '[G]   [C]   [D]'." },
        tab: { type: "boolean" }
      }
    : {
        text: { type: "string", description: "The sung line with inline [Chord] markers, e.g. 'Down the [D]river in the [A]morning'. Chord-only lines look like '[G]   [C]   [D]'." },
        tab: { type: "boolean" }
      };
  const lineRequired = withPlacement ? ["placement", "text", "tab"] : ["text", "tab"];

  const baseProps = {
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
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["verse", "chorus", "chorus_repeat", "pre_chorus", "bridge", "intro", "outro", "instrumental", "tab"] },
          label: { type: ["string", "null"], description: "e.g. 'Intro (4x)', 'Verse 1', 'Chorus', 'Bridge (2x)'" },
          sidebar_note: { type: ["string", "null"], description: "Short playing cue from the source for this section, e.g. 'Palm muted', 'Bass comes in'" },
          lines: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: lineProps,
              required: lineRequired
            }
          }
        },
        required: ["type", "label", "sidebar_note", "lines"]
      }
    },
    notes: { type: ["string", "null"], description: "Anything a player needs that isn't in a section, or null" },
    other_songs: { type: "array", items: { type: "string" }, description: "Titles of the other complete songs in the input, in order. Empty when the input is one song." }
  };

  const baseRequired = ["title", "artist", "key", "capo", "tuning", "tempo", "time_signature", "genre", "form", "sections", "notes", "other_songs"];

  if (!withSource) {
    return {
      type: "object",
      additionalProperties: false,
      properties: baseProps,
      required: baseRequired
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: { monospaced: MONOSPACED_FIELD, source_text: SOURCE_TEXT_FIELD, ...baseProps },
    required: ["monospaced", "source_text", ...baseRequired]
  };
}

// Lightweight metadata-only schema for Track A direct parses (zero lyrics sent).
const META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Clean song title in Title Case (no artist or site name)" },
    artist: { type: ["string", "null"], description: "Performing artist or hymn writers, or null" },
    tempo: { type: "integer", description: "Beats per minute for the well-known recording or style" },
    time_signature: { type: "string", description: "e.g. '4/4', '3/4', '6/8'" },
    genre: { type: "string", enum: ["worship", "country", "rock", "pop"] }
  },
  required: ["title", "artist", "tempo", "time_signature", "genre"]
};

const META_PROMPT = `Return clean song metadata (title in Title Case, performing artist, typical tempo BPM, time signature, and genre) for the named song. Always respond by calling the save_song_metadata tool.
- worship = Christian worship or hymns; country = country and folk; rock = rock, punk, emo, indie, alternative; pop = everything else.`;

// ---------------------------------------------------------------------------
// Melody range: the lowest and highest notes the lead singer sings, so the app can match songs
// to the player's real vocal range and not just their favourite keys.
// ---------------------------------------------------------------------------
const MAX_MELODY_SONGS = 25;
const MELODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    songs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "The id given for this song" },
          known: { type: "boolean", description: "True only if you know this song's sung melody well enough to name its lowest and highest notes" },
          recording_key: { type: ["string", "null"], description: "Key of the recording the notes come from, e.g. 'A', 'F#m', 'Bb'" },
          low_note: { type: ["string", "null"], description: "Lowest note of the lead vocal melody in scientific pitch, where C4 is middle C, e.g. 'A2', 'F#3'" },
          high_note: { type: ["string", "null"], description: "Highest note of the lead vocal melody, e.g. 'E4', 'Bb4'" },
          confidence: { type: "string", enum: ["high", "medium", "low"] }
        },
        required: ["id", "known", "recording_key", "low_note", "high_note", "confidence"]
      }
    }
  },
  required: ["songs"]
};

const MELODY_PROMPT = `You know the melodies of popular songs, hymns, and worship songs. For each song, give the lowest and highest notes of the lead vocal melody and the key it is sung in. Always return your answer by calling the save_melody_ranges tool.

- Use the best-known recording by the named artist. For a hymn, use the melody in its usual hymnal key.
- Count the main melody the lead singer sings, including chorus peaks and a final chorus that goes up. Leave out brief ad-libs, shouts, spoken parts, and backing vocals.
- Write notes in scientific pitch, where C4 is middle C. A man's melody usually sits between about G2 and A4, a woman's between about F3 and E5.
- The sheet's key is a hint for which arrangement is meant; the notes are still the recording's.
- If you don't know a song's melody well enough to name its notes, set known false and the notes null. Never guess from the title alone.`;

const NOTE_PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteToMidi(note: unknown): number | null {
  const m = String(note || "").trim().match(/^([A-Ga-g])([#b♯♭]?)(-?\d)$/);
  if (!m) return null;
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + NOTE_PITCH[m[1].toUpperCase()] + acc;
}
function cleanKey(key: unknown): string | null {
  const m = String(key || "").trim().match(/^([A-G])([#b]?)\s*(m|min|minor)?$/i);
  return m ? m[1].toUpperCase() + m[2] + (m[3] ? "m" : "") : null;
}
// deno-lint-ignore no-explicit-any
function melodyFromAi(item: any) {
  if (!item || item.known !== true) return null;
  const low = noteToMidi(item.low_note);
  const high = noteToMidi(item.high_note);
  const key = cleanKey(item.recording_key);
  if (low == null || high == null || !key || low < 33 || high > 88 || high <= low || high - low > 30) return null;
  return { id: String(item.id), recording_key: key, low, high, confidence: ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "low" };
}

const SYSTEM_PROMPT = `You turn guitar chord sheets into clean Chord Book sheets. People read them while playing guitar and singing, so every chord must sit on the right word and every line must read like the song. Always return your answer by calling the save_chord_sheet tool.

The input may be a messy copy from a chord website, screenshots, a photo, a PDF, or an existing sheet to check.

READ THE MESS:
- Phone copies from sites like Chordie or AZChords put each chord and the word under it on separate lines, and break one sung line into many short pieces. A chord on its own line belongs on the word right after it. Put the pieces back into the original sung lines, about one phrase per line.
- Drop site clutter: album names, years, "this is 100% correct", ratings, chord voicing lists like "D - x57775", fret numbers, ads, and page buttons.
- Sites often list the artist first, then the title. Return the song title as title and the band or singer as artist.
- Read "Key:", "Capo:", tuning notes ("half step down", "Eb tuning", "Drop D"), and tempo when given.
- Photos may be sideways, and a page may have two columns: read column one, then column two. Screenshots may overlap or repeat: include every line once, in order.
- Drop chord shape diagrams, finger charts, copyright and CCLI lines, "submitted by" lines, video links, and buttons like "View Lyrics". A small block of tab or fret numbers that only shows how to finger one chord (often under a chord name at the top) is a chord diagram, not part of the song.
- Write the title in Title Case, even if the source is all capitals.
- Artist is the performing artist. A hymn or chart with only writer credits ("Words and Music by...") uses the writers' names: "A & B" or "A, B & C". Only people or bands, never "Traditional" or "American folk tune". Use null when no name is given.
- key: use the key the source states ("Key - E", "Key: D"). If it states none, use the key the song starts in, even if it changes key later.
- Section names in the source can be wrong. A chorus comes back with the same words; a section whose words never come back is a verse, even if the source calls it "Chorus" or "Refrain".
- If the input holds more than one song, transcribe only the first one and list the others in other_songs.

KEEP IT FAITHFUL:
- Only use chords that are in the input. Never fill in a song from memory.
- Never change, add, or simplify chords, and copy each chord name exactly as written: A2 stays A2, Esus stays Esus. Never rewrite lyrics. Keep backing vocals in parentheses as their own lines.
- A dashed chord run like "A/C#-D" means quick changes: write it as "[A/C#] [D]".
- "G (hold)" means hold that chord: put [G] on the next word and keep "(hold)" right after it.
- Every [ ] holds only a real chord, like [G], [G/B], [Dsus4], [F#m], [Am7]. Section names never go in brackets.
- Put each chord exactly where the source puts it: on the word or syllable printed directly under it. Don't move chords to where you think they belong. A line often starts with words before its first chord ("Down the [D]river in the [A]morning"), so never pull the first chord to the start of the line unless the source puts it there. A chord in the middle of a word goes in the middle: "un[Bm]less".
- Hymns often print chords only on verse 1. When later verses are sung to the same tune, give them the same chords on the matching syllables, so every verse can be played.
- Bar charts like "| A | C#m7 | Bsus |" become a chord-only line: "[A]   [C#m7]   [Bsus]".
- Guitar tab (lines like "e|--3--" or "E:--3--") goes in a section of type "tab", copied exactly with tab true, under the part name from the source. Never invent chords that the source doesn't show.

ORGANIZE IT:
- One section per part, in the order it is played, labeled Intro, Verse 1, Verse 2, Pre-Chorus, Chorus, Bridge, Outro, or Interlude. Always call the chorus "Chorus", never "Refrain".
- Write the chorus out in full the first time. Each later time it is played with the same chords and words, add a section of type "chorus_repeat" with no lines. Do this for "(Repeat Chorus)" notes too. A chorus that comes back in a new key or with different words or chords is not a repeat: write it out in full with its own chords, labeled like "Chorus in D".
- When a whole section repeats, put the count in its label: "Bridge (2x)". When only some lines repeat, add a line "(Repeat 4x)" after them.
- Notes after a section name, like "Intro: ... Palm muted" or "Verse 1: Bass will enter", become that section's sidebar_note. Chords written after "Intro:" become the intro's chord line.
- Keep the source's line breaks where it has real lines. Rebuild lines only for phone copies that split them apart. A sung line longer than about 40 characters is easier to read while playing, so break it at a natural phrase.
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
  const unlimited = UNLIMITED_EMAILS.has(String(userData.user.email || "").toLowerCase());

  // Melody ranges: one short call for a batch of songs, by title and artist only.
  if (reqType === "melody") {
    const list = (Array.isArray(body?.songs) ? body.songs : [])
      // deno-lint-ignore no-explicit-any
      .filter((x: any) => x && typeof x.id === "string" && typeof x.title === "string" && x.title.trim())
      .slice(0, MAX_MELODY_SONGS)
      // deno-lint-ignore no-explicit-any
      .map((x: any) => ({
        id: x.id.slice(0, 64),
        title: x.title.trim().slice(0, 120),
        artist: typeof x.artist === "string" ? x.artist.trim().slice(0, 120) : "",
        key: cleanKey(x.key) || ""
      }));
    if (!list.length) return json({ error: "No songs to look up." });
    if (!unlimited) {
      const { data: capCount, error: capErr } = await supabase.rpc("increment_ai_usage", {
        usage_kind: "cb_import",
        daily_limit: DAILY_IMPORT_LIMIT
      });
      if (capErr || typeof capCount !== "number") {
        console.error("increment_ai_usage failed:", capErr);
        return json({ error: LIMIT_CHECK_FAILED });
      }
      if (capCount < 0) {
        return json({ error: `You’ve reached today’s limit of ${DAILY_IMPORT_LIMIT} AI requests. Try again tomorrow.` });
      }
    }
    const t0 = performance.now();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY!, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({
          model: MODEL_MELODY,
          max_tokens: 8192,
          ...noThinking(MODEL_MELODY),
          system: MELODY_PROMPT,
          tools: [{
            name: "save_melody_ranges",
            description: "Return each song's melody range",
            strict: true,
            input_schema: MELODY_SCHEMA
          }],
          tool_choice: { type: "auto" },
          messages: [{
            role: "user",
            content: "Songs:\n" + list.map((x: { id: string; title: string; artist: string; key: string }) =>
              `- id ${x.id}: "${x.title}"${x.artist ? ` by ${x.artist}` : ""}${x.key ? ` (sheet in ${x.key})` : ""}`).join("\n")
          }]
        })
      });
      const payload = await res.json().catch(() => null);
      const ms = performance.now() - t0;
      if (!res.ok) {
        await logAiCall(supabase, "cb_melody", MODEL_MELODY, false, ms, payload?.usage, userId);
        if ([429, 529].includes(res.status)) return json({ error: "The AI is busy right now. Try again in a minute." });
        console.error(`Anthropic HTTP ${res.status}:`, String(payload?.error?.message || "").slice(0, 160));
        return json({ error: "The AI couldn’t look those up. Try again later." });
      }
      // deno-lint-ignore no-explicit-any
      const tool = (payload?.content || []).find((b: any) => b.type === "tool_use" && b.name === "save_melody_ranges");
      // No answer (cut off, or prose instead of the tool) is a failure, not "every song unknown":
      // the app stops asking about songs reported unknown.
      if (!tool || payload?.stop_reason === "max_tokens" || !Array.isArray(tool.input?.songs)) {
        await logAiCall(supabase, "cb_melody", MODEL_MELODY, false, ms, payload?.usage, userId);
        return json({ error: "The AI didn’t send the melody ranges back. Try again in a minute." });
      }
      const ids = new Set(list.map((x: { id: string }) => x.id));
      const melodies = (Array.isArray(tool?.input?.songs) ? tool.input.songs : [])
        .map(melodyFromAi)
        .filter((m: { id: string } | null) => m && ids.has(m.id));
      await logAiCall(supabase, "cb_melody", MODEL_MELODY, !!tool, ms, payload?.usage, userId);
      return json({ melodies, unknown: list.length - melodies.length, model: MODEL_MELODY });
    } catch (err) {
      console.error("melody lookup error:", err);
      return json({ error: "Couldn’t reach the AI. Try again later." });
    }
  }

  // deno-lint-ignore no-explicit-any
  const userContent: any[] = [];
  let model = MODEL_TEXT;
  // Where the source says each chord sits, used to correct the AI's chord placement.
  let layout: string[] = [];
  // Set below for photos and unstructured links.
  let withSource = false;
  // The source as text, when there is one, to check repeated choruses against.
  let sourceText = "";
  // Track A direct result when a structured source (UG link or clean single-song digital PDF) parses cleanly.
  // deno-lint-ignore no-explicit-any
  let directSheet: any = null;
  let directSourceKind = "";

  if (reqType === "text") {
    if (Array.isArray(body?.layout)) {
      layout = body.layout
        .filter((l: unknown) => typeof l === "string" && l.length <= 400)
        .slice(0, 600)
        .map((l: string) => snapLayoutLine(l));
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    sourceText = text;
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
    withSource = true;
  } else if (reqType === "pdf") {
    const pdfData = typeof body?.pdfData === "string" ? body.pdfData.trim() : "";
    if (!pdfData) return json({ error: "Attach a PDF file first." });
    if (pdfData.length > 7_500_000) return json({ error: "PDF is too large (max 5 MB)." });
    try {
      const bytes = Uint8Array.from(atob(pdfData), (ch) => ch.charCodeAt(0));
      const pdfInfo = await pdfExtract(bytes);
      layout = pdfInfo.layoutLines;
      // Step 5: Clean single-song digital PDFs with section names can use Track A directly
      // when there is no custom user steer note requiring AI interpretation.
      if (!note) {
        const parsedPdf = parsePdfDirect(pdfInfo, typeof body?.fileName === "string" ? body.fileName : "");
        if (parsedPdf.confidence === "high" && parsedPdf.sheet) {
          directSheet = parsedPdf.sheet;
          directSourceKind = "pdf";
        }
      }
    } catch (e) {
      console.error("PDF text layer unreadable; using the AI's placement:", e);
    }
    // Step 3: Prompt-cache the PDF document block so multi-song set list PDFs reuse it for songs 2..N.
    userContent.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfData },
      cache_control: { type: "ephemeral" }
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
    const extracted = pageDataForImport(pageHtml);
    const pageText = extracted.text;
    sourceText = extracted.taggedText;
    if (pageText.length < 200) {
      return json({ error: "That page builds itself in the browser, so it can’t be read from a link. Copy the song and paste it instead." });
    }
    // Preserve native UG `[ch]` tags in layout extraction for exact chord columns.
    layout = layoutFromSourceText(extracted.taggedText, isValidChordToken);
    withSource = layout.length < 3;
    if (withSource) layout = [];
    // A page with no chords on it (a paid "Official" version, a sign-in wall, a video page)
    // would leave the AI to fill the song in from memory. Say so instead, before any cost.
    const chordLines = extracted.taggedText.split("\n").filter((l) => chordColumns(l, isValidChordToken)).length;
    const inlineChords = (pageText.match(/\[[A-G][#b]?[^\]\s]{0,8}\]/g) || []).length;
    if (chordLines < 4 && inlineChords < 6) {
      return json({ error: "That page doesn’t show the chords. It may be a paid or sign-in version. Open the free Chords version and share that link, or copy the chords and paste them." });
    }
    // Step 2: Track A direct parse for Ultimate Guitar links (falls back to Track B AI if confidence !== "high").
    if (extracted.ug && !note) {
      const ugRes = parseUgDirect(extracted.ug);
      if (ugRes.confidence === "high" && ugRes.sheet) {
        directSheet = ugRes.sheet;
        directSourceKind = "ug";
        if (ugRes.layoutLines.length) layout = ugRes.layoutLines;
      }
    }
    userContent.push({
      type: "text",
      text: (note ? `User note: ${note}\n\n` : "") + `Extract the chord sheet from this page (${url.hostname}):\n\n${pageText}`
    });
    model = MODEL_TEXT;
  } else {
    return json({ error: "Unsupported import type." });
  }

  // 3. Check daily cap right before any paid AI call (fail closed!)
  if (!unlimited) {
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
  }

  // deno-lint-ignore no-explicit-any
  function resultFor(sheet: any) {
    const tempo = Number(sheet.tempo);
    return {
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
      chordpro: sheetToChordPro(sheet)
    };
  }

  // Track A fast path: sheet is already built deterministically with exact chord positions.
  // Enrich tempo/genre/time_signature with a tiny metadata-only AI call (zero lyrics sent).
  if (directSheet) {
    try {
      const t0 = performance.now();
      const metaRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY!,
          "anthropic-version": ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: MODEL_META,
          max_tokens: 1024,
          ...noThinking(MODEL_META),
          system: META_PROMPT,
          tools: [{
            name: "save_song_metadata",
            description: "Return clean title, artist, tempo, time signature, and genre",
            strict: true,
            input_schema: META_SCHEMA
          }],
          tool_choice: { type: "auto" },
          messages: [{
            role: "user",
            content: `Song: "${directSheet.title}"${directSheet.artist ? ` by ${directSheet.artist}` : ""} (Key: ${directSheet.key}, Capo: ${directSheet.capo || 0}, Sections: ${(directSheet.sections || []).map((s: { label?: string }) => s.label).filter(Boolean).join(", ")})`
          }]
        })
      });
      const ms = performance.now() - t0;
      const metaPayload = await metaRes.json().catch(() => null);
      // deno-lint-ignore no-explicit-any
      const metaTool = (metaPayload?.content || []).find((b: any) => b.type === "tool_use" && b.name === "save_song_metadata");
      await logAiCall(supabase, "cb_import_meta", MODEL_META, !!(metaRes.ok && metaTool?.input), ms, metaPayload?.usage, userId);
      if (metaRes.ok && metaTool?.input) {
        const mi = metaTool.input;
        if (mi.title && String(mi.title).trim()) directSheet.title = String(mi.title).trim();
        if (mi.artist) directSheet.artist = String(mi.artist).trim();
        if (!directSheet.tempo && Number(mi.tempo) >= 20 && Number(mi.tempo) <= 300) directSheet.tempo = Math.round(Number(mi.tempo));
        if (mi.time_signature && String(mi.time_signature).trim()) directSheet.time_signature = String(mi.time_signature).trim();
        if (GENRES.includes(mi.genre)) directSheet.genre = mi.genre;
      }
    } catch (err) {
      console.error("Track A metadata lookup skipped:", err);
    }
    const resObj = resultFor(directSheet);
    return json({
      result: resObj,
      results: [resObj],
      missed: 0,
      placed_by: "layout",
      direct_source: directSourceKind,
      layout_lines: layout.length
    });
  }

  // Drop per-line `placement` notes whenever exact source positions already exist (`layout.length > 0`).
  const withPlacement = layout.length === 0;

  // 4. Track B: Call Claude Sonnet 5.5 with strict schema + auto tool choice + Chord Net repair
  // deno-lint-ignore no-explicit-any
  async function callClaude(messages: any[], retry = true): Promise<{ toolInput: any; toolId: string | null; content: any[]; history: any[]; usage: any; ms: number; stopReason: string }> {
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
        max_tokens: 16000,
        ...noThinking(model),
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{
          name: "save_chord_sheet",
          description: "Return the transcribed guitar chord sheet",
          strict: true,
          input_schema: schemaFor(withSource, withPlacement)
        }],
        tool_choice: { type: "auto" },
        messages
      })
    });
    const ms = performance.now() - t0;
    const payload = await res.json().catch(() => null);
    // Busy or a passing server error: wait a moment and try once more.
    if (retry && [429, 500, 502, 503, 529].includes(res.status)) {
      console.error(`Anthropic HTTP ${res.status}; retrying once`);
      await new Promise((r) => setTimeout(r, 2500));
      return callClaude(messages, false);
    }
    if (!res.ok) {
      if ([429, 529].includes(res.status)) throw new Error("BUSY");
      await logAiCall(supabase, "cb_import", model, false, ms, payload?.usage, userId);
      const reason = String(payload?.error?.message || "").slice(0, 160);
      console.error(`Anthropic HTTP ${res.status}:`, reason);
      if (/credit balance|usage limits/i.test(reason)) throw new Error("NO_CREDIT");
      if (/content filtering/i.test(reason)) throw new Error("FILTERED");
      throw new Error(`API:${res.status} ${reason}`);
    }
    if (payload?.stop_reason === "refusal") throw new Error("REFUSED");
    if (payload?.stop_reason === "max_tokens") throw new Error("TOO_LONG");
    // deno-lint-ignore no-explicit-any
    const toolBlock = (payload?.content || []).find((b: any) => b.type === "tool_use" && b.name === "save_chord_sheet");
    // With tool_choice: auto, if the model replied with prose instead of calling the tool, nudge once.
    if (!toolBlock && retry) {
      const said = Array.isArray(payload?.content) && payload.content.length ? payload.content : null;
      return callClaude(said
        ? [...messages, { role: "assistant", content: said }, { role: "user", content: "Return the chord sheet now by calling the save_chord_sheet tool." }]
        : messages, false);
    }
    // The reply exactly as sent (thinking blocks and all) for the repair turn; tidySheet edits a copy.
    return {
      toolInput: toolBlock?.input ? structuredClone(toolBlock.input) : null,
      toolId: toolBlock?.id || null,
      content: payload?.content || [],
      // The conversation this reply belongs to (includes a nudge turn, if there was one).
      history: messages,
      usage: payload?.usage,
      ms,
      stopReason: payload?.stop_reason
    };
  }

  // Chord placement from the AI's own word-by-word list (for photos), then from the source's
  // exact layout where there is one; and no voicing charts.
  // deno-lint-ignore no-explicit-any
  function tidySheet(sheet: any) {
    if (!sheet || !Array.isArray(sheet.sections)) return;
    sheet.sections = sheet.sections.filter((sec: { label?: string | null }) => !NOT_SONG_SECTION.test(sec.label || ""));
    if (withPlacement) applyPlacementNotes(sheet.sections);
    const exact = layout.length
      ? layout
      : (sheet.monospaced === true && typeof sheet.source_text === "string"
        ? layoutFromSourceText(sheet.source_text, isValidChordToken)
        : []);
    if (exact.length) realignToLayout(sheet.sections, exact, isValidChordToken);
    const source = sourceText || (sheet.monospaced === true && typeof sheet.source_text === "string" ? sheet.source_text : "");
    if (source) restoreChangedChoruses(sheet.sections, source, isValidChordToken);
    collapseWrittenRepeats(sheet.sections);
    delete sheet.source_text;
    delete sheet.monospaced;
  }

  // One song: ask, check every chord, and repair once if the check fails.
  // `focus` names the song to read when the input holds several.
  // deno-lint-ignore no-explicit-any
  async function transcribe(focus: string | null): Promise<{ sheet: any; problems: string[] }> {
    const content = focus
      ? [...userContent, { type: "text", text: `This input holds several songs. Transcribe only "${focus}" and leave other_songs empty.` }]
      : userContent;
    // deno-lint-ignore no-explicit-any
    const messages: any[] = [{ role: "user", content }];
    let attempt = await callClaude(messages);
    tidySheet(attempt.toolInput);
    let problems = validateSheetOutput(attempt.toolInput);
    await logAiCall(supabase, focus ? "cb_import_more" : "cb_import", model, problems.length === 0, attempt.ms, attempt.usage, userId);
    if (problems.length > 0 && attempt.toolInput && attempt.toolId) {
      // Send the AI's reply back unchanged: with thinking models, a rebuilt or edited turn is
      // rejected. tidySheet worked on a copy, so attempt.content is still the original.
      // deno-lint-ignore no-explicit-any
      const repair: any[] = [...attempt.history, { role: "assistant", content: attempt.content }];
      repair.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: attempt.toolId,
          content: `Validation failed: ${problems.join("; ")}. Fix every problem and call save_chord_sheet again.`
        }]
      });
      attempt = await callClaude(repair);
      tidySheet(attempt.toolInput);
      problems = validateSheetOutput(attempt.toolInput);
      await logAiCall(supabase, "cb_import_repair", model, problems.length === 0, attempt.ms, attempt.usage, userId);
    }
    return { sheet: attempt.toolInput, problems: attempt.toolInput ? problems : ["No sheet returned"] };
  }

  try {
    const first = await transcribe(null);
    if (first.problems.length > 0) {
      return json({ error: `Couldn’t check the chords (${first.problems.join(", ")}). Try pasting the text instead.` });
    }
    const results = [resultFor(first.sheet)];

    // A set list PDF or several photos can hold more songs. Read them side by side so the
    // whole import stays well inside the function's time limit (and hits the cached PDF block).
    const others = (Array.isArray(first.sheet.other_songs) ? first.sheet.other_songs : [])
      .filter((t: unknown) => typeof t === "string" && t.trim())
      .slice(0, MAX_SONGS_PER_IMPORT - 1);
    if (others.length) {
      const more = await Promise.allSettled(others.map((title: string) => transcribe(title.trim())));
      for (const r of more) {
        if (r.status === "fulfilled" && r.value.problems.length === 0) results.push(resultFor(r.value.sheet));
      }
    }
    // How the chords were placed, for the live import test: "layout" = the source's own columns.
    const placedBy = layout.length ? "layout" : withSource ? "ai-copy" : "ai";
    return json({ result: results[0], results, missed: others.length + 1 - results.length, placed_by: placedBy, layout_lines: layout.length });
  } catch (err) {
    console.error("import-sheet error:", err);
    const msg = err instanceof Error ? err.message : "";
    if (msg === "REFUSED") return json({ error: "The AI declined to read that. Try the pasted text instead." });
    if (msg === "TOO_LONG") return json({ error: "That song was too long to read in one go. Try pasting it in two parts." });
    if (msg === "BUSY") return json({ error: "The AI is busy right now. Try again in a minute." });
    if (msg === "NO_CREDIT") return json({ error: "The AI account has hit its spending limit. Raise it in the Anthropic console." });
    if (msg === "FILTERED") return json({ error: "The AI won’t copy out the words of this song. Paste the song as text and the app will format it without AI." });
    const reason = msg.startsWith("API:") ? ` (${msg.slice(4)})` : "";
    return json({ error: `The AI couldn’t read that${reason}. Try again, or the app can format it without AI.` });
  }
});
