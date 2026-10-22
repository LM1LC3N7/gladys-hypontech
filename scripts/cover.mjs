// Generates cover.png (800x534) for gladys-hypontech: plain Node, no dependency.
// A sun over solar panels, each with a small micro-inverter, linked to a cloud
// with a production curve, and a home battery (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.6 + (y / H) * 0.4;
  return [40 + 50 * t, 140 - 70 * t, 210 - 90 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const sun = [255, 200, 50];
const glass = [70, 110, 190];
const green = [90, 210, 130];
const grey = [200, 205, 215];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);

// The sun and its rays.
disc(120, 95, 46, sun);
for (let k = 0; k < 8; k += 1) {
  const a = (k * Math.PI) / 4;
  line(
    120 + 60 * Math.cos(a),
    95 + 60 * Math.sin(a),
    120 + 84 * Math.cos(a),
    95 + 84 * Math.sin(a),
    9,
    sun,
  );
}

// Three solar panels, each with its micro-inverter underneath.
for (let p = 0; p < 3; p += 1) {
  const x0 = 50 + p * 110;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      const x = x0 + col * 46;
      const y = 250 + row * 42;
      box(x, y, x + 42, y + 38, 4, dark);
      box(x + 4, y + 4, x + 38, y + 34, 3, glass, 0.85);
    }
  }
  box(x0 + 22, 386, x0 + 70, 416, 6, white);
  disc(x0 + 34, 401, 5, green);
  line(x0 + 46, 416, x0 + 46, 450, 6, white);
}
line(96, 450, 316, 450, 6, white);

// The link up to the cloud.
line(316, 450, 400, 450, 6, white);
line(400, 450, 470, 300, 6, white);

// The cloud with a production curve.
disc(500, 210, 70, white);
disc(580, 180, 85, white);
disc(670, 215, 65, white);
box(470, 210, 720, 285, 30, white);
let previous;
for (let x = 500; x <= 690; x += 2) {
  const t = (x - 500) / 190;
  const y = 262 - 75 * Math.sin(Math.PI * t) ** 2;
  if (previous) line(previous[0], previous[1], x, y, 6, green);
  previous = [x, y];
}

// The home battery with its charge level.
line(600, 285, 600, 340, 6, white);
box(560, 340, 640, 480, 14, white);
box(585, 328, 615, 342, 4, white);
for (let k = 0; k < 3; k += 1) {
  box(574, 448 - k * 34, 626, 474 - k * 34, 5, green);
}
box(574, 346, 626, 372, 5, grey);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
