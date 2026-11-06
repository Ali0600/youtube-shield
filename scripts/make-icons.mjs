// Draws the extension's icons (a shield with a skip-forward mark) into icons/icon-<size>.png, with no dependencies:
// shapes are tested per sub-pixel (4x4 supersampling) and written as an 8-bit RGBA PNG by hand.
// Run: node scripts/make-icons.mjs        (writes the files)
//      node scripts/make-icons.mjs --check (exits 1 if a committed icon differs from what this draws)
import { deflateSync, crc32 } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIZES = [16, 32, 48, 128];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIELD = [67, 56, 202]; // indigo
const MARK = [255, 255, 255];

// Shapes in a unit square, y down. The shield: straight sides to mid-height, then a curve to the point at the bottom.
const inShield = (x, y) => {
  if (y < 0.07 || y > 0.95) return false;
  if (y <= 0.52) return Math.abs(x - 0.5) <= 0.38 - (y < 0.15 ? (0.15 - y) * 0.5 : 0);
  const t = (y - 0.52) / 0.43;
  return Math.abs(x - 0.5) <= 0.38 * (1 - t ** 1.7);
};
// Skip-forward: a play triangle and a bar.
const inMark = (x, y) => {
  const inTri = x >= 0.33 && y >= 0.29 && y <= 0.67 && (x - 0.33) / 0.25 <= 1 - Math.abs(y - 0.48) / 0.19;
  const inBar = x >= 0.6 && x <= 0.67 && y >= 0.29 && y <= 0.67;
  return inTri || inBar;
};

export function draw(size) {
  const S = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let shield = 0;
      let mark = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          if (inShield(x, y)) {
            shield++;
            if (inMark(x, y)) mark++;
          }
        }
      }
      const a = shield / (S * S);
      const m = shield ? mark / shield : 0;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(SHIELD[c] * (1 - m) + MARK[c] * m);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const iconPath = (size) => join(ROOT, 'icons', `icon-${size}.png`);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  let drift = 0;
  for (const size of SIZES) {
    const png = draw(size);
    if (check) {
      let have = null;
      try { have = readFileSync(iconPath(size)); } catch { /* missing */ }
      if (!have || !have.equals(png)) { drift++; console.error(`drift: icons/icon-${size}.png`); }
    } else {
      mkdirSync(dirname(iconPath(size)), { recursive: true });
      writeFileSync(iconPath(size), png);
      console.log(`wrote icons/icon-${size}.png (${png.length} bytes)`);
    }
  }
  if (check) {
    if (drift) process.exit(1);
    console.log('icons match');
  }
}
