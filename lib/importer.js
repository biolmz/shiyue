'use strict';
/**
 * importer.js — 抓取 → 提取 → 入库
 * 支持：微信公众号 / arXiv / DOI / 普通网页 / 直链 PDF
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const net = require('./net');
const { extract, metaFromHtml, decodeEntities } = require('./extract');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 25000;

/* ---------------- 工具 ---------------- */

function normalizeUrl(input) {
  let s = String(input || '').trim();
  // 从"分享文本"里抠链接
  const m = s.match(/https?:\/\/[^\s"'<>）)】\]，,；;]+/i);
  if (m) s = m[0];
  s = s.replace(/[)）,，。；;】\]"'<>]+$/, '');
  if (!/^https?:\/\//i.test(s)) {
    if (/^(10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+)$/.test(s)) return 'https://doi.org/' + s;
    if (/^arxiv:/i.test(s)) return 'https://arxiv.org/abs/' + s.slice(6);
    if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return 'https://arxiv.org/abs/' + s;
    s = 'https://' + s;
  }
  const u = new URL(s);
  u.hash = '';
  // 公众号短链保持原样
  if (/^mp\.weixin\.qq\.com$/.test(u.hostname) && /^\/s\/?$/.test(u.pathname)) return u.href;
  return u.href;
}

function detectKind(url) {
  let u;
  try { u = new URL(url); } catch (e) { return 'web'; }
  const host = u.hostname;
  if (/^mp\.weixin\.qq\.com$/i.test(host)) return 'wechat';
  if (/(^|\.)arxiv\.org$/i.test(host)) return 'arxiv';
  if (/(^|\.)doi\.org$/i.test(host)) return 'doi';
  if (/\.pdf(\?|$)/i.test(u.pathname + u.search)) return 'pdf';
  return 'web';
}

function decodeBody(buf, contentType) {
  let charset = (contentType.match(/charset=([\w-]+)/i) || [, ''])[1].toLowerCase();
  if (!charset) {
    const head = buf.slice(0, 4000).toString('latin1');
    const m = head.match(/charset\s*=\s*["']?([\w-]+)/i);
    if (m) charset = m[1].toLowerCase();
  }
  if (/gb2312|gbk|gb18030/.test(charset)) charset = 'gb18030';
  if (!charset || charset === 'iso-8859-1' || charset === 'utf-8' || charset === 'utf8') charset = 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch (e) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

async function httpGet(url, opts) {
  opts = opts || {};
  return net.request(url, {
    timeout: opts.timeout || TIMEOUT,
    referer: opts.referer,
    headers: opts.headers,
  });
}

/* ---------------- 元数据补全 ---------------- */

function jatsToText(s) {
  if (!s) return '';
  return decodeEntities(
    s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  );
}

async function crossrefMeta(doi) {
  try {
    const res = await httpGet('https://api.crossref.org/works/' + encodeURIComponent(doi), {
      headers: { Accept: 'application/json' }, timeout: 15000,
    });
    if (!res.ok) return null;
    const j = await res.json();
    const m = j.message || {};
    const authors = (m.author || [])
      .map((a) => [a.given, a.family].filter(Boolean).join(' '))
      .filter(Boolean);
    const date = (m.issued && m.issued['date-parts'] && m.issued['date-parts'][0]) || [];
    return {
      title: (m.title && m.title[0]) || '',
      authors,
      journal: (m['container-title'] && m['container-title'][0]) || '',
      date: date.length ? date.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, '0'))).join('-') : '',
      doi: m.DOI || doi,
      type: m.type || '',
      abstract: jatsToText(m.abstract),
      url: m.URL || '',
    };
  } catch (e) {
    return null;
  }
}

async function arxivMeta(id) {
  try {
    const res = await httpGet('https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(id), {
      timeout: 15000,
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const grab = (tag) => {
      const m = xml.match(new RegExp('<(?:' + tag + ')[^>]*>([\\s\\S]*?)</(?:' + tag + ')>', 'i'));
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };
    const entry = xml.split('<entry>')[1] || '';
    const g = (tag) => {
      const m = entry.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
      return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) : '';
    };
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)]
      .map((x) => x[1].replace(/\s+/g, ' ').trim());
    return {
      title: g('title') || grab('title'),
      summary: g('summary'),
      authors,
      date: (g('published') || '').slice(0, 10),
      journal: 'arXiv preprint',
      id,
    };
  } catch (e) {
    return null;
  }
}

/* ---------------- 图片本地化 ---------------- */

