// Web page & Ultimate Guitar extraction for import-sheet.
// Preserves Ultimate Guitar `[ch]...[/ch]` chord markers (for exact column alignment)
// while stripping `[tab]`/`[/tab]` line-pair wrappers (real guitar tab is detected by line shape).

import { isValidChordToken } from "./chord_net.ts";
import { parseStructuredSheet, stripTabWrappers, stripUgTags } from "./layout.ts";

export type UgPageData = {
  title: string;
  artist: string | null;
  key: string | null;
  capo: number;
  tuning: string | null;
  // Raw UG wiki_tab.content with [ch]...[/ch] intact and [tab]/[/tab] wrappers stripped.
  rawContent: string;
};

export type PageExtract = {
  // Plain text (with [ch] and [tab] stripped) for Track B fallback and sourceText chorus checks.
  text: string;
  // Raw text keeping [ch] tags intact (for layoutFromSourceText / chordColumns).
  taggedText: string;
  ug: UgPageData | null;
};

const decodeEntities = (t: string) => t
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

/**
 * Pulls the song data out of a chord-site page: Ultimate Guitar keeps the sheet in a JSON
 * attribute (`js-store`), many sites put it in `<pre>`, and the rest is page text without scripts.
 */
export function pageDataForImport(pageHtml: string): PageExtract {
  const store = pageHtml.match(/class="js-store"\s+data-content="([^"]+)"/);
  if (store) {
    try {
      const data = JSON.parse(decodeEntities(store[1]));
      const page = data?.store?.page?.data;
      const content = page?.tab_view?.wiki_tab?.content;
      if (typeof content === "string" && content.trim()) {
        const title = String(page?.tab?.song_name || "").trim();
        const artist = String(page?.tab?.artist_name || "").trim() || null;
        const capo = Number(page?.tab_view?.meta?.capo || 0) || 0;
        const keyRaw = String(page?.tab_view?.meta?.tonality || page?.tab?.tonality_name || "").trim();
        const key = isValidChordToken(keyRaw) ? keyRaw : null;
        const tuningObj = page?.tab_view?.meta?.tuning;
        const tuning = typeof tuningObj === "string"
          ? tuningObj
          : (tuningObj?.name || tuningObj?.value || null);
        const rawContent = stripTabWrappers(content).slice(0, 25_000);
        const head = [title, artist].filter(Boolean).join(" by ");
        const capoLine = capo ? `\nCapo: ${capo}` : "";
        const taggedText = `${head}${capoLine}\n\n${rawContent}`.slice(0, 25_000);
        const text = `${head}${capoLine}\n\n${stripUgTags(rawContent)}`.slice(0, 25_000);
        return {
          text,
          taggedText,
          ug: { title, artist, key, capo, tuning, rawContent }
        };
      }
    } catch { /* fall through to HTML parsing */ }
  }

  const title = decodeEntities((pageHtml.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim();
  const withoutCode = pageHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const pres = [...withoutCode.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((m) => m[1]);
  const body = pres.join("\n\n").replace(/<[^>]+>/g, "").trim().length > 200 ? pres.join("\n\n") : withoutCode;
  const cleaned = decodeEntities(body.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = cleaned ? `${title}\n\n${cleaned}`.slice(0, 25_000) : "";
  return { text, taggedText: text, ug: null };
}

export function pageTextForImport(pageHtml: string): string {
  return pageDataForImport(pageHtml).text;
}

/** Track A direct builder for Ultimate Guitar pages using native `[ch]` tags. */
export function parseUgDirect(ug: UgPageData) {
  return parseStructuredSheet({
    rawText: ug.rawContent,
    title: ug.title,
    artist: ug.artist,
    key: ug.key,
    capo: ug.capo,
    tuning: ug.tuning,
    isValid: isValidChordToken
  });
}
