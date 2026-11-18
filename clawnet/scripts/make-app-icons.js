#!/usr/bin/env node
/**
 * Draw the phone app's home-screen icons from the ClawNet mark (console/public/favicon.svg:
 * a dark square, an amber ring, an amber centre dot), without any image library.
 *
 *   web/app/icons/icon-192.png, icon-512.png  the mark as in the SVG, rounded corners
 *   web/app/icons/icon-maskable-512.png       full-bleed square for Android's masks; the
 *                                             ring lies inside the 80 % safe zone
 *   web/app/icons/apple-touch-icon.png        180 px, full bleed (iOS rounds it itself)
 *
 * Shapes are rasterised with 4 x 4 supersampling and written as RGBA PNGs with node:zlib.
 * The geometry and colours are the SVG's; only the corner treatment differs per platform.
 *
 * Usage: node scripts/make-app-icons.js
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'app', 'icons');

// The mark in its own 32-unit coordinate system (console/public/favicon.svg).
const MARK = { size: 32, corner: 6, centre: 16, ringRadius: 10, ringWidth: 2, dotRadius: 4.5 };
const BACKGROUND = [0x08, 0x0b, 0x10];
const AMBER = [0xf2, 0xa6, 0x5a];
const SAMPLES = 4;

/**
 * @param {number} size output width and height in pixels
 * @param {boolean} rounded transparent rounded corners, as in the SVG
 * @returns {Buffer} RGBA pixels
 */
export function drawMark(size, rounded) {
  const scale = size / MARK.size;
  const pixels = Buffer.alloc(size * size * 4);
  const inner = MARK.ringRadius - MARK.ringWidth / 2;
  const outer = MARK.ringRadius + MARK.ringWidth / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let background = 0;
      let amber = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          // Sample position in mark units.
          const u = (x + (sx + 0.5) / SAMPLES) / scale;
          const v = (y + (sy + 0.5) / SAMPLES) / scale;
          if (rounded && !insideRoundedSquare(u, v)) continue;
          const d = Math.hypot(u - MARK.centre, v - MARK.centre);
          if (d <= MARK.dotRadius || (d >= inner && d <= outer)) amber += 1;
          else background += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = (background + amber) / total;
      const i = (y * size + x) * 4;
      if (alpha === 0) continue;
      for (let c = 0; c < 3; c += 1) {
        pixels[i + c] = Math.round((BACKGROUND[c] * background + AMBER[c] * amber) / (background + amber));
      }
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function insideRoundedSquare(u, v) {
  const r = MARK.corner;
  const max = MARK.size;
  if (u < 0 || v < 0 || u > max || v > max) return false;
  const cx = u < r ? r : u > max - r ? max - r : u;
  const cy = v < r ? r : v > max - r ? max - r : v;
  return Math.hypot(u - cx, v - cy) <= r;
}

/** Encode RGBA pixels as a PNG (colour type 6, 8 bits, no interlace). */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function main() {
  const icons = [
    ['icon-192.png', 192, true],
    ['icon-512.png', 512, true],
    ['icon-maskable-512.png', 512, false],
    ['apple-touch-icon.png', 180, false],
  ];
  for (const [name, size, rounded] of icons) {
    writeFileSync(join(OUT, name), encodePng(size, size, drawMark(size, rounded)));
    process.stdout.write(`wrote web/app/icons/${name}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
