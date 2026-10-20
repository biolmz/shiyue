'use strict';
/**
 * 拾阅 · 本地文献阅读器
 * 零依赖 Node 服务：node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./lib/store');
const net = require('./lib/net');
const { importUrl, importLocalPdf } = require('./lib/importer');

const PORT = Number(process.env.PORT || 7788);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, file, downloadName) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
    };
    if (downloadName) {
      headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(downloadName);
    }
    if (ext === '.pdf') headers['Content-Disposition'] = 'inline';
    res.writeHead(200, Object.assign(headers, ext === '.pdf' || ext === '.html' ? {} : { 'Cache-Control': 'max-age=86400' }));
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- 业务 ---------------- */

function listItems(q) {
  let list = store.getIndex();
  if (q) {
    const kw = q.toLowerCase();
    list = list.filter((it) =>
      (it.title || '').toLowerCase().includes(kw) ||
      (it.site || '').toLowerCase().includes(kw) ||
      (it.author || '').toLowerCase().includes(kw) ||
      (it.desc || '').toLowerCase().includes(kw) ||
      (it.note || '').toLowerCase().includes(kw) ||
      (it.tags || []).some((t) => String(t).toLowerCase().includes(kw))
    );
  }
  return list;
}

function exportMarkdown(id) {
  const doc = store.getDoc(id);
  const idx = store.getIndex().find((x) => x.id === id);
  if (!doc || !idx) return null;
  const annos = store.getAnnos(id).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const L = [];
  L.push('# ' + idx.title);
  L.push('');
  const metaLine = [idx.author, idx.journal || idx.site, idx.date].filter(Boolean).join(' · ');
  if (metaLine) L.push('> ' + metaLine);
  if (idx.url) L.push('> <' + idx.url + '>');
  L.push('');
  if (idx.note) {
    L.push('## 我的笔记');
    L.push('');
    L.push(idx.note);
    L.push('');
  }
  if (annos.length) {
    L.push('## 划线摘录与批注（' + annos.length + '）');
    L.push('');
    for (const a of annos) {
      L.push('- **' + (a.text || '').replace(/\n+/g, ' ') + '**');
      if (a.note) L.push('  - 💬 ' + a.note);
      if (a.tags && a.tags.length) L.push('  - `' + a.tags.join('` `') + '`');
    }
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push('## 原文');
  L.push('');
  for (const b of doc.blocks) {
    if (b.type === 'img') { if (b.src) L.push('![](' + b.src + ')'); continue; }
    if (b.type === 'h2') { L.push('### ' + b.text); L.push(''); continue; }
    if (b.type === 'h3') { L.push('#### ' + b.text); L.push(''); continue; }
    if (b.type === 'quote') { L.push('> ' + b.text); L.push(''); continue; }
    if (b.type === 'li') { L.push('- ' + b.text); continue; }
    if (b.type === 'pre') { L.push('```'); L.push(b.text); L.push('```'); L.push(''); continue; }
    L.push(b.text);
    L.push('');
  }
  return L.join('\n');
}

function bibKey(it) {
  const first = (it.author || '').split(/[,，;；]/)[0].trim().replace(/\s+/g, '');
  const y = (it.date || '').slice(0, 4) || 'nd';
  const w = (it.title || '').replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 6);
  return (first || 'anon') + y + w;
}

function toBibtex(list) {
  const out = [];
  for (const it of list) {
    const type = it.journal || it.doi ? 'article' : 'misc';
    const fields = [];
    const add = (k, v) => {
      if (!v) return;
      fields.push('  ' + k + ' = {' + String(v).replace(/[{}]/g, '').replace(/\n+/g, ' ') + '}');
    };
    add('title', it.title);
    add('author', (it.author || '').replace(/\s*等\s*\d+\s*位作者\s*$/, '').replace(/\s*[,，]\s*/g, ' and '));
    add('journal', it.journal);
    if (it.date) add('year', String(it.date).slice(0, 4));
    if (it.date && it.date.length > 4) add('date', it.date);
    add('doi', it.doi);
    add('url', it.url);
    if (it.note) add('note', it.note);
    if (it.tags && it.tags.length) add('keywords', it.tags.join(', '));
    out.push('@' + type + '{' + bibKey(it) + ',\n' + fields.join(',\n') + '\n}');
  }
  return out.join('\n\n') + '\n';
}

