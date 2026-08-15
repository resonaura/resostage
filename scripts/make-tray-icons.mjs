import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function makeChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(4 + 4 + len + 4);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, "ascii");
  data.copy(buf, 8);
  const crc = crc32(buf.subarray(4, 8 + len));
  buf.writeUInt32BE(crc, 8 + len);
  return buf;
}

function createPng(width, height, drawPixel) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const ihdrChunk = makeChunk("IHDR", ihdr);
  const rawData = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, y, width, height);
      rawData[offset++] = r;
      rawData[offset++] = g;
      rawData[offset++] = b;
      rawData[offset++] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = makeChunk("IDAT", compressedData);
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

// Draw crisp ResoStage 'R' wave icon for system tray
function drawResoIcon(rVal, gVal, bVal) {
  return (x, y, w, h) => {
    // 32x32 icon canvas with 4px padding
    const nx = (x - 4) / (w - 8);
    const ny = (y - 4) / (h - 8);

    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      return [0, 0, 0, 0];
    }

    // Stem (left bar)
    const isStem = nx >= 0.1 && nx <= 0.35 && ny >= 0.1 && ny <= 0.9;
    // Top curve / loop of 'R'
    const dx = nx - 0.55;
    const dy = ny - 0.32;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const isTopLoop = dist >= 0.18 && dist <= 0.38 && nx >= 0.3;
    // Diagonal leg of 'R'
    const isLeg = nx >= 0.35 && nx <= 0.85 && ny >= 0.5 && Math.abs((ny - 0.5) - (nx - 0.35) * 0.8) <= 0.12;

    if (isStem || isTopLoop || isLeg) {
      return [rVal, gVal, bVal, 255];
    }
    return [0, 0, 0, 0];
  };
}

const ROOT = path.resolve(import.meta.dirname, "..");
const iconsDir = path.join(ROOT, "icons");

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// White icon for dark taskbars (255, 255, 255)
const whitePng = createPng(32, 32, drawResoIcon(255, 255, 255));
fs.writeFileSync(path.join(iconsDir, "tray-white.png"), whitePng);

// Dark icon for light taskbars (24, 24, 27)
const darkPng = createPng(32, 32, drawResoIcon(24, 24, 27));
fs.writeFileSync(path.join(iconsDir, "tray-dark.png"), darkPng);

console.log("✓ Generated icons/tray-white.png and icons/tray-dark.png");
