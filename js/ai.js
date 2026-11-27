// Multi-Modal Chord Importer (js/ai.js)
// Supports:
// 1. Paste Text: the AI reads it when signed in (`import-sheet` type="text"); otherwise, or if the AI
//    can't be reached, the free on-device formatter handles ChordPro, chords over lyrics,
//    collapsed one-line pastes, and chord sites copied on a phone.
// 3. Multi-Snip Screenshots (Drag & drop, File Picker, OR Direct Clipboard Paste Cmd+V!) (`import-sheet` type="image")
// 4. Phone Camera Photo Capture (`capture="environment"`) with client-side canvas downscaling
// 5. PDF Chord Chart Upload (`import-sheet` type="pdf")

import {
  esc,
  getCloud,
  toast,
  toastError,
  closeSheet
} from "./core.js";
import { smartImportText, parse } from "./chordpro.js";

let stagedImages = []; // [{ mediaType, data, previewUrl, name }]
let stagedPdf = null;  // { data, name, size }
let importManyHandler = null; // saves the extra songs from a set list PDF or photos

export function initImportModal({ onImportReady, onImportMany }) {
  importManyHandler = onImportMany || null;
  // Tab switching inside Import Sheet
  const tabBtns = document.querySelectorAll("[data-import-tab]");
  const panels = document.querySelectorAll("[data-import-panel]");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-import-tab");
      tabBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
      panels.forEach((p) => {
        p.hidden = p.getAttribute("data-import-panel") !== target;
      });
    });
  });

  // 1. Paste: signed in, the AI reads it (title, genre, sections, alignment, tempo).
  // Signed out, or if the AI can't be reached, the free on-device formatter does it.
  const pasteArea = document.getElementById("import-paste-text");
  const formatBtn = document.getElementById("import-parse-free-btn");

  const formatFree = (raw, message) => {
    const { chordpro, format, info } = smartImportText(raw);
    const parsed = parse(chordpro);
    closeSheet("import-sheet-modal");
    onImportReady({
      title: parsed.meta.title || "Untitled song",
      artist: parsed.meta.artist || "",
      key: parsed.meta.key || parsed.meta.inferredKey || "G",
      capo: parsed.meta.capo || 0,
      tempo: parsed.meta.tempo || null,
      time_signature: parsed.meta.time || "",
      tuning: parsed.meta.tuning || "E A D G B E",
      notes: info.form || "",
      layout_prefs: { page_mode: "1-sheet", columns: "auto", compact_chorus: false, show_diagrams: false, font_offset: 0, accidental_pref: "auto", genre: info.genre },
      source: format === "chordpro" ? "ChordPro" : "Pasted text",
      chordpro
    });
    toast(message || "Formatted. Check it and save.");
  };

  if (formatBtn && pasteArea) {
    formatBtn.addEventListener("click", async () => {
      const raw = pasteArea.value.trim();
      if (!raw) {
        toastError("Paste some chords and lyrics first.");
        return;
      }
      // A pasted link: the server reads the page (chord sites can't be read from the browser).
      const isLink = /^(https?:\/\/|www\.)\S+$/i.test(raw);
      if (!getCloud()) {
        if (isLink) {
          toastError("Sign in to add a song from a link, or copy the song from the page and paste it.");
          return;
        }
        formatFree(raw);
        return;
      }
      const note = (document.getElementById("import-ai-note")?.value || "").trim();
      if (isLink) {
        await runEdgeImport({ body: { type: "url", url: raw, note }, btn: formatBtn, defaultLabel: "Format song", onImportReady });
        return;
      }
      // Chords-over-lyrics and phone copies record exact chord columns. Send those lines so the
      // server can put every chord back where the source had it after the AI organizes the song.
      const draft = smartImportText(raw);
      const layout = ["chords_over_lyrics", "split_lines"].includes(draft.format)
        ? draft.chordpro.split("\n").filter((l) => l.includes("[") && !l.trim().startsWith("{"))
        : undefined;
      const ok = await runEdgeImport({
        body: { type: "text", text: raw, note, layout },
        btn: formatBtn,
        defaultLabel: "Format song",
        onImportReady,
        quiet: true
      });
      if (ok !== true) {
        formatFree(raw, `${ok || "AI wasn’t available"}. Formatted on this device instead. Check it and save.`);
      }
    });
  }

  // 2. Multi-Snip & Phone Camera Input + Clipboard Paste (Cmd+V)
  const imageInput = document.getElementById("import-image-input");
  const cameraInput = document.getElementById("import-camera-input");
  const runImageAiBtn = document.getElementById("import-image-run-btn");
  const clearImagesBtn = document.getElementById("import-image-clear-btn");

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    for (const file of files) {
      if (stagedImages.length >= 6) {
        toastError("You can add up to 6 photos.");
        break;
      }
      try {
        const compressed = await compressImageFile(file);
        stagedImages.push(compressed);
      } catch (e) {
        console.error("Image stage failed:", e);
        toastError(`Couldn’t read image ${file.name}`);
      }
    }
    renderStagedImages();
  };

  if (imageInput) {
    imageInput.addEventListener("change", () => {
      handleFiles(imageInput.files);
      imageInput.value = "";
    });
  }
  if (cameraInput) {
    cameraInput.addEventListener("change", () => {
      handleFiles(cameraInput.files);
      cameraInput.value = "";
    });
  }

  // Direct clipboard screenshot paste (Cmd+V anywhere when Import Sheet is open)
  document.addEventListener("paste", (e) => {
    const modal = document.getElementById("import-sheet-modal");
    if (!modal || modal.hidden) return;
    const items = Array.from(e.clipboardData?.items || []);
    const imgItems = items.filter((it) => it.type.startsWith("image/"));
    if (imgItems.length > 0) {
      e.preventDefault();
      // Switch to Snips/Camera tab automatically
      const snipTabBtn = document.querySelector('[data-import-tab="snips"]');
      if (snipTabBtn) snipTabBtn.click();
      const files = imgItems.map((it) => it.getAsFile()).filter(Boolean);
      handleFiles(files);
      toast(`Added ${files.length} photo${files.length === 1 ? "" : "s"}`);
    }
  });

  if (clearImagesBtn) {
    clearImagesBtn.addEventListener("click", () => {
      stagedImages = [];
      renderStagedImages();
    });
  }

  if (runImageAiBtn) {
    runImageAiBtn.addEventListener("click", async () => {
      if (!stagedImages.length) {
        toastError("Add a photo first.");
        return;
      }
      const note = (document.getElementById("import-image-note")?.value || "").trim();
      await runEdgeImport({
        body: {
          type: "image",
          images: stagedImages.map((img) => ({ mediaType: img.mediaType, data: img.data })),
          note
        },
        btn: runImageAiBtn,
        defaultLabel: "Read photos",
        onImportReady
      });
    });
  }

  // 3. PDF Upload
  const pdfInput = document.getElementById("import-pdf-input");
  const runPdfBtn = document.getElementById("import-pdf-run-btn");

  if (pdfInput) {
    pdfInput.addEventListener("change", async () => {
      const file = pdfInput.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        toastError("PDF must be under 5 MB.");
        return;
      }
      try {
        const base64 = await fileToBase64(file);
        stagedPdf = {
          name: file.name,
          sizeKb: Math.round(file.size / 1024),
          data: base64
        };
        renderStagedPdf();
      } catch {
        toastError("Couldn’t read that PDF file.");
      }
    });
  }

  if (runPdfBtn) {
    runPdfBtn.addEventListener("click", async () => {
      if (!stagedPdf) {
        toastError("Choose a PDF chord sheet first.");
        return;
      }
      const note = (document.getElementById("import-pdf-note")?.value || "").trim();
      await runEdgeImport({
        body: {
          type: "pdf",
          pdfData: stagedPdf.data,
          fileName: stagedPdf.name,
          note
        },
        btn: runPdfBtn,
        defaultLabel: "Read PDF",
        onImportReady
      });
    });
  }
}

