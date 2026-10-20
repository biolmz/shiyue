/* 由 tools/make-mobile-extract.js 从 lib/extract.js 生成，不要手改 */
(function () {
  var module = { exports: {} };
  var exports = module.exports;
'use strict';
/**
 * extract.js — 零依赖 HTML 正文提取
 * 思路：先定位正文容器（公众号取 #js_content，其余用文本密度启发式），
 *       再把 h1-6 / p / li / blockquote / pre / img 转成结构化 blocks。
 * 输出：{ blocks:[{type,text,src}], images:[url], title, meta }
 *
 * block.type: p | h2 | h3 | li | quote | pre | img
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', times: '×', divide: '÷',
  deg: '°', plusmn: '±', micro: 'µ', para: '¶', sect: '§',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  phi: 'φ', omega: 'ω', Delta: 'Δ', Omega: 'Ω', Sigma: 'Σ',
  prime: '′', Prime: '″', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', radic: '√',
  zwj: '\u200d', zwnj: '\u200c', shy: '',
};

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,31});/g, (m, e) => {
    if (e[0] === '#') {
      const code = (e[1] === 'x' || e[1] === 'X')
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

function getAttr(tagHtml, name) {
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = tagHtml.match(re);
  if (!m) return '';
  return decodeEntities((m[1] || m[2] || m[3] || '').trim());
}

function absUrl(src, base) {
  if (!src) return '';
  src = src.trim();
  if (/^(data|javascript|about|blob):/i.test(src)) return '';
  if (src.startsWith('//')) return 'https:' + src;
  try { return new URL(src, base).href; } catch (e) { return ''; }
}

/** 清掉必然会污染正文的容器 */
function stripJunk(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style|noscript|svg|iframe|canvas|template|object|embed|select|textarea|button|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|noscript)\b[^>]*\/?>/gi, '');
}

/** 从标签起始处做同名标签配平，返回内部 HTML */
function balanceFrom(html, startIdx, tagName) {
  const openEnd = html.indexOf('>', startIdx);
  if (openEnd < 0) return '';
  if (html[openEnd - 1] === '/') return '';
  let depth = 1;
  const re = new RegExp('<(/?)' + tagName + '\\b[^>]*>', 'gi');
  re.lastIndex = openEnd + 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].endsWith('/>')) continue;
    if (m[1]) {
      depth--;
      if (depth === 0) return html.slice(openEnd + 1, m.index);
    } else depth++;
  }
  return html.slice(openEnd + 1);
}

