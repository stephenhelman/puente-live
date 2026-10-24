// Generates placeholder PNG icons (no dependencies): two overlapping circles on a dark tile. Replace with real art later.
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

function png(size) {
  const bg = [13, 17, 23], blue = [77, 163, 255], amber = [255, 194, 71];
  const r = size * 0.21, cy = size / 2, c1 = size * 0.4, c2 = size * 0.6; // content stays inside the maskable safe zone
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 3;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let a = 0, b = 0, both = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        const ia = (px - c1) ** 2 + (py - cy) ** 2 <= r * r, ib = (px - c2) ** 2 + (py - cy) ** 2 <= r * r;
        if (ia && ib) both++; else if (ia) a++; else if (ib) b++;
      }
      const n = SS * SS, rest = n - a - b - both;
      const mix = [0, 1, 2].map((k) => Math.round((bg[k] * rest + blue[k] * a + amber[k] * b + 255 * both) / n));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = mix[0]; raw[o + 1] = mix[1]; raw[o + 2] = mix[2]; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync("public/icons", { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(`public/icons/${name}`, png(size));
  console.log("wrote public/icons/" + name);
}