function renderStagedImages() {
  const grid = document.getElementById("import-snips-grid");
  const countEl = document.getElementById("import-snips-count");
  if (!grid) return;
  if (countEl) {
    countEl.textContent = stagedImages.length
      ? `${stagedImages.length} photo${stagedImages.length > 1 ? "s" : ""} added`
      : "No photos added yet.";
  }
  grid.innerHTML = stagedImages
    .map(
      (img, idx) => `
      <div class="snip-thumb" data-snip-idx="${idx}">
        <img src="${img.previewUrl}" alt="Staged snip ${idx + 1}" />
        <span class="snip-badge">#${idx + 1}</span>
        <button type="button" class="snip-rotate-btn" data-rotate-snip="${idx}" aria-label="Turn photo ${idx + 1} a quarter turn" title="Turn so the words read upright">⟳</button>
        <button type="button" class="snip-remove-btn" data-remove-snip="${idx}" aria-label="Remove snip ${idx + 1}">×</button>
      </div>
    `
    )
    .join("");

  // Sideways photos read worse: chords get matched to the wrong line.
  grid.querySelectorAll("[data-rotate-snip]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.getAttribute("data-rotate-snip"), 10);
      try {
        stagedImages[idx] = await rotateStagedImage(stagedImages[idx]);
        renderStagedImages();
      } catch {
        toastError("Couldn’t turn that photo.");
      }
    });
  });

  grid.querySelectorAll("[data-remove-snip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-remove-snip"), 10);
      stagedImages.splice(idx, 1);
      renderStagedImages();
    });
  });
}

