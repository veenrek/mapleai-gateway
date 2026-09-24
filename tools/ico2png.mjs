import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const b = readFileSync(process.argv[2]);
const S = b[6];
const off = b.readUInt32LE(18);
const xorOff = off + 40;
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  const rowStart = xorOff + (S - 1 - y) * S * 4;
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    const s = rowStart + x * 4, d = y * (S * 4 + 1) + 1 + x * 4;
    raw[d] = b[s + 2]; raw[d + 1] = b[s + 1]; raw[d + 2] = b[s]; raw[d + 3] = b[s + 3];
  }
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crcBuf = Buffer.concat([t, data]);
  let c = ~0;
  for (const byte of crcBuf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(process.argv[3], png);
console.log("png written", png.length);