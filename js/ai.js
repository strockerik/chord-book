// Multi-Modal Chord Importer (js/ai.js)
// Supports:
// 1. Paste Text (ChordPro, standard 2-line Chords-Over-Lyrics, and Ugly Single-Line Pastes) — FREE & INSTANT
// 2. Optional 1-Click AI Syllable Alignment on Ugly Pastes (`import-sheet` type="text")
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

export function initImportModal({ onImportReady }) {
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

  // 1. Free Instant Paste Parser
  const pasteArea = document.getElementById("import-paste-text");
  const parseFreeBtn = document.getElementById("import-parse-free-btn");
  const parseAiBtn = document.getElementById("import-parse-ai-btn");

  if (parseFreeBtn && pasteArea) {
    parseFreeBtn.addEventListener("click", () => {
      const raw = pasteArea.value.trim();
      if (!raw) {
        toastError("Paste some chords and lyrics first.");
        return;
      }
      const { chordpro, format } = smartImportText(raw);
      const parsed = parse(chordpro);
      const formatLabel =
        format === "ugly_paste" ? "Collapsed Single-Line Paste" :
        format === "chords_over_lyrics" ? "Chords-Over-Lyrics Tab" : "ChordPro";
      closeSheet("import-sheet-modal");
      onImportReady({
        title: parsed.meta.title || "Imported Song",
        artist: parsed.meta.artist || "",
        key: parsed.meta.key || parsed.meta.inferredKey || "G",
        capo: parsed.meta.capo || 0,
        notes: parsed.meta.note || "",
        source: formatLabel,
        chordpro
      });
      toast("Formatted. Check it and save.");
    });
  }

  if (parseAiBtn && pasteArea) {
    parseAiBtn.addEventListener("click", async () => {
      const raw = pasteArea.value.trim();
      if (!raw) {
        toastError("Paste some chords and lyrics first.");
        return;
      }
      const note = (document.getElementById("import-ai-note")?.value || "").trim();
      await runEdgeImport({
        body: { type: "text", text: raw, note },
        btn: parseAiBtn,
        defaultLabel: "Clean up with AI",
        onImportReady
      });
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
        <button type="button" class="snip-remove-btn" data-remove-snip="${idx}" aria-label="Remove snip ${idx + 1}">×</button>
      </div>
    `
    )
    .join("");

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

async function runEdgeImport({ body, btn, defaultLabel, onImportReady }) {
  const sb = getCloud();
  if (!sb) {
    toastError("Sign in first to use this.");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Reading…";
  }
  try {
    const { data, error } = await sb.functions.invoke("import-sheet", { body });
    if (error) {
      toastError(error.message || "AI import request failed.");
      return;
    }
    if (data?.error) {
      toastError(data.error);
      return;
    }
    const res = data?.result;
    if (!res || !res.chordpro) {
      toastError("AI returned an empty sheet — try pasting the text directly.");
      return;
    }
    closeSheet("import-sheet-modal");
    onImportReady({
      title: res.title || "Imported Song",
      artist: res.artist || "",
      key: res.key || "G",
      capo: res.capo || 0,
      tempo: res.tempo || null,
      time_signature: res.time_signature || "4/4",
      notes: res.notes || "",
      source: body.type === "pdf" ? "PDF Import" : body.type === "image" ? "Photo / Snip Import" : "AI Import",
      chordpro: res.chordpro
    });
    toast("Done. Check it and save.");
  } catch (err) {
    console.error("Edge import failed:", err);
    toastError("Couldn’t reach import-sheet Edge Function. Make sure it is deployed in Supabase.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = defaultLabel;
    }
  }
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
      toastError(error?.message || data?.error || "AI timing check could not complete.");
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
    toastError("Couldn’t reach AI Timing Check service — use the instant Auto-Fix or ◀/▶ sheet nudger instead.");
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