function renderStagedPdf() {
  const status = document.getElementById("import-pdf-status");
  if (!status) return;
  if (!stagedPdf) {
    status.textContent = "No PDF selected.";
    return;
  }
  status.innerHTML = `Selected: <strong>${esc(stagedPdf.name)}</strong> (${stagedPdf.sizeKb} KB)`;
}

// Returns true when the sheet opened. With `quiet`, returns the error text instead of showing it.
async function runEdgeImport({ body, btn, defaultLabel, onImportReady, quiet = false }) {
  const fail = (message) => {
    if (quiet) return message;
    toastError(message);
    return message;
  };
  const sb = getCloud();
  if (!sb) return fail("Sign in first to use this");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Reading…";
  }
  try {
    const { data, error } = await sb.functions.invoke("import-sheet", { body });
    if (error) return fail(await edgeErrorText(error));
    if (data?.error) return fail(data.error.replace(/\.$/, ""));
    const res = data?.result;
    if (!res || !res.chordpro) return fail("The AI sent back an empty sheet");
    closeSheet("import-sheet-modal");
    const all = (Array.isArray(data.results) && data.results.length ? data.results : [res]).filter((r) => r?.chordpro);
    if (all.length > 1 && importManyHandler) {
      // A set list: every song goes straight into the library.
      await importManyHandler(all.map((r) => draftFromAi(r, body.type)));
      const missed = Number(data.missed) || 0;
      toast(`Added ${all.length} songs${missed ? `. ${missed} couldn’t be read` : ""}.`);
      return true;
    }
    onImportReady(draftFromAi(res, body.type));
    toast("Done. Check it and save.");
    return true;
  } catch (err) {
    console.error("Edge import failed:", err);
    return fail("Couldn’t reach the AI");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = defaultLabel;
    }
  }
}

function draftFromAi(res, type) {
  const genres = ["worship", "country", "rock", "pop"];
  return {
    title: res.title || "Untitled song",
    artist: res.artist || "",
    key: res.key || "G",
    capo: res.capo || 0,
    tempo: res.tempo || null,
    time_signature: res.time_signature || "4/4",
    tuning: res.tuning || "E A D G B E",
    notes: res.form ? `Form: ${String(res.form).replace(/^form:\s*/i, "")}` : (res.notes || ""),
    layout_prefs: {
      page_mode: "1-sheet",
      columns: "auto",
      compact_chorus: false,
      show_diagrams: false,
      font_offset: 0,
      accidental_pref: "auto",
      genre: genres.includes(res.genre) ? res.genre : "pop"
    },
    source: type === "pdf" ? "PDF" : type === "image" ? "Photo" : type === "url" ? "Link" : "Pasted text (AI)",
    chordpro: res.chordpro
  };
}

// supabase-js reports a missing or failing function as "Edge Function returned a non-2xx status code".
async function edgeErrorText(error) {
  const status = error?.context?.status;
  if (status === 404) return "The AI import isn’t set up on the server yet";
  if (status === 401 || status === 403) return "Sign in again to use the AI";
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return String(body.error).replace(/\.$/, "");
  } catch { /* not JSON */ }
  return "The AI import had a problem";
}

/** Turns a staged photo a quarter turn clockwise. */
async function rotateStagedImage(img) {
  const el = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = img.previewUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = el.height;
  canvas.height = el.width;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(el, 0, 0);
  const previewUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { ...img, mediaType: "image/jpeg", data: previewUrl.split(",")[1], previewUrl };
}

/**
 * Downscale a screenshot or camera photo on a canvas to max 1600px on the longest side (JPEG 0.85).
 */