/** 公众号：定位 #js_content / .rich_media_content */
function findWeixinScope(html) {
  const re = /(?:id|class)\s*=\s*["'][^"']*(?:js_content|rich_media_content)[^"']*["']/i;
  const m = re.exec(html);
  if (!m) return null;
  const divStart = html.lastIndexOf('<div', m.index);
  if (divStart < 0) return null;
  const inner = balanceFrom(html, divStart, 'div');
  return inner.length > 200 ? inner : null;
}

/** 通用：抽全量 blocks 后再按文本密度裁头尾 */
function blocksToScope(blocks, aggressive) {
  if (!aggressive) return blocks;
  const solid = blocks
    .map((b, i) => ((b.type === 'p' || b.type === 'quote' || b.type === 'li') && b.text.length >= 40 ? i : -1))
    .filter((i) => i >= 0);
  if (solid.length < 2) return blocks;
  const first = solid[0];
  const last = solid[solid.length - 1];
  // 首段前最多保留 3 个块（可能是导语/小标题），尾段后最多留 4 个
  const start = Math.max(0, first - 3);
  const end = Math.min(blocks.length, last + 5);
  const sliced = blocks.slice(start, end);
  return sliced.length >= 3 ? sliced : blocks;
}

const JUNK_LINE = new Set([
  '首页', '登录', '注册', '分享', '收藏', '点赞', '在看', '阅读原文', '关注', '返回',
  '更多', '搜索', '推荐阅读', '相关阅读', '热门推荐', '评论', '上一篇', '下一篇',
  '广告', '举报', '转载', '声明', '编辑', '责编', '审核', '打开APP', '下载APP',
  '扫码关注', '长按识别', '点击上方', '点击蓝字', '设为星标', '分享到朋友圈',
]);

function isJunkLine(t) {
  if (!t) return true;
  if (t.length > 24) return false;
  if (JUNK_LINE.has(t)) return true;
  if (/^[\s\-—–_=*·.。,，:：|/\\]+$/.test(t)) return true;
  if (/^(阅读|点赞|在看|分享)\s*[\d.]+[万千]?$/i.test(t)) return true;
  if (/^\d{1,3}\s*(阅读|浏览)$/.test(t)) return true;
  return false;
}

/**
 * 主入口
 * @param {string} html 原始 HTML
 * @param {string} baseUrl 用于解析相对链接
 * @param {object} opts { weixin:boolean, aggressive:boolean }
 */
function extract(html, baseUrl, opts) {
  opts = opts || {};
  const images = [];
  let src = stripJunk(html);

  let scoped = false;
  if (opts.weixin) {
    const s = findWeixinScope(src);
    if (s) { src = s; scoped = true; }
  }

  // ---------- 1. 表格 → 占位符（公众号 / 论文页里的数据表格） ----------
  const tables = [];
  src = src.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (m, inner) => {
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(inner))) {
      const cells = [];
      const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let td;
      while ((td = tdRe.exec(tr[1]))) {
        const v = decodeEntities(td[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        cells.push(v);
      }
      if (cells.filter(Boolean).length) rows.push(cells);
    }
    if (!rows.length) return '';
    if (rows.length === 1 && rows[0].length === 1) return '\n' + rows[0][0] + '\n';
    tables.push(rows);
    return '\n@@TABLE:' + (tables.length - 1) + '@@\n';
  });

  // ---------- 2. 图片 → 占位符 ---------- ----------
  src = src.replace(/<img\b[^>]*>/gi, (tag) => {
    const raw = getAttr(tag, 'data-src') || getAttr(tag, 'data-original') ||
                getAttr(tag, 'data-actualsrc') || getAttr(tag, 'src');
    const u = absUrl(raw, baseUrl);
    if (!u) return '';
    if (/\.(gif|svg)(\?|$)/i.test(u) && /(spacer|blank|loading|placeholder|1x1)/i.test(u)) return '';
    const w = parseInt(getAttr(tag, 'width'), 10);
    if (w && w <= 2) return '';
    images.push(u);
    return '\n@@IMG:' + (images.length - 1) + '@@\n';
  });

  // ---------- 2. pre / code 块 → 占位符（保护换行） ----------
  const pres = [];
  src = src.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => {
    const txt = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '');
    if (!txt.trim()) return '';
    pres.push(txt);
    return '\n@@PRE:' + (pres.length - 1) + '@@\n';
  });

  // ---------- 3. 标题 ----------
  src = src.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lvl, inner) => {
    const txt = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!txt) return '';
    const level = parseInt(lvl, 10);
    const mark = level <= 2 ? '@@H2@@' : level === 3 ? '@@H3@@' : '@@H4@@';
    return '\n' + mark + txt + '\n';
  });

  // ---------- 4. 引用 ----------
  src = src.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, inner) => {
    const txt = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!txt) return '';
    return '\n@@QUOTE@@' + txt + '\n';
  });

  // ---------- 5. 列表项 ----------
  src = src.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (m, inner) => {
    const txt = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!txt) return '';
    return '\n@@LI@@' + txt + '\n';
  });

  // ---------- 6. 其余块级边界 → 换行 ----------
  src = src
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|td|tr|table|figure|figcaption|dl|dd|dt|main|h[1-6]|blockquote|ul|ol)>/gi, '\n')
    .replace(/<(p|div|section|article|td|tr|figure|main)\b[^>]*>/gi, '\n');

  // ---------- 6.5 链接加哨兵，供后面算"链接密度"（导航行通常全是链接） ----------
  src = src.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '\u0001$1\u0002');

  // ---------- 7. 剥掉所有标签 ----------
  src = src.replace(/<[^>]+>/g, '');
  src = decodeEntities(src);
  src = src.replace(/\u00a0/g, ' ').replace(/[ \t\u3000]+/g, ' ');

  // ---------- 8. 逐行解析 ----------
  const blocks = [];
  const push = (type, text, extra) => {
    if (type === 'img') {
      blocks.push({ type: 'img', text: '', src: extra });
      return;
    }
    text = (text || '').replace(/[\u0001\u0002]/g, '').trim();
    if (!text) return;
    if (type !== 'h2' && type !== 'h3' && type !== 'h4' && isJunkLine(text)) return;
    blocks.push({ type: type === 'h4' ? 'h3' : type, text });
  };

  for (const rawLine of src.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;

    // 链接密度：整行几乎都是超链接 → 导航/相关阅读，丢掉
    if (line.indexOf('\u0001') >= 0) {
      const plain = line.replace(/[\u0001\u0002]/g, '');
      const linked = (line.match(/\u0001[\s\S]*?\u0002/g) || [])
        .map((s) => s.replace(/[\u0001\u0002]/g, '')).join('').length;
      if (plain.length > 12 && linked / plain.length > 0.62) continue;
      line = plain;
    }

    const imgM = line.match(/^@@IMG:(\d+)@@$/);
    if (imgM) { push('img', '', images[+imgM[1]]); continue; }

    const preM = line.match(/^@@PRE:(\d+)@@$/);
    if (preM) { push('pre', pres[+preM[1]]); continue; }

    const tblM = line.match(/^@@TABLE:(\d+)@@$/);
    if (tblM) {
      const rows = tables[+tblM[1]];
      if (rows && rows.length) blocks.push({ type: 'table', text: '', rows });
      continue;
    }

    if (line.startsWith('@@H2@@')) { push('h2', line.slice(6)); continue; }
    if (line.startsWith('@@H3@@')) { push('h3', line.slice(6)); continue; }
    if (line.startsWith('@@H4@@')) { push('h3', line.slice(6)); continue; }
    if (line.startsWith('@@QUOTE@@')) { push('quote', line.slice(9)); continue; }
    if (line.startsWith('@@LI@@')) { push('li', line.slice(6)); continue; }

    // 占位符被换行破坏的残片，直接丢
    if (/@@(IMG|PRE|H2|H3|H4|QUOTE|LI|TABLE)[:@]/.test(line)) continue;

    push('p', line);
  }

  // 合并被 <br> 打断的段落：短行且上一行也短、不以标点结尾 → 视为同段
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (
      b.type === 'p' && prev && prev.type === 'p' &&
      prev.text.length < 40 && !/[。！？；：.!?;:"”』】]$/.test(prev.text) &&
      /^[，。、；：」』”]/.test(b.text)
    ) {
      prev.text = prev.text + b.text;
      continue;
    }
    merged.push(b);
  }

  const finalBlocks = blocksToScope(merged, !scoped && opts.aggressive !== false);

  // 相邻重复行去重
  const dedup = [];
  for (const b of finalBlocks) {
    const p = dedup[dedup.length - 1];
    if (p && b.type !== 'img' && p.type === b.type && p.text === b.text && b.text.length < 40) continue;
    dedup.push(b);
  }

  return { blocks: trimTail(dedup), images };
}

