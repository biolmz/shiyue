'use strict';
/**
 * 拾阅 · 源码分发包打包器（纯 Node，零依赖）
 *
 * 为什么不用 7-Zip / archiver：
 *   两者写中文文件名时都不设 UTF-8 标志位（general purpose bit 11），
 *   macOS 的归档工具会按 CP437 解码 → 解压出来是乱码文件名。
 *   这里统一走 UTF-8 + 置位，同时把 Unix 权限写进 external attributes，
 *   这样 .command 解压后直接带可执行位，双击就能跑。
 *
 * 用法：node tools/make-zip.js [输出路径]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'dist', '拾阅-1.2.0-mac源码包.zip');

// 要打进去的东西（相对项目根）；dist / node_modules 一律不带
const INCLUDE = [
  'README.md',
  'package.json',
  'package-lock.json',
  'server.js',
  '启动.command',
  '打包-mac.command',
  '.github',
  'electron',
  'lib',
  'public',
  'tools',
];

// 带可执行位的文件（其余按 644）
const EXECUTABLE = new Set(['启动.command', '打包-mac.command']);

/* ---------- CRC32 ---------- */
let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- 收集文件 ---------- */
function walk(abs, rel, out) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      if (name === '.DS_Store' || name === 'Thumbs.db' || name === '.git') continue;
      walk(path.join(abs, name), rel ? rel + '/' + name : name, out);
    }
    return;
  }
  if (!st.isFile()) return;
  out.push({ name: rel, abs, mtime: st.mtime });
}

const entries = [];
for (const item of INCLUDE) {
  const abs = path.join(ROOT, item);
  if (!fs.existsSync(abs)) { console.warn('跳过（不存在）: ' + item); continue; }
  walk(abs, item.split(path.sep).join('/'), entries);
}

/* ---------- 写 zip ---------- */
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const locals = [];
const centrals = [];
let offset = 0;

for (const e of entries) {
  const raw = fs.readFileSync(e.abs);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  // 压不动就原样存（小文件常见）
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const nameBuf = Buffer.from(e.name, 'utf8');
  const crc = crc32(raw);
  const { time, date } = dosTime(e.mtime);

  const isExec = EXECUTABLE.has(e.name) || /\.(sh|command)$/.test(e.name);
  const mode = isExec ? 0o100755 : 0o100644;

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);           // version needed
  lh.writeUInt16LE(0x0800, 6);       // bit 11 = 文件名是 UTF-8
  lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
  lh.writeUInt16LE(time, 10);
  lh.writeUInt16LE(date, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  locals.push(lh, nameBuf, body);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(0x031E, 4);       // made by: Unix, 3.0
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
  ch.writeUInt16LE(time, 12);
  ch.writeUInt16LE(date, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(raw.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);           // extra
  ch.writeUInt16LE(0, 32);           // comment
  ch.writeUInt16LE(0, 34);           // disk
  ch.writeUInt16LE(0, 36);           // internal attrs
  ch.writeUInt32LE((mode << 16) >>> 0, 38);   // external attrs
  ch.writeUInt32LE(offset, 42);
  centrals.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...locals, centralBuf, eocd]));

const kb = (n) => (n / 1024).toFixed(0) + 'KB';
console.log('输出 : ' + OUT);
console.log('文件 : ' + entries.length + ' 个，' + kb(fs.statSync(OUT).size));
console.log('可执行位: ' + entries.filter((e) => EXECUTABLE.has(e.name) || /\.(sh|command)$/.test(e.name)).map((e) => e.name).join(', '));