async function compressImageFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = dataUrl;
  });

  const MAX_DIM = 1600;
  let { width, height } = img;
  if (width > MAX_DIM || height > MAX_DIM) {
    if (width >= height) {
      height = Math.round((height * MAX_DIM) / width);
      width = MAX_DIM;
    } else {
      width = Math.round((width * MAX_DIM) / height);
      height = MAX_DIM;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  const previewUrl = canvas.toDataURL("image/jpeg", 0.85);
  const base64 = previewUrl.split(",")[1];
  return {
    name: file.name || "snip.jpg",
    mediaType: "image/jpeg",
    data: base64,
    previewUrl
  };
}

/**
 * Layer 3 AI Musical Rhythm & Downbeat Quality Check:
 * Sends the current ChordPro sheet to the `import-sheet` Edge Function (Claude Haiku 4.5)
 * with explicit instructions to verify that every guitar chord sits directly before the
 * metrically stressed syllable/word where it is played (including walkdowns and passing chords).
 */
export async function runAiChordAlignmentCheck({ title, artist, key, capo, chordpro, btn, onAligned }) {
  const sb = getCloud();
  if (!sb) {
    toastError("Sign in first to use the AI check.");
    return;
  }
  const defaultLabel = btn ? btn.textContent : "✨ AI Timing Check";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking timing…";
  }
  try {
    const steerNote =
      "QUALITY CHECK MODE: Verify that every [Chord] in this sheet lines up with the exact word/syllable when it is played. " +
      "Shift any downbeat chords off weak pickup words ('The', 'And', 'In') onto the stressed noun/verb, align bass walkdowns " +
      "(like D -> D/C -> G/B -> C) accurately across the start and end syllables of the phrase, remove redundant duplicate chords " +
      "on the same line where the chord did not change, and keep all section labels and sidebar notes intact.";

    const { data, error } = await sb.functions.invoke("import-sheet", {
      body: {
        type: "text",
        text: `Title: ${title || "Song"}\nArtist: ${artist || ""}\nKey: ${key || "G"}\nCapo: ${capo || 0}\n\n${chordpro}`,
        note: steerNote
      }
    });
    if (error || data?.error) {
      toastError(error ? await edgeErrorText(error) : data.error);
      return;
    }
    const alignedPro = data?.result?.chordpro;
    if (!alignedPro) {
      toastError("AI returned an empty sheet.");
      return;
    }
    if (onAligned) {
      onAligned(alignedPro);
    }
    toast("✨ AI verified & aligned chord timing across all syllables!");
  } catch (err) {
    console.error("AI alignment check error:", err);
    toastError("Couldn’t reach the AI. Use Fix or the ◀ ▶ nudges instead.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = defaultLabel;
    }
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const str = String(reader.result || "");
      const idx = str.indexOf(",");
      resolve(idx !== -1 ? str.slice(idx + 1) : str);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Extract the main distinct chords from ChordPro (no lyrics sent) to ground melody key lookup.
 */
function sheetMainChords(chordpro, limit = 6) {
  if (!chordpro) return [];
  const parsed = parse(chordpro);
  const seen = [];
  for (const sec of parsed.sections || []) {
    for (const line of sec.lines || []) {
      for (const seg of line.segments || []) {
        const ch = seg.chord && String(seg.chord).trim();
        if (!ch || ch === "N.C." || ch === "NC") continue;
        if (!seen.includes(ch)) {
          seen.push(ch);
          if (seen.length >= limit) return seen;
        }
      }
    }
  }
  return seen;
}

/**
 * Ask the AI for each song's lowest and highest sung notes, from its best-known recording.
 * Only titles, artists, keys, and main chord names (never lyrics) are sent.
 * Resolves to { melodies: [{ id, recording_key, low, high, confidence }], unknownIds } or { error }.
 */
export async function lookUpMelodyRanges(songList) {
  const sb = getCloud();
  if (!sb) return { error: "Sign in first to use this" };
  const melodies = [];
  const unknownIds = [];
  for (let i = 0; i < songList.length; i += 25) {
    const batch = songList.slice(i, i + 25).map((s) => ({
      id: s.id,
      title: s.title,
      artist: s.artist || "",
      key: s.key || "",
      chords: sheetMainChords(s.chordpro || "")
    }));
    try {
      const { data, error } = await sb.functions.invoke("import-sheet", { body: { type: "melody", songs: batch } });
      if (error) return { error: await edgeErrorText(error), melodies, unknownIds };
      // The server answers this until the updated import-sheet function is deployed.
      if (/unsupported import type/i.test(data?.error || "")) return { error: "Melody lookup isn’t on the server yet", melodies, unknownIds };
      if (data?.error) return { error: data.error.replace(/\.$/, ""), melodies, unknownIds };
      const got = Array.isArray(data?.melodies) ? data.melodies : [];
      melodies.push(...got);
      const found = new Set(got.map((m) => m.id));
      unknownIds.push(...batch.filter((b) => !found.has(b.id)).map((b) => b.id));
    } catch (err) {
      console.error("Melody lookup failed:", err);
      return { error: "Couldn’t reach the AI", melodies, unknownIds };
    }
  }
  return { melodies, unknownIds };
}
