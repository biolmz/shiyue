'use strict';
/**
 * 拾阅 · 图标生成器（纯 Node，零依赖）
 *
 * 同一套绘制代码同时产出：
 *   electron/icon.ico   Windows（内嵌 PNG，Vista+ 支持）
 *   electron/icon.icns  macOS（PNG 载荷，icp4~ic10）
 *   electron/icon.png   Linux / 开发时 Dock 预览
 *
 * 用法：node tools/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'electron');

/* ---------------- 画图 ---------------- */

const BG = [30, 74, 62];        // 墨绿底
const PAPER = [253, 252, 248];  // 纸白
const RULE = [150, 190, 176];   // 横线

/** 圆角矩形命中测试（单位坐标 s） */
function inRound(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 渲染一帧 RGBA。SS=3 超采样，边缘不出锯齿。
 * 版式：整块墨绿圆角底 + 中间一张纸 + 5 条横线（最后一短行）
 */
function render(s, SS) {
  const buf = Buffer.alloc(s * s * 4);
  const n = SS * SS;
  const step = 1 / SS;

  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;

          let col = null;
          let alpha = 0;

          // 底：满幅圆角方
          if (inRound(x, y, 0, 0, s, s, s * 0.225)) {
            col = BG; alpha = 1;
          }

          // 纸页
          const px0 = s * 0.265, py0 = s * 0.185;
          const px1 = s * 0.735, py1 = s * 0.815;
          if (inRound(x, y, px0, py0, px1, py1, s * 0.045)) {
            col = PAPER; alpha = 1;

            // 横线：5 条，末条短
            const lx0 = px0 + s * 0.075;
            const lx1 = px1 - s * 0.075;
            const lh = s * 0.037;
            const gap = s * 0.098;
            const top = py0 + s * 0.135;
            for (let i = 0; i < 5; i++) {
              const y0 = top + i * gap;
              const right = i === 4 ? lx1 - (lx1 - lx0) * 0.42 : lx1;
              if (y >= y0 && y <= y0 + lh && x >= lx0 && x <= right) {
                col = RULE; break;
              }
            }
          }

          if (alpha) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }

      const i = (py * s + px) * 4;
      if (a > 0) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

/* ---------------- PNG 编码 ---------------- */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(s, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 每行前加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((s * 4 + 1) * s);
  for (let y = 0; y < s; y++) {
    raw[y * (s * 4 + 1)] = 0;
    rgba.copy(raw, y * (s * 4 + 1) + 1, y * s * 4, (y + 1) * s * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 容器封装 ---------------- */

/** ICO：全部用 PNG 载荷，单条记录最大 256 */
function makeIco(frames) {
  const list = frames.filter((f) => f.s <= 256);
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(list.length, 4);

  const ents = [];
  let offset = 6 + list.length * 16;
  for (const f of list) {
    const e = Buffer.alloc(16);
    e[0] = f.s >= 256 ? 0 : f.s;   // 0 表示 256
    e[1] = f.s >= 256 ? 0 : f.s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(f.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += f.png.length;
    ents.push(e);
  }
  return Buffer.concat([head, ...ents, ...list.map((f) => f.png)]);
}

/** ICNS：icp4=16 icp5=32 icp6=64 ic07=128 ic08=256 ic09=512 ic10=1024 */
const ICNS_TYPES = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };

function makeIcns(frames) {
  const parts = [];
  for (const f of frames) {
    const type = ICNS_TYPES[f.s];
    if (!type) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(f.png.length + 8, 4);
    parts.push(head, f.png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* ---------------- 输出 ---------------- */

/**
 * @param {number} s 画布边长
 * @param {number} padRatio 透明留边比例。macOS 图标按 Apple 网格要留边
 *        （1024 画布里图形占 824，即每边约 9.8%），Windows 满幅。
 */
function frame(s, padRatio) {
  if (!padRatio) return png(s, render(s, s <= 32 ? 4 : 3));

  const inner = Math.max(8, Math.round(s * (1 - padRatio * 2)));
  const art = render(inner, inner <= 32 ? 4 : 3);
  const canvas = Buffer.alloc(s * s * 4);
  const off = Math.round((s - inner) / 2);
  for (let y = 0; y < inner; y++) {
    art.copy(canvas, ((y + off) * s + off) * 4, y * inner * 4, (y + 1) * inner * 4);
  }
  return png(s, canvas);
}

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const winFrames = SIZES.map((s) => ({ s, png: frame(s, 0) }));
const macFrames = SIZES.map((s) => ({ s, png: frame(s, 0.098) }));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.ico'), makeIco(winFrames));
fs.writeFileSync(path.join(OUT, 'icon.icns'), makeIcns(macFrames));
fs.writeFileSync(path.join(OUT, 'icon.png'), macFrames[5].png);   // 512，留边版

const kb = (n) => (n / 1024).toFixed(1) + 'KB';
console.log('icon.ico   ' + kb(fs.statSync(path.join(OUT, 'icon.ico')).size) + '  ' + SIZES.filter((s) => s <= 256).join('/'));
console.log('icon.icns  ' + kb(fs.statSync(path.join(OUT, 'icon.icns')).size) + '  ' + SIZES.join('/'));
console.log('icon.png   ' + kb(fs.statSync(path.join(OUT, 'icon.png')).size) + '  512');
