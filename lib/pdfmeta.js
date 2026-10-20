'use strict';
/**
 * pdfmeta.js — 从 PDF 文件里抠元数据（不依赖任何第三方库）
 * 只读文件头部 3MB，够覆盖 Info 字典和 XMP。
 */
const fs = require('fs');

function unescapePdfString(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push(raw.charCodeAt(i)); continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'n') out.push(10);
    else if (n === 'r') out.push(13);
    else if (n === 't') out.push(9);
    else if (n === 'b') out.push(8);
    else if (n === 'f') out.push(12);
    else if (n >= '0' && n <= '7') {
      let oct = n;
      for (let k = 0; k < 2 && raw[i + 1] >= '0' && raw[i + 1] <= '7'; k++) oct += raw[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (n === '\n') { /* 续行 */ }
    else out.push(n.charCodeAt(0));
  }
  return Buffer.from(out);
}

function bytesToText(buf) {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.slice(2);
    let s = '';
    for (let i = 0; i + 1 < body.length; i += 2) s += String.fromCharCode((body[i] << 8) | body[i + 1]);
    return s;
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  // PDFDocEncoding ≈ latin1，中文场景基本走不到这里
  return buf.toString('latin1');
}

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const buf = Buffer.alloc(Math.floor(clean.length / 2));
  for (let i = 0; i < buf.length; i++) buf[i] = parseInt(clean.substr(i * 2, 2), 16);
  return buf;
}

function pickInfo(text, key) {
  const re = new RegExp('/' + key + '\\s*(?:\\(((?:\\\\.|[^\\\\)])*)\\)|<([0-9A-Fa-f\\s]+)>)');
  const m = text.match(re);
  if (!m) return '';
  try {
    const bytes = m[1] !== undefined ? unescapePdfString(m[1]) : hexToBytes(m[2]);
    const s = bytesToText(bytes).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > 1 && s.length < 400 ? s : '';
  } catch (e) {
    return '';
  }
}

/** @returns {{title:string,author:string,subject:string,pages:number,doi:string,year:string}} */
function pdfMeta(filePath) {
  const out = { title: '', author: '', subject: '', pages: 0, doi: '', year: '' };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, 3 * 1024 * 1024);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    const text = buf.toString('latin1');

    out.title = pickInfo(text, 'Title');
    out.author = pickInfo(text, 'Author');
    out.subject = pickInfo(text, 'Subject');

    // 页数：数 /Type /Page（排除 /Pages）
    const m1 = text.match(/\/Type\s*\/Page[^s]/g);
    if (m1) out.pages = m1.length;
    if (!out.pages) {
      const m2 = text.match(/\/Count\s+(\d+)/);
      if (m2) out.pages = parseInt(m2[1], 10);
    }

    // DOI
    const dm = text.match(/10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]{4,60}/);
    if (dm) out.doi = dm[0].replace(/[.,;)]+$/, '');

    // 年份：CreationDate 或 XMP
    const cm = text.match(/\/CreationDate\s*\(D:(\d{4})/) || text.match(/xmp:CreateDate[^>]*>(\d{4})/);
    if (cm) out.year = cm[1];
  } catch (e) {
    // 忽略，返回已解析到的部分
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
  return out;
}

module.exports = { pdfMeta };
