// Builds build/icon.ico (PNG-compressed entries, Windows Vista and later) from PNGs of each size.
// Usage: node build/make-ico.js <dir with 16.png 24.png ... 256.png> <out.ico>
const fs = require('fs'), path = require('path');
const dir = process.argv[2], out = process.argv[3];
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(s => fs.readFileSync(path.join(dir, `${s}.png`)));
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0); e.writeUInt8(s === 256 ? 0 : s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
fs.writeFileSync(out, Buffer.concat([head, ...entries, ...pngs]));
console.log('wrote', out, offset, 'bytes');