/* ---------------- 路由 ---------------- */

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/items' && req.method === 'GET') {
    return json(res, 200, { items: listItems(url.searchParams.get('q') || '') });
  }

  // 上传本地 PDF：请求体就是文件本身
  if (p === '/api/upload' && req.method === 'POST') {
    const name = url.searchParams.get('name') || 'document.pdf';
    const MAX = 300 * 1024 * 1024;
    const id = store.newId('i');
    const dest = path.join(store.mediaDir(id), 'paper.pdf');
    let size = 0;
    const ws = fs.createWriteStream(dest);
    try {
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX) { req.destroy(); reject(new Error('文件超过 300MB')); }
        });
        req.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        req.pipe(ws);
      });
    } catch (e) {
      try { ws.destroy(); } catch (e2) {}
      store.removeItem(id);
      return json(res, 400, { error: e.message || '上传失败' });
    }

    // 校验是不是真 PDF
    let head = Buffer.alloc(5);
    try {
      const fd = fs.openSync(dest, 'r');
      fs.readSync(fd, head, 0, 5, 0);
      fs.closeSync(fd);
    } catch (e) {}
    if (head.toString('latin1').indexOf('%PDF') !== 0) {
      store.removeItem(id);
      return json(res, 400, { error: '不是有效的 PDF 文件' });
    }

    const item = importLocalPdf(id, dest, name);
    return json(res, 200, { item });
  }

  if (p === '/api/import' && req.method === 'POST') {
    const body = await readBody(req);
    const raw = String(body.url || '').trim();
    if (!raw) return json(res, 400, { error: '请粘贴一个链接' });
    const urls = raw.split(/\s*[\n,]\s*/).map((s) => s.trim()).filter(Boolean);
    const done = [];
    const failed = [];
    for (const u of urls.slice(0, 6)) {
      try {
        done.push(await importUrl(u));
      } catch (e) {
        failed.push({ url: u, error: e.message || String(e) });
      }
    }
    if (!done.length && failed.length) return json(res, 422, { error: failed[0].error, failed });
    return json(res, 200, { items: done, failed });
  }

  const mItem = p.match(/^\/api\/item\/([\w-]+)$/);
  if (mItem) {
    const id = mItem[1];
    if (req.method === 'GET') {
      const doc = store.getDoc(id);
      const meta = store.getIndex().find((x) => x.id === id);
      if (!doc || !meta) return json(res, 404, { error: '不存在' });
      return json(res, 200, { item: meta, blocks: doc.blocks, annotations: store.getAnnos(id) });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const allow = ['title', 'tags', 'starred', 'read', 'progress', 'note', 'author', 'site', 'journal', 'date'];
      const patch = {};
      for (const k of allow) if (k in body) patch[k] = body[k];
      const it = store.patchIndex(id, patch);
      if (!it) return json(res, 404, { error: '不存在' });
      return json(res, 200, { item: it });
    }
    if (req.method === 'DELETE') {
      store.removeItem(id);
      return json(res, 200, { ok: true });
    }
  }

  const mAnno = p.match(/^\/api\/item\/([\w-]+)\/annotations$/);
  if (mAnno && req.method === 'POST') {
    const id = mAnno[1];
    const body = await readBody(req);
    const kind = body.kind === 'pdf' ? 'pdf' : 'text';
    if (kind === 'pdf') {
      if (!body.pages || !body.pages.length) return json(res, 400, { error: '缺少选区' });
    } else if (!body.ranges || !body.ranges.length) {
      return json(res, 400, { error: '缺少选区' });
    }
    const list = store.getAnnos(id);
    const anno = {
      id: 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind,
      ranges: kind === 'text' ? body.ranges : [],
      pages: kind === 'pdf' ? body.pages : [],
      text: String(body.text || ''),
      note: String(body.note || ''),
      color: body.color || 'yellow',
      tags: [],
      createdAt: new Date().toISOString(),
    };
    list.push(anno);
    store.saveAnnos(id, list);
    return json(res, 200, { anno, count: list.length });
  }

  const mAnnoOne = p.match(/^\/api\/item\/([\w-]+)\/annotations\/([\w-]+)$/);
  if (mAnnoOne) {
    const id = mAnnoOne[1];
    const aid = mAnnoOne[2];
    const list = store.getAnnos(id);
    const i = list.findIndex((a) => a.id === aid);
    if (i < 0) return json(res, 404, { error: '批注不存在' });
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      for (const k of ['note', 'color', 'tags']) if (k in body) list[i][k] = body[k];
      store.saveAnnos(id, list);
      return json(res, 200, { anno: list[i] });
    }
    if (req.method === 'DELETE') {
      list.splice(i, 1);
      store.saveAnnos(id, list);
      return json(res, 200, { ok: true, count: list.length });
    }
  }

  const mExport = p.match(/^\/api\/item\/([\w-]+)\/export$/);
  if (mExport && req.method === 'GET') {
    const md = exportMarkdown(mExport[1]);
    if (!md) return json(res, 404, { error: '不存在' });
    const idx = store.getIndex().find((x) => x.id === mExport[1]);
    const name = (idx.title || 'reading').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.md';
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
    });
    return res.end(md);
  }

  if (p === '/api/reveal' && req.method === 'POST') {
    const { execFile } = require('child_process');
    const dir = store.DATA;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 建不了就交给系统报错 */ }
    // macOS 用 open -R 在访达里选中，Windows 用资源管理器，其余走 xdg-open
    const [bin, args] =
      process.platform === 'darwin' ? ['open', ['-R', dir]]
        : process.platform === 'win32' ? ['explorer.exe', [dir]]
          : ['xdg-open', [dir]];
    execFile(bin, args, { windowsHide: false }, () => {});
    return json(res, 200, { ok: true });
  }

  if (p === '/api/export/bibtex') {
    const list = store.getIndex();
    if (!list.length) return json(res, 400, { error: '文库还是空的' });
    const txt = toBibtex(list);
    res.writeHead(200, {
      'Content-Type': 'application/x-bibtex; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('拾阅文库_' + new Date().toISOString().slice(0, 10) + '.bib'),
    });
    return res.end(txt);
  }

  if (p === '/api/stats') {
    const list = store.getIndex();
    return json(res, 200, {
      total: list.length,
      annos: list.reduce((a, b) => a + (b.annoCount || 0), 0),
      tags: [...new Set(list.flatMap((x) => x.tags || []))],
      proxy: net.proxyLabel(await net.getProxy()),
      dir: store.DATA,
    });
  }

  return json(res, 404, { error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = decodeURIComponent(url.pathname);

  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    // 本地图片 / PDF
    if (p.startsWith('/media/')) {
      const rel = p.slice(7).replace(/\.\./g, '');
      return serveStatic(res, path.join(store.MEDIA, rel));
    }

    // 图片代理（本地下载失败时的兜底）
    if (p === '/proxy') {
      const target = url.searchParams.get('url');
      const referer = url.searchParams.get('ref') || '';
      if (!target) return send(res, 400, 'missing url', 'text/plain');
      try {
        const r = await net.request(target, {
          timeout: 15000,
          referer: referer || target,
          headers: { 'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8' },
        });
        if (!r.ok) return send(res, 502, 'upstream ' + r.status, 'text/plain');
        const buf = r.buffer;
        res.writeHead(200, {
          'Content-Type': r.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'max-age=86400',
        });
        return res.end(buf);
      } catch (e) {
        return send(res, 502, 'proxy failed', 'text/plain');
      }
    }

    // 静态资源
    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(PUBLIC, 'index.html'));
    const rel = p.replace(/^\/+/, '').replace(/\.\./g, '');
    return serveStatic(res, path.join(PUBLIC, rel));
  } catch (e) {
    console.error('[ERR]', req.method, p, e);
    if (!res.headersSent) json(res, 500, { error: e.message || '服务器内部错误' });
    else res.end();
  }
});

function start(port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error('端口 ' + port + ' 已被占用。如果拾阅已经在运行，直接打开 http://127.0.0.1:' + port + ' 就行。'));
      } else reject(e);
    };
    server.once('error', onErr);
    server.listen(port === undefined ? PORT : port, '127.0.0.1', () => {
      server.removeListener('error', onErr);
      resolve(server.address().port);
    });
  });
}

function banner(actualPort) {
  console.log('\n' + '─'.repeat(52));
  console.log('  拾阅 · 本地文献阅读器  →  http://127.0.0.1:' + actualPort);
  console.log('  数据目录：' + store.DATA);
  console.log('  按 Ctrl+C 退出');
  console.log('─'.repeat(52) + '\n');
  net.getProxy().then((px) => console.log('  网络出口：' + net.proxyLabel(px) + '\n'));
}

if (require.main === module) {
  start().then(banner).catch((e) => {
    console.error('\n  ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = { start, server, banner };
