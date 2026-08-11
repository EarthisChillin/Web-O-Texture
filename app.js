/* ===========================================================================
   TexArchive core — mirrors TexArchive.h/.cpp exactly (see format notes
   there). Pure ArrayBuffer/DataView logic, no DOM dependency.
=========================================================================== */
(function () {
"use strict";

function u32(view, off) { return view.getUint32(off, true); }

class TexArchive {
  constructor(arrayBuffer) {
    this.buffer = arrayBuffer;
    this.bytes = new Uint8Array(arrayBuffer);
    this.entries = [];
    this.offsetTableFileOffset = 20;
    this.header = null;
  }

  parse() {
    const view = new DataView(this.buffer);
    if (this.bytes.length < 20) throw new Error("File is too small to be a .tex archive.");

    this.header = {
      fieldA: u32(view, 0),
      entryCount: u32(view, 4),
      fieldC: u32(view, 8),
      fieldD: u32(view, 12),
      headerHash: u32(view, 16),
    };

    const entryCount = this.header.entryCount;
    this.offsetTableFileOffset = 20;
    const offsetTableEnd = this.offsetTableFileOffset + entryCount * 4;

    if (entryCount === 0 || offsetTableEnd > this.bytes.length) {
      throw new Error("Entry count in the file header looks invalid for this file's size — this may not be a .tex archive.");
    }

    this.entries = new Array(entryCount);
    for (let i = 0; i < entryCount; i++) {
      const off = u32(view, this.offsetTableFileOffset + i * 4);
      if (off + 56 > this.bytes.length) {
        throw new Error("An entry offset points past the end of the file.");
      }

      const e = { index: i, fileOffset: off };
      e.raw = {
        formatCode: u32(view, off + 0),
        field1: u32(view, off + 4),
        field2: u32(view, off + 8),
        dataSize: u32(view, off + 12),
        blockSize: u32(view, off + 16),
        zero: u32(view, off + 20),
        recordId: u32(view, off + 24),
        constA: u32(view, off + 28),
        constB: u32(view, off + 32),
        widthHeight: u32(view, off + 36),
        field10: u32(view, off + 40),
        field11: u32(view, off + 44),
        frameCount: u32(view, off + 48),
        idx13: u32(view, off + 52),
      };

      const nextOff = (i + 1 < entryCount) ? u32(view, this.offsetTableFileOffset + (i + 1) * 4) : this.bytes.length;
      e.blockSize = nextOff - off;

      e.width = e.raw.widthHeight & 0xFFFF;
      e.height = (e.raw.widthHeight >>> 16) & 0xFFFF;
      e.frameCount = Math.max(1, e.raw.frameCount);

      e.frameTable = [];
      const tableStart = off + 56;
      const tableFits = tableStart + e.frameCount * 4 <= this.bytes.length;
      if (tableFits) {
        for (let k = 0; k < e.frameCount; k++) e.frameTable.push(u32(view, tableStart + k * 4));
      }
      e.singleFrameSentinel = 0xFFFFFFFF;
      if (e.frameCount === 1 && tableStart + 8 <= this.bytes.length) {
        e.singleFrameSentinel = u32(view, tableStart + 4);
      }

      e.pixelDataOffsetInRecord = e.frameCount === 1 ? 64 : (56 + 4 * e.frameCount);
      e.pixelDataFileOffset = off + e.pixelDataOffsetInRecord;
      e.frameByteSize = e.width * e.height * 2;

      const frameBytesTotal = e.blockSize - e.pixelDataOffsetInRecord - 8;
      const residual = frameBytesTotal - e.frameCount * e.frameByteSize;
      e.residualBytes = residual > 0 ? residual : 0;

      let monochrome = e.frameByteSize > 0;
      const pixelWords = e.frameCount * e.width * e.height;
      if (monochrome && e.pixelDataFileOffset + pixelWords * 2 <= this.bytes.length) {
        for (let w = 0; w < pixelWords && monochrome; w++) {
          const p = view.getUint16(e.pixelDataFileOffset + w * 2, true);
          const n0 = p & 0xF, n1 = (p >> 4) & 0xF, n2 = (p >> 8) & 0xF, n3 = (p >> 12) & 0xF;
          if (!(n0 === n1 && n1 === n2 && n2 === n3)) monochrome = false;
        }
      } else {
        monochrome = false;
      }
      e.isMonochrome = monochrome;
      e.isUiCategory = e.raw.constA === 65536;
      e.hasUndecodedFormat = ((e.raw.constB >>> 24) === 0x05);

      this.entries[i] = e;
    }
  }

  getFramePixels(entryIdx, frameIdx) {
    const e = this.entries[entryIdx];
    const view = new DataView(this.buffer);
    const out = new Uint16Array(e.width * e.height);
    if (frameIdx >= e.frameCount) return out;
    const off = e.pixelDataFileOffset + frameIdx * e.frameByteSize;
    if (off + e.frameByteSize > this.bytes.length) return out;
    for (let i = 0; i < out.length; i++) out[i] = view.getUint16(off + i * 2, true);
    return out;
  }

  replaceFrame(entryIdx, frameIdx, pixels555) {
    const e = this.entries[entryIdx];
    if (frameIdx >= e.frameCount) throw new Error("Frame index out of range.");
    if (pixels555.length !== e.width * e.height) throw new Error("Replacement pixel buffer does not match this entry's width/height.");
    const view = new DataView(this.buffer);
    const off = e.pixelDataFileOffset + frameIdx * e.frameByteSize;
    for (let i = 0; i < pixels555.length; i++) view.setUint16(off + i * 2, pixels555[i], true);
  }

  resizeEntry(entryIdx, newWidth, newHeight, framesPixels555) {
    const e = this.entries[entryIdx];
    if (newWidth <= 0 || newHeight <= 0) throw new Error("Width and height must be non-zero.");
    if (framesPixels555.length !== e.frameCount) throw new Error("Expected one pixel buffer per existing frame.");
    const newFrameByteSize = newWidth * newHeight * 2;
    for (const fp of framesPixels555) {
      if (fp.length !== newWidth * newHeight) throw new Error("A supplied frame buffer does not match the new width/height.");
    }

    const tableBytes = e.frameCount * 4;
    const sentinelBytes = (e.frameCount === 1) ? 4 : 0;
    const newHeaderTotal = 56 + tableBytes + sentinelBytes;
    const newFrameBytesTotal = e.frameCount * newFrameByteSize;
    const newBlockSize = newHeaderTotal + newFrameBytesTotal + 8;

    const newRecord = new Uint8Array(newBlockSize);
    const nrView = new DataView(newRecord.buffer);

    const newRaw = Object.assign({}, e.raw);
    newRaw.dataSize = newHeaderTotal + newFrameBytesTotal;
    newRaw.blockSize = newBlockSize;
    newRaw.widthHeight = ((newWidth & 0xFFFF) | ((newHeight & 0xFFFF) << 16)) >>> 0;
    if (e.raw.field11 === e.width) newRaw.field11 = newWidth;

    nrView.setUint32(0, newRaw.formatCode, true);
    nrView.setUint32(4, newRaw.field1, true);
    nrView.setUint32(8, newRaw.field2, true);
    nrView.setUint32(12, newRaw.dataSize, true);
    nrView.setUint32(16, newRaw.blockSize, true);
    nrView.setUint32(20, newRaw.zero, true);
    nrView.setUint32(24, newRaw.recordId, true);
    nrView.setUint32(28, newRaw.constA, true);
    nrView.setUint32(32, newRaw.constB, true);
    nrView.setUint32(36, newRaw.widthHeight, true);
    nrView.setUint32(40, newRaw.field10, true);
    nrView.setUint32(44, newRaw.field11, true);
    nrView.setUint32(48, newRaw.frameCount, true);
    nrView.setUint32(52, newRaw.idx13, true);

    let writePos = 56;
    for (let k = 0; k < e.frameCount; k++) {
      const v = ((k + 1) * newFrameByteSize + e.raw.idx13) >>> 0;
      nrView.setUint32(writePos, v, true);
      writePos += 4;
    }
    if (sentinelBytes) {
      nrView.setUint32(writePos, e.singleFrameSentinel, true);
      writePos += 4;
    }
    for (const fp of framesPixels555) {
      for (let i = 0; i < fp.length; i++) {
        nrView.setUint16(writePos, fp[i], true);
        writePos += 2;
      }
    }

    const oldTrailerOff = e.fileOffset + e.blockSize - 8;
    if (oldTrailerOff + 8 <= this.bytes.length) {
      newRecord.set(this.bytes.subarray(oldTrailerOff, oldTrailerOff + 8), writePos);
    }

    const delta = newBlockSize - e.blockSize;
    const entryCount = this.entries.length;
    const offsetTableEnd = this.offsetTableFileOffset + entryCount * 4;

    const oldView = new DataView(this.buffer);
    const newOffsetTable = new Uint8Array(entryCount * 4);
    const otView = new DataView(newOffsetTable.buffer);
    for (let i = 0; i < entryCount; i++) {
      let off = u32(oldView, this.offsetTableFileOffset + i * 4);
      if (i > entryIdx) off = (off + delta) >>> 0;
      otView.setUint32(i * 4, off, true);
    }

    const parts = [
      this.bytes.subarray(0, this.offsetTableFileOffset),
      newOffsetTable,
      this.bytes.subarray(offsetTableEnd, e.fileOffset),
      newRecord,
      this.bytes.subarray(e.fileOffset + e.blockSize),
    ];
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const newBuf = new Uint8Array(totalLen);
    let p = 0;
    for (const part of parts) { newBuf.set(part, p); p += part.length; }

    this.buffer = newBuf.buffer;
    this.bytes = newBuf;
    this.parse();
  }
}

/* ===========================================================================
   ImageTransform — mirrors ImageTransform.h exactly.
=========================================================================== */

function defaultViewTransformForEntry(isUiCategory) {
  if (isUiCategory) return { rotationSteps: 0, flipH: false, flipV: false };
  return { rotationSteps: 0, flipH: false, flipV: true };
}
function isIdentityView(t) { return t.rotationSteps === 0 && !t.flipH && !t.flipV; }

function flipHorizontal(src, w, h) {
  const out = new Uint16Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out[y * w + x] = src[y * w + (w - 1 - x)];
  return out;
}
function flipVertical(src, w, h) {
  const out = new Uint16Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out[y * w + x] = src[(h - 1 - y) * w + x];
  return out;
}
function rotateCW90Once(src, w, h) {
  const outW = h, outH = w;
  const out = new Uint16Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out[x * outW + (h - 1 - y)] = src[y * w + x];
  return { buf: out, w: outW, h: outH };
}
function rotateCW(src, w, h, steps) {
  steps = ((steps % 4) + 4) % 4;
  let cur = src, outW = w, outH = h;
  for (let i = 0; i < steps; i++) {
    const r = rotateCW90Once(cur, outW, outH);
    cur = r.buf; outW = r.w; outH = r.h;
  }
  return { buf: cur, w: outW, h: outH };
}
// stored (w,h) -> display (outW,outH)
function applyViewTransform(stored, w, h, t) {
  let buf = stored;
  if (t.flipH) buf = flipHorizontal(buf, w, h);
  if (t.flipV) buf = flipVertical(buf, w, h);
  return rotateCW(buf, w, h, t.rotationSteps);
}
// display (w,h) -> stored (outW,outH)
function invertViewTransform(displayed, w, h, t) {
  const r = rotateCW(displayed, w, h, (4 - (t.rotationSteps % 4)) % 4);
  let buf = r.buf, rw = r.w, rh = r.h;
  if (t.flipV) buf = flipVertical(buf, rw, rh);
  if (t.flipH) buf = flipHorizontal(buf, rw, rh);
  return { buf, w: rw, h: rh };
}

function unpackRGB555(p) {
  return [((p >> 10) & 0x1F) << 3, ((p >> 5) & 0x1F) << 3, (p & 0x1F) << 3];
}
function packRGB555(r8, g8, b8) {
  const r5 = r8 >> 3, g5 = g8 >> 3, b5 = b8 >> 3;
  return (r5 << 10) | (g5 << 5) | b5;
}
function monochromeLevel(p) { return p & 0xF; }
function packMonochromeLevel(level4bit) {
  const n = level4bit & 0xF;
  return n | (n << 4) | (n << 8) | (n << 12);
}
function convertRGB555ToMonochrome(rgb555) {
  const out = new Uint16Array(rgb555.length);
  for (let i = 0; i < rgb555.length; i++) {
    const [r, g, b] = unpackRGB555(rgb555[i]);
    const luma = (r * 77 + g * 150 + b * 29) >> 8;
    const level4 = Math.min(15, luma >> 4);
    out[i] = packMonochromeLevel(level4);
  }
  return out;
}

/* ===========================================================================
   UI wiring
=========================================================================== */

const $ = (id) => document.getElementById(id);

const state = {
  archive: null,
  fileName: "",
  views: [],           // ViewTransform per entry
  selectedEntry: -1,
  currentFrame: 0,
  bilinear: false,
  dirty: false,
};

const el = {
  btnOpen: $("btnOpen"),
  btnTilePicker: $("btnTilePicker"),
  btnSave: $("btnSave"),
  fileLabel: $("fileLabel"),
  statusLine: $("statusLine"),
  archiveMeta: $("archiveMeta"),
  entryList: $("entryList"),
  previewCanvas: $("previewCanvas"),
  frameLabel: $("frameLabel"),
  btnPrevFrame: $("btnPrevFrame"),
  btnNextFrame: $("btnNextFrame"),
  btnRotate: $("btnRotate"),
  btnFlipH: $("btnFlipH"),
  btnFlipV: $("btnFlipV"),
  btnResetView: $("btnResetView"),
  chkBilinear: $("chkBilinear"),
  viewLabel: $("viewLabel"),
  infoBlock: $("infoBlock"),
  btnImport: $("btnImport"),
  btnExport: $("btnExport"),
  fileInputArchive: $("fileInputArchive"),
  fileInputImage: $("fileInputImage"),
  downloadLink: $("downloadLink"),
  tilePickerOverlay: $("tilePickerOverlay"),
  tilePickerGrid: $("tilePickerGrid"),
  tilePickerCount: $("tilePickerCount"),
  btnTilePickerClose: $("btnTilePickerClose"),
  btnCredits: $("btnCredits"),
  creditsOverlay: $("creditsOverlay"),
  creditsBody: $("creditsBody"),
  btnCreditsClose: $("btnCreditsClose"),
};

function setStatus(msg, kind) {
  el.statusLine.textContent = msg || "";
  el.statusLine.className = kind ? kind : "";
}

function markDirty() {
  state.dirty = true;
  el.btnSave.classList.add("primary");
  if (state.fileName) el.fileLabel.textContent = state.fileName + " (modified)";
}

/* ---- opening an archive -------------------------------------------------- */

el.btnOpen.addEventListener("click", () => el.fileInputArchive.click());
el.fileInputArchive.addEventListener("change", async () => {
  const file = el.fileInputArchive.files[0];
  el.fileInputArchive.value = "";
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const archive = new TexArchive(buf);
    archive.parse();
    state.archive = archive;
    state.fileName = file.name;
    state.dirty = false;
    state.views = archive.entries.map((e) => defaultViewTransformForEntry(e.isUiCategory));
    state.selectedEntry = -1;
    state.currentFrame = 0;
    el.fileLabel.textContent = file.name;
    el.btnSave.disabled = false;
    el.btnSave.classList.remove("primary");
    el.btnTilePicker.disabled = archive.entries.length === 0;
    tilePickerThumbCache.clear();
    renderArchiveMeta();
    renderList();
    setStatus(`Loaded ${archive.entries.length} entries.`, "ok");
    if (archive.entries.length > 0) selectEntry(0);
  } catch (err) {
    setStatus(String(err.message || err), "err");
    console.error(err);
  }
});

function renderArchiveMeta() {
  const h = state.archive.header;
  el.archiveMeta.textContent =
    `${state.archive.entries.length} entries` +
    `  ·  header 0x${h.fieldA.toString(16)}/0x${h.fieldC.toString(16)}/0x${h.fieldD.toString(16)}`;
}

/* ---- entry list ------------------------------------------------------- */

function renderList() {
  el.entryList.innerHTML = "";
  state.archive.entries.forEach((e) => {
    const row = document.createElement("div");
    row.className = "entry-row" + (e.index === state.selectedEntry ? " selected" : "");
    row.dataset.idx = e.index;

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = "#" + e.index;
    row.appendChild(idx);

    const dims = document.createElement("span");
    dims.className = "dims";
    dims.textContent = `${e.width}\u00D7${e.height}` + (e.frameCount > 1 ? `  (${e.frameCount}f)` : "");
    row.appendChild(dims);

    if (e.isUiCategory) row.appendChild(makeBadge("UI", "ui"));
    if (e.isMonochrome) row.appendChild(makeBadge("GRAY", "mono"));
    if (e.hasUndecodedFormat || e.residualBytes > 0) row.appendChild(makeBadge("!", "warn"));

    row.addEventListener("click", () => selectEntry(e.index));
    el.entryList.appendChild(row);
  });
}
function makeBadge(text, cls) {
  const b = document.createElement("span");
  b.className = "badge " + cls;
  b.textContent = text;
  return b;
}
function refreshListRow(idx) {
  const row = el.entryList.querySelector(`.entry-row[data-idx="${idx}"]`);
  if (!row) return;
  const e = state.archive.entries[idx];
  row.querySelector(".dims").textContent = `${e.width}\u00D7${e.height}` + (e.frameCount > 1 ? `  (${e.frameCount}f)` : "");
}

/* ---- selection / info --------------------------------------------------- */

function selectEntry(idx) {
  state.selectedEntry = idx;
  state.currentFrame = 0;
  document.querySelectorAll(".entry-row").forEach((r) => r.classList.toggle("selected", Number(r.dataset.idx) === idx));
  const has = idx >= 0;
  [el.btnImport, el.btnExport, el.btnRotate, el.btnFlipH, el.btnFlipV, el.btnResetView].forEach((b) => (b.disabled = !has));
  renderInfo();
  renderFrameNav();
  renderPreview();
}

function currentEntry() {
  if (state.selectedEntry < 0) return null;
  return state.archive.entries[state.selectedEntry];
}
function currentView() {
  return state.views[state.selectedEntry];
}

function describeView(t) {
  if (isIdentityView(t)) return "View: none";
  const parts = [];
  if (t.rotationSteps) parts.push(`rot ${t.rotationSteps * 90}\u00B0`);
  if (t.flipH) parts.push("flip H");
  if (t.flipV) parts.push("flip V");
  return "View: " + parts.join(", ");
}

function renderInfo() {
  const e = currentEntry();
  if (!e) { el.infoBlock.textContent = "Select an entry from the list to see its details."; el.viewLabel.textContent = ""; return; }
  let txt =
    `Entry #${e.index}\n\n` +
    `Width:        ${e.width} px\n` +
    `Height:       ${e.height} px\n` +
    `Pixel format: ${e.isMonochrome ? "4-bit grayscale" : "RGB555"}\n` +
    `Frame count:  ${e.frameCount}\n` +
    `File offset:  0x${e.fileOffset.toString(16)}\n` +
    `Block size:   ${e.blockSize} bytes\n` +
    `Format code:  ${e.raw.formatCode}\n` +
    `Record id:    0x${e.raw.recordId.toString(16)}\n` +
    `Category:     ${e.isUiCategory ? "UI / icon (constA=65536)" : "Sprite"}`;
  el.infoBlock.textContent = txt;

  if (e.residualBytes > 0 || e.hasUndecodedFormat) {
    const warnBox = document.createElement("div");
    warnBox.className = "warn-box";
    let w = "";
    if (e.hasUndecodedFormat) w += "This entry's pixel layout isn't fully understood — it may render as flat color bands rather than a real image.\n";
    if (e.residualBytes > 0) w += `${e.residualBytes} unidentified trailing bytes — palette or resolution may be wrong.`;
    warnBox.textContent = w.trim();
    el.infoBlock.appendChild(warnBox);
  }

  el.viewLabel.textContent = describeView(currentView());
}

function renderFrameNav() {
  const e = currentEntry();
  if (!e) { el.frameLabel.textContent = "\u2014"; el.btnPrevFrame.disabled = true; el.btnNextFrame.disabled = true; return; }
  el.frameLabel.textContent = `Frame ${state.currentFrame + 1} / ${e.frameCount}`;
  el.btnPrevFrame.disabled = !(e.frameCount > 1 && state.currentFrame > 0);
  el.btnNextFrame.disabled = !(e.frameCount > 1 && state.currentFrame + 1 < e.frameCount);
}

el.btnPrevFrame.addEventListener("click", () => { state.currentFrame--; renderFrameNav(); renderPreview(); });
el.btnNextFrame.addEventListener("click", () => { state.currentFrame++; renderFrameNav(); renderPreview(); });

/* ---- view transform buttons --------------------------------------------- */

el.btnRotate.addEventListener("click", () => {
  const t = currentView(); t.rotationSteps = (t.rotationSteps + 1) % 4;
  invalidateTileThumb(state.selectedEntry);
  renderInfo(); renderPreview();
});
el.btnFlipH.addEventListener("click", () => {
  const t = currentView(); t.flipH = !t.flipH;
  invalidateTileThumb(state.selectedEntry);
  renderInfo(); renderPreview();
});
el.btnFlipV.addEventListener("click", () => {
  const t = currentView(); t.flipV = !t.flipV;
  invalidateTileThumb(state.selectedEntry);
  renderInfo(); renderPreview();
});
el.btnResetView.addEventListener("click", () => {
  const e = currentEntry();
  state.views[state.selectedEntry] = defaultViewTransformForEntry(e.isUiCategory);
  invalidateTileThumb(state.selectedEntry);
  renderInfo(); renderPreview();
});
el.chkBilinear.addEventListener("change", () => {
  state.bilinear = el.chkBilinear.checked;
  el.previewCanvas.classList.toggle("bilinear", state.bilinear);
  tilePickerThumbCache.clear();
  renderPreview();
});

/* ---- preview rendering --------------------------------------------------- */

function pixels555ToImageData(pixels, w, h, isMonochrome) {
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const p = pixels[i];
    let r, g, b;
    if (isMonochrome) {
      const lvl = monochromeLevel(p) * 17;
      r = g = b = lvl;
    } else {
      [r, g, b] = unpackRGB555(p);
    }
    img.data[i * 4 + 0] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

function getDisplayedFrame() {
  const e = currentEntry();
  const stored = state.archive.getFramePixels(state.selectedEntry, state.currentFrame);
  const r = applyViewTransform(stored, e.width, e.height, currentView());
  return { buf: r.buf, w: r.w, h: r.h, isMonochrome: e.isMonochrome };
}

function renderPreview() {
  const canvas = el.previewCanvas;
  const ctx = canvas.getContext("2d");
  const e = currentEntry();
  if (!e) { canvas.width = 1; canvas.height = 1; ctx.clearRect(0, 0, 1, 1); return; }

  const disp = getDisplayedFrame();
  const src = document.createElement("canvas");
  src.width = disp.w; src.height = disp.h;
  src.getContext("2d").putImageData(pixels555ToImageData(disp.buf, disp.w, disp.h, disp.isMonochrome), 0, 0);

  const scale = Math.max(1, Math.min(16, Math.floor(480 / Math.max(disp.w, disp.h))));
  canvas.width = disp.w * scale;
  canvas.height = disp.h * scale;
  ctx.imageSmoothingEnabled = state.bilinear;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
}

/* ---- export current frame as PNG ----------------------------------------- */

el.btnExport.addEventListener("click", () => {
  const e = currentEntry();
  if (!e) return;
  const disp = getDisplayedFrame();
  const canvas = document.createElement("canvas");
  canvas.width = disp.w; canvas.height = disp.h;
  canvas.getContext("2d").putImageData(pixels555ToImageData(disp.buf, disp.w, disp.h, disp.isMonochrome), 0, 0);
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const base = (state.fileName || "archive").replace(/\.tex$/i, "");
    triggerDownload(url, `${base}_entry${e.index}_frame${state.currentFrame}.png`);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
});

function triggerDownload(url, filename) {
  el.downloadLink.href = url;
  el.downloadLink.download = filename;
  document.body.appendChild(el.downloadLink);
  el.downloadLink.click();
  document.body.removeChild(el.downloadLink);
}

/* ---- import replacement image -------------------------------------------- */

el.btnImport.addEventListener("click", () => {
  if (!currentEntry()) return;
  el.fileInputImage.click();
});

// Dimensions the preview currently displays this entry at (stored dims with
// width/height swapped if the view transform's rotation is odd — flips don't
// change dims). Imported images are auto-fit to this, so the inverse
// transform always lands back on exactly the entry's stored width/height.
function currentDisplayDims(e, view) {
  const swapped = (((view.rotationSteps % 4) + 4) % 4) % 2 === 1;
  return swapped ? { w: e.height, h: e.width } : { w: e.width, h: e.height };
}

el.fileInputImage.addEventListener("change", async () => {
  const file = el.fileInputImage.files[0];
  el.fileInputImage.value = "";
  if (!file) return;
  const e = currentEntry();
  if (!e) return;

  try {
    const bitmap = await loadImage(file);
    const view = currentView();
    const disp = currentDisplayDims(e, view);

    // Auto-fit the imported image to the entry's current resolution (in
    // display space) — stretches/scales as needed, so any source image size
    // works and the frame is always replaced in place (no layout rewrite).
    const cvs = document.createElement("canvas");
    cvs.width = disp.w; cvs.height = disp.h;
    const cctx = cvs.getContext("2d");
    cctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in cctx) cctx.imageSmoothingQuality = "high";
    cctx.drawImage(bitmap, 0, 0, disp.w, disp.h);
    const data = cctx.getImageData(0, 0, disp.w, disp.h).data;

    // RGBA8 -> RGB555 (display orientation)
    let displayed555 = new Uint16Array(disp.w * disp.h);
    for (let i = 0; i < disp.w * disp.h; i++) {
      displayed555[i] = packRGB555(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    if (e.isMonochrome) displayed555 = convertRGB555ToMonochrome(displayed555);

    // display orientation -> stored (archive-native) orientation. Guaranteed
    // to match e.width/e.height exactly since disp was derived from them.
    const inv = invertViewTransform(displayed555, disp.w, disp.h, view);

    state.archive.replaceFrame(state.selectedEntry, state.currentFrame, inv.buf);
    markDirty();
    invalidateTileThumb(state.selectedEntry);
    renderInfo(); renderPreview();
    const scaledNote = (bitmap.width !== disp.w || bitmap.height !== disp.h)
      ? ` (scaled from ${bitmap.width}\u00D7${bitmap.height} to ${disp.w}\u00D7${disp.h})` : "";
    setStatus(`Replaced frame ${state.currentFrame + 1} of entry #${e.index}${scaledNote}.`, "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
    console.error(err);
  }
});

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not load that image file.")); };
    img.src = url;
  });
}

/* ---- save archive --------------------------------------------------------- */

el.btnSave.addEventListener("click", () => {
  if (!state.archive) return;
  const blob = new Blob([state.archive.bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, state.fileName || "archive.tex");
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  state.dirty = false;
  el.btnSave.classList.remove("primary");
  el.fileLabel.textContent = state.fileName;
  setStatus("Archive downloaded.", "ok");
});

window.addEventListener("beforeunload", (ev) => {
  if (state.dirty) { ev.preventDefault(); ev.returnValue = ""; }
});

/* ===========================================================================
   Tile Picker — BUILD-engine-style grid tile picker (port of TilePicker.cpp).
   Shows every entry as a small thumbnail in a scrollable grid. Click a tile
   (or highlight one with arrow keys and press Enter) to jump the main view
   to that entry. Escape closes without changing the selection.
=========================================================================== */

const TILE_IMG = 64;    // thumbnail square size, matches TILE_IMG in TilePicker.cpp
const TILE_CELL = 76;   // rendered CSS cell width (70px tile + 2*3px margin)

const tilePickerThumbCache = new Map(); // entryIdx -> <canvas>
let tilePickerObserver = null;
let tilePickerHighlighted = -1;
let tilePickerOpen = false;

function invalidateTileThumb(idx) {
  tilePickerThumbCache.delete(idx);
}

// Renders entry `idx`'s first frame into a TILE_IMG x TILE_IMG canvas,
// fit inside the square (centered, no cropping) — same approach as
// MakeThumbnail() in TilePicker.cpp.
function renderTileThumbnail(idx) {
  const canvas = document.createElement("canvas");
  canvas.width = TILE_IMG;
  canvas.height = TILE_IMG;
  canvas.className = state.bilinear ? "bilinear" : "";
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#17171a";
  ctx.fillRect(0, 0, TILE_IMG, TILE_IMG);

  const e = state.archive.entries[idx];
  if (e.width === 0 || e.height === 0) return canvas;

  const view = state.views[idx] || { rotationSteps: 0, flipH: false, flipV: false };
  const stored = state.archive.getFramePixels(idx, 0);
  const disp = applyViewTransform(stored, e.width, e.height, view);

  const src = document.createElement("canvas");
  src.width = disp.w; src.height = disp.h;
  src.getContext("2d").putImageData(pixels555ToImageData(disp.buf, disp.w, disp.h, e.isMonochrome), 0, 0);

  const scale = Math.min(TILE_IMG / disp.w, TILE_IMG / disp.h);
  const dw = disp.w * scale, dh = disp.h * scale;
  const offX = (TILE_IMG - dw) / 2, offY = (TILE_IMG - dh) / 2;
  ctx.imageSmoothingEnabled = state.bilinear;
  ctx.drawImage(src, offX, offY, dw, dh);
  return canvas;
}

function getTileThumbnail(idx) {
  let canvas = tilePickerThumbCache.get(idx);
  if (!canvas) {
    canvas = renderTileThumbnail(idx);
    tilePickerThumbCache.set(idx, canvas);
  }
  return canvas;
}

function buildTilePickerGrid() {
  el.tilePickerGrid.innerHTML = "";
  const n = state.archive.entries.length;
  el.tilePickerCount.textContent = `${n} entries`;

  if (tilePickerObserver) tilePickerObserver.disconnect();
  tilePickerObserver = new IntersectionObserver((observed) => {
    for (const rec of observed) {
      if (!rec.isIntersecting) continue;
      const tile = rec.target;
      const idx = Number(tile.dataset.idx);
      const holder = tile.querySelector(".thumb-holder");
      if (holder && !holder.firstChild) holder.appendChild(getTileThumbnail(idx));
      tilePickerObserver.unobserve(tile);
    }
  }, { root: el.tilePickerGrid, rootMargin: "200px 0px" });

  for (let i = 0; i < n; i++) {
    const tile = document.createElement("div");
    tile.className = "tile" + (i === tilePickerHighlighted ? " highlighted" : "");
    tile.dataset.idx = i;

    const holder = document.createElement("div");
    holder.className = "thumb-holder";
    tile.appendChild(holder);

    const label = document.createElement("div");
    label.className = "tile-label";
    label.textContent = "#" + i;
    tile.appendChild(label);

    tile.addEventListener("click", () => {
      selectEntry(i);
      closeTilePicker();
    });

    el.tilePickerGrid.appendChild(tile);
    tilePickerObserver.observe(tile);
  }
}

function tileColumnCount() {
  return Math.max(1, Math.floor(el.tilePickerGrid.clientWidth / TILE_CELL));
}

function setTileHighlighted(idx) {
  const n = state.archive.entries.length;
  idx = Math.max(0, Math.min(n - 1, idx));
  const prev = el.tilePickerGrid.querySelector(".tile.highlighted");
  if (prev) prev.classList.remove("highlighted");
  tilePickerHighlighted = idx;
  const next = el.tilePickerGrid.querySelector(`.tile[data-idx="${idx}"]`);
  if (next) {
    next.classList.add("highlighted");
    next.scrollIntoView({ block: "nearest" });
  }
}

function openTilePicker() {
  if (!state.archive || state.archive.entries.length === 0) return;
  tilePickerOpen = true;
  tilePickerHighlighted = state.selectedEntry >= 0 ? state.selectedEntry : 0;
  buildTilePickerGrid();
  el.tilePickerOverlay.classList.add("show");
  document.addEventListener("keydown", onTilePickerKeydown, true);
  requestAnimationFrame(() => {
    setTileHighlighted(tilePickerHighlighted);
    el.tilePickerGrid.focus();
  });
}

function closeTilePicker() {
  tilePickerOpen = false;
  el.tilePickerOverlay.classList.remove("show");
  document.removeEventListener("keydown", onTilePickerKeydown, true);
  if (tilePickerObserver) { tilePickerObserver.disconnect(); tilePickerObserver = null; }
}

function onTilePickerKeydown(ev) {
  if (!tilePickerOpen) return;
  const cols = tileColumnCount();
  switch (ev.key) {
    case "Escape":
      ev.preventDefault();
      closeTilePicker();
      break;
    case "Enter":
      ev.preventDefault();
      if (tilePickerHighlighted >= 0) { selectEntry(tilePickerHighlighted); closeTilePicker(); }
      break;
    case "ArrowUp":
      ev.preventDefault();
      setTileHighlighted(tilePickerHighlighted - cols);
      break;
    case "ArrowDown":
      ev.preventDefault();
      setTileHighlighted(tilePickerHighlighted + cols);
      break;
    case "ArrowLeft":
      ev.preventDefault();
      setTileHighlighted(tilePickerHighlighted - 1);
      break;
    case "ArrowRight":
      ev.preventDefault();
      setTileHighlighted(tilePickerHighlighted + 1);
      break;
  }
}

el.btnTilePicker.addEventListener("click", openTilePicker);
el.btnTilePickerClose.addEventListener("click", closeTilePicker);
el.tilePickerOverlay.addEventListener("mousedown", (ev) => {
  if (ev.target === el.tilePickerOverlay) closeTilePicker();
});

/* ---- credits ---------------------------------------------------------- */

const CREDITS_HTML =
`Made by Earth, with thanks to:

<span class="credit-name">-Marshmallow Ninja-</span>
The other South Park 64 God. Tons of help from him teaming up to crack this engine open since day one.
Check him out at <a class="credit-link" href="https://themarshmallowninja.itch.io/" target="_blank" rel="noopener noreferrer">https://themarshmallowninja.itch.io/</a>!

<span class="credit-name">-Hell Inspector-</span>
For the support/encouragement, input, texture/model knowledge and overall attention/engagement since day one. Lot more helpful than one would think.
Check him out at <a class="credit-link" href="https://www.youtube.com/@TheHellInspector/videos" target="_blank" rel="noopener noreferrer">https://www.youtube.com/@TheHellInspector</a>!

<span class="credit-name">-Bambo-</span>
For inspiration, clarifying previous discoveries, knowledge on textures/archives.

<span class="credit-name">-ngh-</span>
hey ngh!!! ngh please!!! help!!! ngh... sigh...
(massive help in understanding certain tools or workflows, i would annoy him into rage when i myself was raging over making this, tough love when needed)

<span class="credit-name">-Akela-</span>
Support. Gotta love those that give you encouragement. Plus I see him nearly everywhere I go!`;

function openCredits() {
  el.creditsBody.innerHTML = CREDITS_HTML;
  el.creditsOverlay.classList.add("show");
  document.addEventListener("keydown", onCreditsKeydown, true);
}
function closeCredits() {
  el.creditsOverlay.classList.remove("show");
  document.removeEventListener("keydown", onCreditsKeydown, true);
}
function onCreditsKeydown(ev) {
  if (ev.key === "Escape") { ev.preventDefault(); closeCredits(); }
}

el.btnCredits.addEventListener("click", openCredits);
el.btnCreditsClose.addEventListener("click", closeCredits);
el.creditsOverlay.addEventListener("mousedown", (ev) => {
  if (ev.target === el.creditsOverlay) closeCredits();
});

})();
