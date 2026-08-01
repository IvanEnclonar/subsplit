#!/usr/bin/env node
'use strict';

/**
 * SubSplit icon generator.
 *
 * Pure Node — `zlib` + `fs` only, no npm dependencies. Contains a minimal PNG
 * encoder (IHDR / pHYs / IDAT / IEND, 8-bit RGBA, deflate + CRC32) and a tiny
 * supersampling rasteriser for the app's only piece of artwork: a circle split
 * into four equal wedges, the "one subscription, shared N ways" motif.
 *
 * Outputs (into ../assets):
 *   iconTemplate.png      16x16   macOS tray, template image (black + alpha only)
 *   iconTemplate@2x.png   32x32   macOS tray @2x, 144dpi
 *   tray-win.png          32x32   Windows tray, two-tone neutral
 *   icon.png              512x512 app icon for electron-builder
 *
 * macOS template rules: the filename must end in `Template`, and only the alpha
 * channel matters — AppKit re-colours the silhouette for light/dark menu bars.
 * So the template variants are pure black with an anti-aliased alpha channel.
 *
 * Windows has no template images and its taskbar can be light OR dark, so a
 * single tone would vanish on one of them. tray-win.png / icon.png therefore use
 * two neutral tones on opposite wedge pairs (#444444 and #C8C8C8): the dark pair
 * carries the shape on a light taskbar, the light pair carries it on a dark one.
 *
 * Usage: node scripts/gen-icons.js [outDir]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 (ISO 3309 / PNG flavour) over a Buffer. */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** One PNG chunk: length | type | data | crc(type+data). */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode 8-bit RGBA pixel data as a PNG.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba   width*height*4 bytes, non-premultiplied
 * @param {number} dpi    physical resolution recorded in pHYs (72 or 144)
 * @returns {Buffer}
 */
function encodePng(width, height, rgba, dpi) {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`rgba buffer is ${rgba.length} bytes, expected ${expected}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  // pHYs: pixels per metre. 1 inch = 0.0254 m.
  const ppm = Math.round(dpi / 0.0254);
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys[8] = 1; // unit = metre

  // Scanlines, each prefixed with filter type 0 (None). The shapes are tiny and
  // mostly flat, so deflate at level 9 already gets us within a few bytes of
  // what adaptive filtering would.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The motif: a circle cut into four equal wedges by an axis-aligned cross gap
// ---------------------------------------------------------------------------

const SUPERSAMPLE = 4; // 4x4 = 16 coverage samples per pixel

/**
 * Rasterise the split-circle motif.
 * @param {number} size          square edge in pixels
 * @param {number[][]} tones     [toneA, toneB] as [r,g,b]; toneA gets the
 *                               top-left + bottom-right wedges, toneB the other
 *                               diagonal pair. Pass the same tone twice for a
 *                               single-colour (template) icon.
 * @returns {Buffer} RGBA pixel data
 */
function renderSplitCircle(size, tones) {
  const rgba = Buffer.alloc(size * size * 4); // zero-filled = transparent
  const centre = size / 2;
  const radius = size * 0.44; // ~1px of breathing room at 16px
  const radiusSq = radius * radius;
  // Half-width of the cross-shaped gap. Snapped to whole pixels and to a
  // minimum of 1 so the seam lands on the pixel grid instead of straddling two
  // columns at half alpha — at 16px a soft seam reads as mud, not as a split.
  // 16px/32px -> 2px gap, 512px -> 32px gap.
  const gapHalf = Math.max(1, Math.round(size / 32));
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const step = 1 / SUPERSAMPLE;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const py = y + (sy + 0.5) * step - centre;
        if (Math.abs(py) < gapHalf) continue; // horizontal slit
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) * step - centre;
          if (Math.abs(px) < gapHalf) continue; // vertical slit
          if (px * px + py * py > radiusSq) continue; // outside the disc
          // Diagonal pairs share a tone: TL/BR = tones[0], TR/BL = tones[1].
          const tone = (px < 0) === (py < 0) ? tones[0] : tones[1];
          covered++;
          rSum += tone[0];
          gSum += tone[1];
          bSum += tone[2];
        }
      }

      if (covered === 0) continue;
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(rSum / covered);
      rgba[o + 1] = Math.round(gSum / covered);
      rgba[o + 2] = Math.round(bSum / covered);
      rgba[o + 3] = Math.round((covered / samples) * 255);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const BLACK = [0x00, 0x00, 0x00];
const DARK = [0x44, 0x44, 0x44];
const LIGHT = [0xc8, 0xc8, 0xc8];

const TARGETS = [
  { file: 'iconTemplate.png', size: 16, dpi: 72, tones: [BLACK, BLACK] },
  { file: 'iconTemplate@2x.png', size: 32, dpi: 144, tones: [BLACK, BLACK] },
  { file: 'tray-win.png', size: 32, dpi: 72, tones: [DARK, LIGHT] },
  { file: 'icon.png', size: 512, dpi: 72, tones: [DARK, LIGHT] },
];

function main() {
  const outDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });

  for (const target of TARGETS) {
    const pixels = renderSplitCircle(target.size, target.tones);
    const png = encodePng(target.size, target.size, pixels, target.dpi);
    const dest = path.join(outDir, target.file);
    fs.writeFileSync(dest, png);
    process.stdout.write(
      `${target.file}  ${target.size}x${target.size}  ${target.dpi}dpi  ${png.length} bytes\n`
    );
  }
}

if (require.main === module) main();

module.exports = { crc32, encodePng, renderSplitCircle };