async function localizeImages(itemId, blocks, referer) {
  const dir = store.mediaDir(itemId);
  const jobs = [];
  let n = 0;
  for (const b of blocks) {
    if (b.type !== 'img' || !b.src) continue;
    const src = b.src;
    if (src.startsWith('/media/')) continue;
    const idx = n++;
    jobs.push((async () => {
      try {
        const res = await httpGet(src, { referer, timeout: 18000 });
        if (!res.ok) return;
        const ct = res.headers.get('content-type') || '';
        if (!/^image\//i.test(ct)) return;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 800 || buf.length > 12 * 1024 * 1024) return;
        const ext = (/image\/(jpeg|jpg)/i.test(ct) ? 'jpg'
          : /image\/png/i.test(ct) ? 'png'
            : /image\/gif/i.test(ct) ? 'gif'
              : /image\/webp/i.test(ct) ? 'webp'
                : /image\/svg/i.test(ct) ? 'svg' : 'jpg');
        const file = idx + '.' + ext;
        fs.writeFileSync(path.join(dir, file), buf);
        b.src = '/media/' + itemId + '/' + file;
      } catch (e) { /* 保底走 /proxy 代理 */ }
    })());
  }
  // 并发 5
  const chunk = 5;
  for (let i = 0; i < jobs.length; i += chunk) {
    await Promise.all(jobs.slice(i, i + chunk));
  }
}

/* ---------------- PDF 下载 ---------------- */

function curlOnce(bin, url, dest, referer) {
  return new Promise((resolve) => {
    const args = ['-L', '--fail', '-sS', '--max-time', '90', '-A', UA, '-o', dest];
    if (referer) args.push('-e', referer);
    args.push(url);
    execFile(bin, args, { windowsHide: true, timeout: 100000 }, (err) => {
      if (err) return resolve(false);
      try { resolve(fs.statSync(dest).size > 1000); } catch (e) { resolve(false); }
    });
  });
}

/**
 * 下载 PDF 到本地。优先用系统 curl（能吃到系统代理，抓大文件快），失败回退 Node fetch。
 * @returns {string|null} 本地相对路径
 */
async function downloadPdf(url, itemId, referer) {
  const dest = path.join(store.mediaDir(itemId), 'paper.pdf');
  try {
    const res = await httpGet(url, { timeout: 60000, referer });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1000 && buf.slice(0, 4).toString() === '%PDF') {
        fs.writeFileSync(dest, buf);
        return '/media/' + itemId + '/paper.pdf';
      }
    }
  } catch (e) { /* 走 curl 兜底 */ }
  // macOS / Linux 只有 curl，Windows 上 Git Bash 自带的是 curl.exe
  const bins = process.platform === 'win32' ? ['curl.exe', 'curl'] : ['curl'];
  for (const bin of bins) {
    if (await curlOnce(bin, url, dest, referer)) return '/media/' + itemId + '/paper.pdf';
  }
  return null;
}

/* ---------------- 主流程 ---------------- */

/** 正文开头常重复一遍标题，去掉 */
function stripDupTitle(blocks, title) {
  if (!blocks.length || !title) return blocks;
  const norm = (s) => String(s).replace(/[\s\u3000:：\-—|·、]/g, '');
  const t = norm(title);
  const b0 = blocks[0];
  if (b0 && (b0.type === 'h2' || b0.type === 'h3' || b0.type === 'p') && b0.text) {
    const x = norm(b0.text);
    if (x === t || (x.length >= 6 && (t.includes(x) || x.includes(t)))) return blocks.slice(1);
  }
  return blocks;
}

function countChars(blocks) {
  return blocks.reduce((a, b) => {
    let n = b.text ? b.text.length : 0;
    if (b.rows) n += b.rows.reduce((x, r) => x + r.join('').length, 0);
    return a + n;
  }, 0);
}

