#!/usr/bin/env node
// 生成 PWA 图标（192 / 512 / 512-maskable）。
// 为什么手写 PNG 而不引入依赖：仓库前端是零依赖的，为三张图装 sharp/canvas 不划算。
// 这里直接用 zlib + CRC32 拼 PNG，图形用比例坐标绘制，任意尺寸都成立。
//
// 用法：node tools/gen_icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BRAND = [0x00, 0x71, 0xe3, 255];   // 与 favicon.svg 同色
const WHITE = [255, 255, 255, 255];

function makeIcon(size, opts) {
  const rgba = Buffer.alloc(size * size * 4);
  // 背景整块铺满（Android 会按用途自行裁圆角/圆形）
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = BRAND[0]; rgba[i * 4 + 1] = BRAND[1];
    rgba[i * 4 + 2] = BRAND[2]; rgba[i * 4 + 3] = 255;
  }
  const s = opts.scale;   // 图形占画布比例
  const cx = size / 2;
  const cy = size / 2;
  const unit = size * s;
  function rect(x0, y0, x1, y1, color) {
    const ax = Math.max(0, Math.round(cx + x0 * unit));
    const ay = Math.max(0, Math.round(cy + y0 * unit));
    const bx = Math.min(size, Math.round(cx + x1 * unit));
    const by = Math.min(size, Math.round(cy + y1 * unit));
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) {
        const i = (y * size + x) * 4;
        rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = color[3];
      }
    }
  }
  function disc(dx, dy, r, color) {
    const px = cx + dx * unit, py = cy + dy * unit, pr = r * unit;
    const x0 = Math.max(0, Math.floor(px - pr)), x1 = Math.min(size, Math.ceil(px + pr));
    const y0 = Math.max(0, Math.floor(py - pr)), y1 = Math.min(size, Math.ceil(py + pr));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
        if (d <= pr) {
          const i = (y * size + x) * 4;
          rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = color[3];
        }
      }
    }
  }
  // 车体：白圆角矩形用「三段矩形」近似（上/中/下），圆角靠两端内缩
  rect(-0.30, -0.26, 0.30, 0.26, WHITE);
  // 车头窗带（品牌色横条）
  rect(-0.24, -0.10, 0.24, 0.06, BRAND);
  // 车轮
  disc(-0.17, 0.34, 0.085, WHITE);
  disc(0.17, 0.34, 0.085, WHITE);
  // 受电弓/天线（车顶两条斜线用竖线近似）
  rect(-0.20, -0.46, -0.16, -0.30, WHITE);
  rect(0.16, -0.46, 0.20, -0.30, WHITE);
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, "..", "public");
const targets = [
  { file: "icon-192.png", size: 192, scale: 0.62 },
  { file: "icon-512.png", size: 512, scale: 0.62 },
  // maskable：Android 会按 mask 裁掉边缘，图形必须缩到中心安全区（约 80%）
  { file: "icon-512-maskable.png", size: 512, scale: 0.42 },
];
for (const t of targets) {
  const buf = makeIcon(t.size, { scale: t.scale });
  fs.writeFileSync(path.join(outDir, t.file), buf);
  console.log("wrote", t.file, buf.length, "bytes");
}
