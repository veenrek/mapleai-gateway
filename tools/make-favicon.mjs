import { writeFileSync } from "node:fs";

const S = 32, SS = 4, N = S * SS;
const BG = [0x0f, 0x11, 0x17];
const FG = [0x5b, 0x8c, 0xff];

function insideRounded(u, v, w, h, r) {
  if (u < 0 || v < 0 || u > w || v > h) return false;
  const rx = Math.min(r, w / 2);
  let cx = null, cy = null;
  if (u < rx && v < rx) { cx = rx; cy = rx; }
  else if (u > w - rx && v < rx) { cx = w - rx; cy = rx; }
  else if (u < rx && v > h - rx) { cx = rx; cy = h - rx; }
  else if (u > w - rx && v > h - rx) { cx = w - rx; cy = h - rx; }
  else return true;
  return (u - cx) ** 2 + (v - cy) ** 2 <= rx * rx;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function sample(u, v) {
  if (!insideRounded(u, v, 100, 100, 22)) return [0, 0, 0, 0];
  let c = BG;
  if (Math.abs(Math.hypot(u - 50, v - 50) - 30) <= 3.6) c = FG;
  const d = Math.min(
    segDist(u, v, 30, 50, 45, 65),
    segDist(u, v, 45, 65, 70, 35),
  );
  if (d <= 3.6) c = FG;
  return [c[0], c[1], c[2], 1];
}

const px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SS; j++) {
      for (let i = 0; i < SS; i++) {
        const u = ((x * SS + i + 0.5) * 100) / N;
        const v = ((y * SS + j + 0.5) * 100) / N;
        const s = sample(u, v);
        r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
      }
    }
    const n = SS * SS;
    const idx = (y * S + x) * 4;
    px[idx] = a > 0 ? Math.round(r / a) : 0;
    px[idx + 1] = a > 0 ? Math.round(g / a) : 0;
    px[idx + 2] = a > 0 ? Math.round(b / a) : 0;
    px[idx + 3] = Math.round((a / n) * 255);
  }
}

// BITMAPINFOHEADER (height doubled for XOR+AND mask)
const hdr = Buffer.alloc(40);
hdr.writeUInt32LE(40, 0);
hdr.writeInt32LE(S, 4);
hdr.writeInt32LE(S * 2, 8);
hdr.writeUInt16LE(1, 12);
hdr.writeUInt16LE(32, 14);
hdr.writeUInt32LE(0, 16);

const xor = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  const src = (S - 1 - y) * S * 4;
  for (let x = 0; x < S; x++) {
    const s = src + x * 4, d = (y * S + x) * 4;
    xor[d] = px[s + 2];
    xor[d + 1] = px[s + 1];
    xor[d + 2] = px[s];
    xor[d + 3] = px[s + 3];
  }
}
const rowBytes = Math.ceil(S / 8 / 4) * 4;
const and = Buffer.alloc(rowBytes * S);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (px[(y * S + x) * 4 + 3] === 0) and[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
}

const image = Buffer.concat([hdr, xor, and]);
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = S; entry[1] = S; entry[2] = 0; entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(22, 12);

const ico = Buffer.concat([dir, entry, image]);
writeFileSync(process.argv[2], ico);
console.log("favicon written:", process.argv[2], ico.length, "bytes");