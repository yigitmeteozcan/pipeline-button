#!/usr/bin/env node
/**
 * Generates icon-16.png, icon-48.png, icon-128.png in ./icons/
 * Uses only Node built-ins — no external dependencies.
 * Each icon: blue circle (#0a66c2) with white "+" symbol.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, 'icons');
if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

// ── Minimal PNG encoder ──────────────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = uint32BE(data.length);
  const crc = uint32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([len, typeBytes, data, crc]);
}

function adler32(data) {
  let s1 = 1, s2 = 0;
  for (const b of data) {
    s1 = (s1 + b) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return (s2 << 16) | s1;
}

function deflateRaw(data) {
  // No compression (BTYPE=00 — stored blocks, max 65535 bytes each)
  const blocks = [];
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.slice(offset, offset + 65535);
    const last  = offset + chunk.length >= data.length ? 1 : 0;
    const len   = chunk.length;
    const nlen  = (~len) & 0xffff;
    const header = Buffer.alloc(5);
    header[0] = last;
    header.writeUInt16LE(len,  1);
    header.writeUInt16LE(nlen, 3);
    blocks.push(header, chunk);
    offset += chunk.length;
  }
  return Buffer.concat(blocks);
}

function zlib(data) {
  const raw   = deflateRaw(data);
  const check = adler32(data);
  const head  = Buffer.from([0x78, 0x01]); // CMF=deflate, FLG=no dict
  const tail  = uint32BE(check);
  return Buffer.concat([head, raw, tail]);
}

function encodePNG(width, height, rgba) {
  // Build filtered raw data (filter byte 0 = None for each scanline)
  const rawLines = [];
  for (let y = 0; y < height; y++) {
    rawLines.push(0); // filter type None
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rawLines.push(rgba[i], rgba[i+1], rgba[i+2], rgba[i+3]);
    }
  }
  const rawData   = Buffer.from(rawLines);
  const compressed = zlib(rawData);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon renderer ────────────────────────────────────────────────────────────

function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;
  const r  = size / 2 - 0.5;

  // Blue circle: #0a66c2
  const [bR, bG, bB] = [0x0a, 0x66, 0xc2];

  // "+" arm thickness and length
  const armW = Math.max(2, Math.round(size * 0.12));
  const armL = Math.round(size * 0.35);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const idx  = (y * size + x) * 4;

      if (dist > r) {
        // Transparent outside circle
        pixels[idx]   = 0;
        pixels[idx+1] = 0;
        pixels[idx+2] = 0;
        pixels[idx+3] = 0;
        continue;
      }

      // Anti-aliasing at the edge
      const alpha = dist > r - 1 ? Math.round((r - dist) * 255) : 255;

      const inHBar = Math.abs(dy) <= armW / 2 && Math.abs(dx) <= armL;
      const inVBar = Math.abs(dx) <= armW / 2 && Math.abs(dy) <= armL;

      if (inHBar || inVBar) {
        // White "+"
        pixels[idx]   = 255;
        pixels[idx+1] = 255;
        pixels[idx+2] = 255;
        pixels[idx+3] = alpha;
      } else {
        // Blue background
        pixels[idx]   = bR;
        pixels[idx+1] = bG;
        pixels[idx+2] = bB;
        pixels[idx+3] = alpha;
      }
    }
  }
  return pixels;
}

// ── Generate ─────────────────────────────────────────────────────────────────

for (const size of [16, 48, 128]) {
  const pixels = renderIcon(size);
  const png    = encodePNG(size, size, pixels);
  const dest   = path.join(ICONS_DIR, `icon-${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`Generated ${dest} (${png.length} bytes)`);
}

console.log('Icons generated successfully.');