/** 砍掉文末的"关注公众号 / 扫码 / 点赞在看"尾巴 */
function trimTail(blocks) {
  if (blocks.length < 12) return blocks;
  const HIT = /(敬请|扫码|长按识别|二维码|星标|点赞|在看|转发|关注我们|关注|公众号|点击上方)/;
  const from = Math.max(0, blocks.length - 8);
  for (let i = from; i < blocks.length; i++) {
    const t = blocks[i].text || '';
    if (!t || t.length > 30 || !HIT.test(t)) continue;
    const rest = blocks.slice(i + 1).filter((b) => b.type !== 'img' && (b.text || '').length > 40);
    if (rest.length === 0) return blocks.slice(0, i);
  }
  return blocks;
}

/* ---------------- 元数据 ---------------- */

function metaFromHtml(html, url) {
  const head = (html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i) || [, html.slice(0, 20000)])[1];
  const pick = (patterns) => {
    for (const re of patterns) {
      const m = head.match(re);
      if (m && m[1] && m[1].trim()) return decodeEntities(m[1].trim());
    }
    return '';
  };

  const title = pick([
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']citation_title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ]);

  const desc = pick([
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']citation_abstract["'][^>]+content=["']([^"']+)["']/i,
  ]);

  const site = pick([
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i,
  ]) || (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })();

  const author = pick([
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
  ]);

  const date = pick([
    /<meta[^>]+name=["']citation_publication_date["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
  ]);

  const cover = pick([
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ]);

  const journal = pick([
    /<meta[^>]+name=["']citation_journal_title["'][^>]+content=["']([^"']+)["']/i,
  ]);
  const doi = pick([
    /<meta[^>]+name=["']citation_doi["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']DC\.Identifier["'][^>]+content=["'](10\.[^"']+)["']/i,
  ]);

  return {
    title: cleanTitle(title, site),
    desc: desc.slice(0, 600),
    site, author, date: normDate(date), cover: absUrl(cover, url),
    journal, doi,
  };
}

function cleanTitle(t, site) {
  if (!t) return '未命名';
  let s = t.replace(/\s+/g, ' ').trim();
  if (site && s.includes(' - ') && s.endsWith(' - ' + site)) s = s.slice(0, -(site.length + 3));
  if (site && s.includes('_') && s.endsWith('_' + site)) s = s.slice(0, -(site.length + 1));
  return s.trim() || '未命名';
}

function normDate(s) {
  if (!s) return '';
  const m = String(s).match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  const y = String(s).match(/^(\d{4})/);
  return y ? y[1] : '';
}

module.exports = { extract, metaFromHtml, decodeEntities, absUrl };

  window.ShiyueExtract = module.exports;
})();
