// Screenshot redaction that works on every platform (macOS uses native/redact.swift; Windows uses this).
// The screenshot is read with on-device text recognition (Tesseract, bundled, no network), every line is
// matched against the secret patterns from redact.js (plus the user's own saved keys), and a black box
// is painted over each match. Nothing leaves the computer, and if recognition fails there is no
// screenshot at all: the caller must treat a thrown error as "do not send".
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { patternsWith, toRegExp } = require('./redact');

const IDLE_MS = 2 * 60 * 1000; // free the recogniser's memory after two quiet minutes

let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();

function dataDir() { return path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0'); }
function coreDir() { return path.dirname(require.resolve('tesseract.js-core/package.json')); }

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('eng', 1, { langPath: dataDir(), corePath: coreDir(), gzip: true, cacheMethod: 'none', logger: () => {} })
      .catch(err => { workerPromise = null; throw err; });
  }
  return workerPromise;
}
function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { const p = workerPromise; workerPromise = null; if (p) p.then(w => w.terminate()).catch(() => {}); }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}
async function shutdown() { clearTimeout(idleTimer); const p = workerPromise; workerPromise = null; if (p) { try { (await p).terminate(); } catch { /* already gone */ } } }

// Characters that text recognition mixes up are treated as the same when looking for the user's own keys.
const CONFUSABLE = { I: 'l', l: 'l', '1': 'l', '|': 'l', O: '0', o: '0', '0': '0', S: '5', s: '5', '5': '5', B: '8', '8': '8', Z: '2', z: '2', '2': '2', g: '9', q: '9', '9': '9' };
const norm = s => Array.from(s, c => CONFUSABLE[c] || c.toLowerCase()).join('');

// Every OCR line with its words, flattened from Tesseract's block tree.
function linesOf(data) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) if (l.text && l.words && l.words.length) out.push(l);
  return out;
}

// Pixel boxes (x0,y0,x1,y1) covering characters [a, b) of a recognised line.
function boxesForRange(line, a, b) {
  const text = line.text;
  const boxes = [];
  let cursor = 0;
  for (const w of line.words) {
    const at = text.indexOf(w.text, cursor);
    if (at < 0) continue;
    cursor = at + w.text.length;
    const s = Math.max(a, at), e = Math.min(b, at + w.text.length);
    if (e <= s) continue;
    const { x0, y0, x1, y1 } = w.bbox, len = Math.max(1, w.text.length), width = x1 - x0;
    boxes.push({ x0: x0 + width * ((s - at) / len), y0, x1: x0 + width * ((e - at) / len), y1 });
  }
  return boxes;
}

// -> list of boxes to black out for these lines
function findBoxes(lines, patterns, secrets) {
  const boxes = [];
  const regexes = patterns.map(p => { try { const r = toRegExp(p); return new RegExp(r.source, r.flags + 'd'); } catch { return null; } }).filter(Boolean);
  const keys = secrets.filter(s => s && s.length >= 8).map(norm);
  for (const line of lines) {
    const text = line.text.replace(/\n$/, '');
    for (const re of regexes) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const r = m.indices && m.indices[1] ? m.indices[1] : m.indices[0]; // the value, not its label, when there is a group
        boxes.push(...boxesForRange(line, r[0], r[1]));
      }
    }
    if (keys.length) {
      const nt = norm(text);
      for (const k of keys) { let at = nt.indexOf(k); while (at >= 0) { boxes.push(...boxesForRange(line, at, at + k.length)); at = nt.indexOf(k, at + k.length); } }
    }
  }
  return boxes;
}

// Black out `boxes` in an RGBA bitmap, with a little slack for recognition being a few pixels off.
function paint(bitmap, w, h, boxes, padX = 6, padY = 4) {
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x0 - padX)), x1 = Math.min(w, Math.ceil(b.x1 + padX));
    const y0 = Math.max(0, Math.floor(b.y0 - padY)), y1 = Math.min(h, Math.ceil(b.y1 + padY));
    for (let y = y0; y < y1; y++) { let o = (y * w + x0) * 4; for (let x = x0; x < x1; x++, o += 4) { bitmap[o] = 0; bitmap[o + 1] = 0; bitmap[o + 2] = 0; bitmap[o + 3] = 255; } }
  }
}

// pngBuffer -> { jpeg: Buffer, redacted: number, width, height }
function redactImage(pngBuffer, { secrets = [], patterns = patternsWith(secrets), quality = 82 } = {}) {
  const run = async () => {
    const png = PNG.sync.read(pngBuffer);
    const worker = await getWorker();
    touchIdle();
    const result = await worker.recognize(pngBuffer, {}, { blocks: true });
    const boxes = findBoxes(linesOf(result.data), patterns, secrets);
    paint(png.data, png.width, png.height, boxes);
    const out = jpeg.encode({ data: png.data, width: png.width, height: png.height }, quality);
    touchIdle();
    return { jpeg: out.data, redacted: boxes.length, width: png.width, height: png.height };
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

module.exports = { redactImage, findBoxes, boxesForRange, paint, norm, shutdown };