async function buildWebItem(url, kind) {
  const res = await httpGet(url, {
    referer: kind === 'wechat' ? 'https://mp.weixin.qq.com/' : '',
  });
  const ct = res.headers.get('content-type') || '';

  // 直链 PDF 或服务器直接吐 PDF
  if (/application\/pdf/i.test(ct)) {
    return { kind: 'pdf', pdfUrl: url, meta: {} };
  }
  if (!res.ok) throw new Error('抓取失败：HTTP ' + res.status + '（可能需要登录，或该站点限制抓取）');

  const buf = Buffer.from(await res.arrayBuffer());
  const html = decodeBody(buf, ct);

  if (kind === 'wechat' && /(环境异常|去验证|该内容已被发布者删除|参数错误)/.test(html.slice(0, 6000))) {
    throw new Error('微信拦下了这次请求（环境异常/需验证）。可稍后重试，或用浏览器打开后另存网页再导入。');
  }

  const meta = metaFromHtml(html, url);

  // 公众号：作者/时间常在正文头部
  if (kind === 'wechat') {
    const am = html.match(/id=["']js_name["'][^>]*>([\s\S]*?)</i);
    if (am) meta.author = decodeEntities(am[1].replace(/<[^>]+>/g, '')).trim() || meta.author;
    const dm = html.match(/id=["']publish_time["'][^>]*>([\s\S]*?)</i);
    if (dm) meta.date = (dm[1].match(/\d{4}-\d{2}-\d{2}/) || [meta.date])[0];
    if (!meta.site) meta.site = '微信公众号';
  }

  const out = extract(html, url, { weixin: kind === 'wechat', aggressive: kind !== 'wechat' });
  if (!out.blocks.length) throw new Error('没能提取到正文（该页面可能是纯 JS 渲染或需要登录）。');

  return { kind: kind === 'wechat' ? 'wechat' : 'web', blocks: out.blocks, meta, html };
}

function truncAuthors(s, max) {
  if (!s) return '';
  max = max || 6;
  const parts = String(s).split(/\s*[,，;；]\s*|\s+、\s*/).filter(Boolean);
  if (parts.length <= max) return s;
  return parts.slice(0, 4).join(', ') + ' 等 ' + parts.length + ' 位作者';
}

/** arXiv abs 页里的题录字段 */
function arxivPageMeta(html) {
  const cell = (cls) => {
    const m = html.match(new RegExp('<td[^>]*class="[^"]*' + cls + '[^"]*"[^>]*>([\\s\\S]*?)</td>', 'i'));
    return m ? decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
  };
  return {
    comments: cell('comments'),
    jref: cell('jref'),
    subjects: cell('subjects'),
  };
}

async function importUrl(rawUrl, opts) {
  opts = opts || {};
  const url = normalizeUrl(rawUrl);
  let kind = detectKind(url);
  const id = store.newId('i');

  let result;
  let pdfRel = null;
  let blocks = [];
  let meta = {};
  let extra = {};

  if (kind === 'arxiv') {
    const aid = (url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#/]+)/i) || [, ''])[1];
    const cleanId = aid ? aid.replace(/\.pdf$/i, '') : '';
    const am = cleanId ? await arxivMeta(cleanId) : null;
    let pageMeta = {};
    let html = '';
    try {
      const pr = await httpGet(url);
      if (pr.ok) {
        html = decodeBody(Buffer.from(await pr.arrayBuffer()), pr.headers.get('content-type') || '');
        pageMeta = arxivPageMeta(html);
        meta = metaFromHtml(html, url);
      }
    } catch (e) {}
    const authors = (am && am.authors && am.authors.length) ? am.authors.join(', ') : (meta.author || '');
    meta = Object.assign({}, meta, {
      title: (am && am.title) || meta.title,
      author: authors,
      date: (am && am.date) || meta.date,
      site: 'arXiv',
      journal: 'arXiv preprint',
    });
    if (am) {
      blocks = [];
      blocks.push({ type: 'h2', text: 'Abstract' });
      if (am.summary) blocks.push({ type: 'p', text: am.summary.replace(/\s+/g, ' ') });
      blocks.push({ type: 'h2', text: '题录' });
      blocks.push({ type: 'li', text: 'arXiv: ' + cleanId });
      if (am.date) blocks.push({ type: 'li', text: '提交日期：' + am.date });
      if (pageMeta.subjects) blocks.push({ type: 'li', text: '学科：' + pageMeta.subjects });
      if (pageMeta.comments) blocks.push({ type: 'li', text: 'Comments：' + pageMeta.comments });
      if (pageMeta.jref) blocks.push({ type: 'li', text: 'Journal ref：' + pageMeta.jref });
    } else if (html) {
      blocks = extract(html, url, { aggressive: true }).blocks;
    }
    if (cleanId) {
      pdfRel = await downloadPdf('https://arxiv.org/pdf/' + cleanId, id, url);
    }
  } else if (kind === 'doi') {
    const doi = decodeURIComponent(url.replace(/^https?:\/\/doi\.org\//i, ''));
    const cm = await crossrefMeta(doi);
    let pageBlocks = [];
    try {
      const r = await buildWebItem(url, 'web');
      pageBlocks = r.blocks;
      meta = r.meta;
    } catch (e) { meta = {}; }
    const authors = (cm && cm.authors && cm.authors.length) ? cm.authors.join(', ') : (meta.author || '');
    meta = Object.assign({}, meta, {
      title: (cm && cm.title) || meta.title || ('DOI: ' + doi),
      author: authors,
      journal: (cm && cm.journal) || meta.journal,
      date: (cm && cm.date) || meta.date,
      doi,
      site: (cm && cm.journal) || meta.site || 'DOI',
    });
    if (pageBlocks.length >= 8) {
      blocks = pageBlocks;
    } else {
      blocks = [];
      blocks.push({ type: 'h2', text: 'Abstract' });
      if (cm && cm.abstract) blocks.push({ type: 'p', text: cm.abstract });
      blocks.push({ type: 'h2', text: '题录' });
      blocks.push({ type: 'li', text: 'DOI: ' + doi });
      if (cm && cm.journal) blocks.push({ type: 'li', text: '期刊：' + cm.journal });
      if (cm && cm.date) blocks.push({ type: 'li', text: '日期：' + cm.date });
      blocks.push({ type: 'p', text: '这个 DOI 的全文通常需要机构订阅或登录，所以这里只存了题录与摘要。要点可以写在右侧「笔记」里，导出时会放在最前面。' });
    }
  } else if (kind === 'pdf') {
    pdfRel = await downloadPdf(url, id);
    if (!pdfRel) throw new Error('PDF 下载失败：文件过大、需要登录，或网络超时');
    const fn = decodeURIComponent((url.split('/').pop() || 'document').split('?')[0]);
    meta = { title: fn.replace(/\.pdf$/i, ''), site: new URL(url).hostname };
    blocks = [];
  } else {
    result = await buildWebItem(url, kind);
    if (result.pdfUrl) {
      pdfRel = await downloadPdf(result.pdfUrl, id, url);
      kind = 'pdf';
      meta = result.meta;
      blocks = [];
    } else {
      blocks = result.blocks;
      meta = result.meta;
    }
  }

  /* ---- 组装 ---- */
  const pdfPath = pdfRel;

  await localizeImages(id, blocks, kind === 'wechat' ? 'https://mp.weixin.qq.com/' : url);
  blocks = stripDupTitle(blocks, meta.title || '');

  const chars = countChars(blocks);
  const item = {
    id,
    kind: pdfPath ? (kind === 'pdf' ? 'pdf' : kind + '+pdf') : kind,
    url,
    title: meta.title || '未命名',
    site: meta.site || hostOf(url),
    author: truncAuthors(meta.author || '', 5),
    date: meta.date || '',
    journal: meta.journal || '',
    doi: meta.doi || '',
    desc: meta.desc || '',
    cover: blocks.find((b) => b.type === 'img' && b.src) ? (blocks.find((b) => b.type === 'img' && b.src)).src : '',
    tags: opts.tags || [],
    starred: false,
    read: false,
    progress: 0,
    note: '',
    pdf: pdfPath,
    chars,
    readingTime: Math.max(1, Math.round(chars / (meta.journal ? 500 : 400))),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    annoCount: 0,
  };

  store.saveDoc(id, { id, blocks, meta: item });
  store.upsertIndex(item);
  return item;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

/** 导入本地 PDF（文件已在 data/media/<id>/paper.pdf） */
function importLocalPdf(id, filePath, filename) {
  const { pdfMeta } = require('./pdfmeta');
  const m = pdfMeta(filePath);
  const rawName = decodeURIComponent(String(filename || 'document.pdf'));
  const base = rawName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const generic = /^(untitled|document|microsoft word|新建\s*microsoft word|无标题)/i;
  const title = (m.title && !generic.test(m.title) && m.title.length > 3) ? m.title : (base || '未命名');
  const site = m.author || '本地 PDF';

  const item = {
    id,
    kind: 'pdf',
    url: '',
    title: title.slice(0, 300),
    site,
    author: truncAuthors(m.author || '', 5),
    date: m.year || '',
    journal: '',
    doi: m.doi || '',
    desc: m.subject || '',
    cover: '',
    tags: [],
    starred: false,
    read: false,
    progress: 0,
    note: '',
    pdf: '/media/' + id + '/paper.pdf',
    pages: m.pages || 0,
    chars: 0,
    readingTime: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    annoCount: 0,
  };

  store.saveDoc(id, { id, blocks: [], meta: item });
  store.upsertIndex(item);
  return item;
}

module.exports = { importUrl, importLocalPdf, normalizeUrl, detectKind, hostOf };
