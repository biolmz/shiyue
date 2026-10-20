'use strict';
/* 拾阅 · 前端 */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const api = async (url, method, body) => {
  const opt = { method: method || 'GET', headers: {} };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || '请求失败');
  return data;
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 平台：macOS 上把 Ctrl 显示成 ⌘，别让人按错键 */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') ||
  /Mac/.test(navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/* ══════════ 状态 ══════════ */
const S = {
  items: [],
  sel: null,        // 选中的条目（详情面板）
  cur: null,        // 阅读中的条目
  blocks: [],
  annos: [],
  blockEls: [],
  mode: 'text',     // 'text' | 'pdf'
  filter: 'all',
  tag: null,
  query: '',
  sort: { by: 'createdAt', desc: true },
  sideOpen: true,
  prefs: { font: 'serif', fs: 17, width: 720, theme: 'paper' },
};

const PREFS_KEY = 'shiyue.prefs.v2';

function loadPrefs() {
  try { Object.assign(S.prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) {}
  applyPrefs();
}
function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs));
  applyPrefs();
}
function applyPrefs() {
  const p = S.prefs;
  document.documentElement.style.setProperty('--fs', p.fs + 'px');
  document.documentElement.style.setProperty('--w', p.width + 'px');
  $('#docBody').classList.toggle('font-sans', p.font === 'sans');
  $('#readerView').dataset.theme = p.theme;
  $$('.seg button[data-font]').forEach((b) => b.classList.toggle('on', b.dataset.font === p.font));
  $$('.seg button[data-width]').forEach((b) => b.classList.toggle('on', +b.dataset.width === p.width));
  updateZoomLabel();
}

function updateZoomLabel() {
  const el = $('#zoomVal');
  if (!el) return;
  if (S.mode === 'pdf' && window.PdfView && PdfView.numPages) {
    el.textContent = Math.round(PdfView.scale * 100) + '%';
  } else {
    el.textContent = S.prefs.fs + 'px';
  }
}

/* ══════════ 小工具 ══════════ */
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = 'toast'), isErr ? 4200 : 2200);
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s).slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  if (d.getFullYear() === new Date().getFullYear()) return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return d.getFullYear() + '-' + pad(d.getMonth() + 1);
}
function kindLabel(it) {
  if (it.kind === 'wechat') return ['公众号', 'wechat'];
  if (it.kind === 'pdf') return ['PDF', 'pdf'];
  if (/arxiv|doi/.test(it.kind) || it.journal) return ['论文', 'paper'];
  return ['网页', 'web'];
}

/* ══════════ 列表 ══════════ */
async function loadList() {
  const data = await api('/api/items');
  S.items = data.items || [];
  renderList();
  renderTags();
}

function filtered() {
  let list = S.items;
  const f = S.filter;
  if (f === 'unread') list = list.filter((x) => !x.read);
  else if (f === 'star') list = list.filter((x) => x.starred);
  else if (f === 'marked') list = list.filter((x) => (x.annoCount || 0) > 0);
  else if (f === 'wechat') list = list.filter((x) => x.kind === 'wechat');
  else if (f === 'paper') list = list.filter((x) => /arxiv|doi|pdf/.test(x.kind) || x.journal);
  else if (f === 'web') list = list.filter((x) => x.kind === 'web');

  if (S.tag) list = list.filter((x) => (x.tags || []).includes(S.tag));

  if (S.query) {
    const kw = S.query.toLowerCase();
    list = list.filter((x) =>
      (x.title || '').toLowerCase().includes(kw) ||
      (x.site || '').toLowerCase().includes(kw) ||
      (x.author || '').toLowerCase().includes(kw) ||
      (x.desc || '').toLowerCase().includes(kw) ||
      (x.note || '').toLowerCase().includes(kw) ||
      (x.tags || []).some((t) => String(t).toLowerCase().includes(kw)));
  }

  const { by, desc } = S.sort;
  list = list.slice().sort((a, b) => {
    let va = a[by] || '', vb = b[by] || '';
    if (by === 'title') { va = String(va); vb = String(vb); }
    else { va = String(va); vb = String(vb); }
    const r = va < vb ? -1 : va > vb ? 1 : 0;
    return desc ? -r : r;
  });
  return list;
}

function renderList() {
  const list = filtered();
  const box = $('#itemList');
  box.innerHTML = '';

  const all = S.items.length;
  updateCounts();

  $('#statLine').textContent = all
    ? all + ' 个条目 · ' + S.items.reduce((a, b) => a + (b.annoCount || 0), 0) + ' 条批注'
    : '文库为空';
  $('#brandSub').textContent = all ? all + ' 个条目' : '文献与长文';

  $('#empty').hidden = list.length > 0 || all > 0 ? (list.length > 0) : false;
  if (!list.length) {
    if (all > 0) {
      box.innerHTML = '<div style="padding:30px 14px;text-align:center;font-size:12px;color:#B7B0A0">没有符合条件的条目</div>';
      $('#empty').hidden = true;
    }
    return;
  }
  $('#empty').hidden = true;

  for (const it of list) {
    const [label, cls] = kindLabel(it);
    const row = document.createElement('div');
    row.className = 'row' + (it.read ? '' : ' unread') + (S.sel && S.sel.id === it.id ? ' sel' : '');
    row.dataset.id = it.id;
    row.title = it.title;
    row.innerHTML =
      '<span class="c-type ' + cls + '">' + label + '</span>' +
      '<span class="c-title">' + (it.starred ? '<span class="star">★</span>' : '') + esc(it.title) +
        (it.annoCount ? '<em>' + it.annoCount + '</em>' : '') + '</span>' +
      '<span class="c-author">' + esc(it.author || it.site || '—') + '</span>' +
      '<span class="c-date">' + fmtDate(it.date || it.createdAt) + '</span>';
    row.addEventListener('click', () => selectItem(it.id));
    row.addEventListener('dblclick', () => openReader(it.id));
    box.appendChild(row);
  }
}

function updateCounts() {
  const c = {
    all: S.items.length,
    unread: S.items.filter((x) => !x.read).length,
    star: S.items.filter((x) => x.starred).length,
    marked: S.items.filter((x) => (x.annoCount || 0) > 0).length,
    wechat: S.items.filter((x) => x.kind === 'wechat').length,
    paper: S.items.filter((x) => /arxiv|doi|pdf/.test(x.kind) || x.journal).length,
    web: S.items.filter((x) => x.kind === 'web').length,
  };
  $$('#filters .tnode').forEach((b) => {
    const i = b.querySelector('i');
    if (i) i.textContent = c[b.dataset.f] != null ? c[b.dataset.f] : '';
  });
}

function renderTags() {
  const box = $('#tagList');
  const all = {};
  for (const it of S.items) for (const t of it.tags || []) all[t] = (all[t] || 0) + 1;
  const keys = Object.keys(all).sort((a, b) => all[b] - all[a]).slice(0, 18);
  if (!keys.length) {
    box.innerHTML = '<span class="none">还没有标签</span>';
    return;
  }
  box.innerHTML = keys.map((k) =>
    '<button class="tg' + (S.tag === k ? ' on' : '') + '" data-t="' + esc(k) + '">' + esc(k) + ' ' + all[k] + '</button>'
  ).join('');
  box.querySelectorAll('.tg').forEach((b) => b.addEventListener('click', () => {
    S.tag = S.tag === b.dataset.t ? null : b.dataset.t;
    renderList();
    renderTags();
  }));
}

/* ══════════ 详情 ══════════ */
async function selectItem(id) {
  const meta = S.items.find((x) => x.id === id);
  if (!meta) return;
  S.sel = meta;
  $$('.row').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
  renderDetails();
  // 补批注预览
  try {
    const d = await api('/api/item/' + id);
    if (S.sel && S.sel.id === id) {
      S.sel = d.item;
      renderDetails(d.annotations || []);
    }
  } catch (e) {}
}

function renderDetails(annos) {
  const it = S.sel;
  $('#detEmpty').hidden = !!it;
  $('#detBody').hidden = !it;
  if (!it) return;

  const [label] = kindLabel(it);
  $('#detType').textContent = label + (it.pages ? ' · ' + it.pages + ' 页' : '');
  $('#detType').className = 'det-type ' + kindLabel(it)[1];
  $('#docTitle').textContent = it.title;

  const bits = [];
  if (it.author) bits.push(esc(it.author));
  if (it.journal) bits.push('<i>' + esc(it.journal) + '</i>');
  else if (it.site && it.site !== it.author) bits.push(esc(it.site));
  if (it.date) bits.push(esc(it.date));
  if (it.pages) bits.push(it.pages + ' 页');
  if (it.chars) bits.push('约 ' + it.readingTime + ' 分钟');
  $('#docMeta').innerHTML = bits.join('<span class="m-sep">·</span>') || '<span>—</span>';

  $('#btnStar').classList.toggle('on', !!it.starred);
  $('#detDesc').textContent = it.desc || (it.blocks && it.blocks.length ? '' : '（没有摘要）') || '—';
  $('#detNote').value = it.note || '';
  $('#docOrigin').style.display = it.url ? '' : 'none';
  $('#docOrigin').href = it.url || '#';
  $('#docTags').innerHTML = (it.tags || []).map((t, i) =>
    '<span class="tag">' + esc(t) + '<span class="tx" data-i="' + i + '">✕</span></span>'
  ).join('') + '<button class="tag-add">+ 标签</button>';
  $$('#docTags .tx').forEach((x) => {
    x.style.cssText = 'margin-left:4px;opacity:.45;cursor:pointer';
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tags = it.tags.slice();
      tags.splice(+x.dataset.i, 1);
      await patchItem({ tags });
    });
  });
  $('#docTags .tag-add').addEventListener('click', async () => {
    const t = prompt('标签（多个用逗号分隔）');
    if (!t) return;
    await patchItem({ tags: [...new Set((it.tags || []).concat(t.split(/[,，\s]+/).filter(Boolean)))] });
  });

  const list = annos || [];
  $('#detAnnoCount').textContent = list.length ? list.length + ' 条' : '';
  $('#detAnnos').innerHTML = list.length
    ? list.map((a) => '<div class="det-anno c-' + a.color + '" data-id="' + a.id + '">' + esc(a.text) + '</div>').join('')
    : '<div style="font-size:11.5px;color:#BDB5A3">还没有划线</div>';
}

async function patchItem(patch) {
  const id = (S.cur && S.cur.id) || (S.sel && S.sel.id);
  if (!id) return;
  const r = await api('/api/item/' + id, 'PATCH', patch);
  const i = S.items.findIndex((x) => x.id === id);
  if (i >= 0) S.items[i] = Object.assign({}, S.items[i], r.item);
  if (S.sel && S.sel.id === id) Object.assign(S.sel, r.item);
  if (S.cur && S.cur.id === id) Object.assign(S.cur, r.item);
  renderList();
  renderDetails();
  if (S.cur) $('#btnStar2') && $('#btnStar2').classList.toggle('on', !!S.cur.starred);
}

/* ══════════ 阅读器 ══════════ */
async function openReader(id) {
  if (S.cur && S.cur.id === id && !$('#readerView').hidden) return;
  $('#readerView').hidden = false;
  $('#rdTitle').textContent = '读取中…';
  $('#pdfWrap').innerHTML = '<div class="pdf-loading"><div class="spinner"></div><span>正在打开…</span></div>';
  $('#pdfWrap').hidden = false;
  $('#docScroll').hidden = true;
  $('#docBody').innerHTML = '';

  try {
    const d = await api('/api/item/' + id);
    S.cur = d.item;
    S.blocks = d.blocks || [];
    S.annos = d.annotations || [];
    history.replaceState(null, '', '#/i/' + id);

    $('#rdTitle').textContent = S.cur.title;
    $('#docNote').value = S.cur.note || '';

    const hasPdf = !!S.cur.pdf;
    const hasText = S.blocks.length > 0;
    setViewSwitch(hasPdf && hasText);

    if (hasPdf) await showPdf();
    else showText();

    renderAnnos();
    if (!S.cur.read) {
      S.cur.read = true;
      const i = S.items.findIndex((x) => x.id === id);
      if (i >= 0) S.items[i].read = true;
      api('/api/item/' + id, 'PATCH', { read: true }).catch(() => {});
      renderList();
    }
  } catch (e) {
    toast(e.message, true);
    closeReader();
  }
}

let navHasSwitch = false;
function setViewSwitch(on) {
  navHasSwitch = on;
  const b = $('#navSwitch');
  if (b) b.hidden = !on;
}

$('#navSwitch').addEventListener('click', () => {
  if (S.mode === 'pdf') { showText(); $('#navSwitch').textContent = 'PDF'; }
  else { showPdf(); $('#navSwitch').textContent = '摘要'; }
});

async function showPdf() {
  S.mode = 'pdf';
  $('#docScroll').hidden = true;
  $('#pdfWrap').hidden = false;
  $('#rdNavTitle').textContent = '页面';
  $('#segWidth').hidden = true;
  $('#segFont').hidden = true;
  updateZoomLabel();

  try {
    await PdfView.open(S.cur.pdf, $('#pdfWrap'), {
      annos: S.annos,
      thumbsEl: $('#rdNavBody'),
      page: S.cur.lastPage || 1,
    });
    PdfView.setAnnos(S.annos);
    PdfView.onPageChange = (n) => {
      updateZoomLabel();
      if (S.cur && !S.cur.pages) {
        const m = PdfView.numPages;
        if (m) {
          S.cur.pages = m;
          api('/api/item/' + S.cur.id, 'PATCH', { pages: m }).catch(() => {});
        }
      }
      if (S.cur) S.cur.lastPage = n;
    };
  } catch (e) {
    $('#pdfWrap').innerHTML = '<div class="pdf-error">PDF 打不开：' + esc(e.message) + '</div>';
  }
}

function showText() {
  S.mode = 'text';
  PdfView.close();
  $('#pdfWrap').hidden = true;
  $('#pdfWrap').innerHTML = '';
  $('#docScroll').hidden = false;
  $('#rdNavTitle').textContent = '目录';
  $('#segWidth').hidden = false;
  $('#segFont').hidden = false;
  renderArticle();
  renderToc();
  updateZoomLabel();
}

function closeReader() {
  PdfView.close();
  $('#readerView').hidden = true;
  S.cur = null; S.blocks = []; S.annos = []; S.blockEls = [];
  history.replaceState(null, '', '#/');
  renderList();
  if (S.sel) renderDetails();
}

$('#btnBack').addEventListener('click', closeReader);

/* ── 文章渲染 ── */
function imgSrc(b) {
  if (!b.src) return '';
  if (b.src.startsWith('/media/') || b.src.startsWith('data:')) return b.src;
  return '/proxy?url=' + encodeURIComponent(b.src) + '&ref=' + encodeURIComponent(S.cur ? S.cur.url : '');
}

function renderArticle() {
  const body = $('#docBody');
  body.innerHTML = '';
  S.blockEls = [];
  S.blocks.forEach((b, i) => {
    const el = makeBlockEl(b, i);
    if (el) { S.blockEls[i] = el; body.appendChild(el); }
  });
  repaintAll();
  $('#docFootLine').textContent = [S.cur.site, S.cur.chars ? S.cur.chars + ' 字' : ''].filter(Boolean).join(' · ');
}

function makeBlockEl(b, i) {
  let el;
  switch (b.type) {
    case 'img': {
      if (!b.src) return null;
      el = document.createElement('figure');
      const img = document.createElement('img');
      img.src = imgSrc(b);
      img.loading = 'lazy';
      img.alt = '';
      img.addEventListener('error', () => { el.style.display = 'none'; });
      el.appendChild(img);
      return el;
    }
    case 'h2': el = document.createElement('h2'); break;
    case 'h3': el = document.createElement('h3'); break;
    case 'li': el = document.createElement('li'); break;
    case 'quote': el = document.createElement('blockquote'); break;
    case 'pre': el = document.createElement('pre'); break;
    case 'table': {
      el = document.createElement('table');
      el.className = 'md-table';
      const tb = document.createElement('tbody');
      (b.rows || []).forEach((row, ri) => {
        const tr = document.createElement('tr');
        row.forEach((cell) => {
          const c = document.createElement(ri === 0 ? 'th' : 'td');
          c.textContent = cell;
          tr.appendChild(c);
        });
        tb.appendChild(tr);
      });
      el.appendChild(tb);
      return el;
    }
    default: el = document.createElement('p');
  }
  el.dataset.b = i;
  el.textContent = b.text || '';
  return el;
}

function paintBlock(i) {
  const el = S.blockEls[i];
  const b = S.blocks[i];
  if (!el || !b || b.type === 'img' || b.type === 'table' || !b.text) return;

  const rs = [];
  for (const a of S.annos) {
    if (a.kind === 'pdf') continue;
    for (const r of a.ranges || []) if (r.b === i) rs.push({ s: r.s, e: r.e, id: a.id, color: a.color });
  }
  rs.sort((x, y) => x.s - y.s || x.e - y.e);

  el.textContent = '';
  if (!rs.length) { el.textContent = b.text; return; }

  let pos = 0;
  for (const r of rs) {
    const s = Math.max(pos, r.s);
    const e = Math.min(b.text.length, Math.max(s, r.e));
    if (s > pos) el.appendChild(document.createTextNode(b.text.slice(pos, s)));
    if (e > s) {
      const mk = document.createElement('mark');
      mk.className = 'hc-' + r.color;
      mk.dataset.a = r.id;
      mk.textContent = b.text.slice(s, e);
      el.appendChild(mk);
    }
    pos = Math.max(pos, e);
  }
  if (pos < b.text.length) el.appendChild(document.createTextNode(b.text.slice(pos)));
}

function repaintAll() {
  if (S.mode === 'pdf') { PdfView.setAnnos(S.annos); return; }
  for (let i = 0; i < S.blocks.length; i++) paintBlock(i);
}

/* ── 目录 ── */
function renderToc() {
  const box = $('#rdNavBody');
  box.innerHTML = '';
  const heads = [];
  S.blocks.forEach((b, i) => { if (b.type === 'h2' || b.type === 'h3') heads.push({ i, b }); });
  if (!heads.length) {
    box.innerHTML = '<div style="padding:22px 8px;text-align:center;font-size:11.5px;color:#B7B0A0">没有小标题</div>';
    return;
  }
  for (const h of heads) {
    const d = document.createElement('div');
    d.className = 'toc-item' + (h.b.type === 'h3' ? ' lv3' : '');
    d.textContent = h.b.text.slice(0, 42);
    d.addEventListener('click', () => {
      const el = S.blockEls[h.i];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $$('.toc-item').forEach((x) => x.classList.remove('on'));
      d.classList.add('on');
    });
    box.appendChild(d);
  }
}

/* ══════════ 选区 → 批注 ══════════ */
let pendingSel = null;

function textSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const body = $('#docBody');
  if (!body || !body.contains(range.commonAncestorContainer)) return null;
  const sEl = blockNodeOf(range.startContainer);
  const eEl = blockNodeOf(range.endContainer);
  if (!sEl || !eEl) return null;
  let sb = +sEl.dataset.b, eb = +eEl.dataset.b;
  if (sb > eb) { [sb, eb] = [eb, sb]; }
  const text = sel.toString().trim();
  if (text.length < 2) return null;

  const s = offsetOf(sEl, range.startContainer, range.startOffset);
  const e = offsetOf(eEl, range.endContainer, range.endOffset);
  const ranges = [];
  if (sb === eb) {
    const a = Math.min(s, e), b = Math.max(s, e);
    if (b - a >= 2) ranges.push({ b: sb, s: a, e: b });
  } else {
    const firstLen = (S.blocks[sb] && S.blocks[sb].text || '').length;
    if (firstLen - s >= 1) ranges.push({ b: sb, s, e: firstLen });
    for (let i = sb + 1; i < eb; i++) {
      const len = (S.blocks[i] && S.blocks[i].text || '').length;
      if (len > 0) ranges.push({ b: i, s: 0, e: len });
    }
    if (e > 0) ranges.push({ b: eb, s: 0, e });
  }
  if (!ranges.length) return null;
  return { kind: 'text', ranges, text: text.replace(/\s+/g, ' ') };
}

function offsetOf(root, container, offset) {
  const r = document.createRange();
  try { r.selectNodeContents(root); r.setEnd(container, offset); return r.toString().length; }
  catch (e) { return 0; }
}

function blockNodeOf(node) {
  let n = node.nodeType === 3 ? node.parentNode : node;
  while (n && n !== document.body) {
    if (n.dataset && n.dataset.b != null) return n;
    n = n.parentNode;
  }
  return null;
}

function computeSelection() {
  if (S.mode === 'pdf') {
    const g = PdfView.getSelection();
    if (!g) return null;
    return { kind: 'pdf', pages: g.pages, text: g.text };
  }
  return textSelection();
}

function showSelbar() {
  const sel = window.getSelection();
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const bar = $('#selbar');
  bar.hidden = false;
  const w = bar.offsetWidth || 180;
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
  let top = rect.top - bar.offsetHeight - 12;
  if (top < 8) top = rect.bottom + 14;
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
  bar.style.position = 'fixed';
}

function hideSelbar() {
  $('#selbar').hidden = true;
  pendingSel = null;
}

document.addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSelbar(); return; }
    if ($('#readerView').hidden) { hideSelbar(); return; }
    const got = computeSelection();
    if (!got) { hideSelbar(); return; }
    pendingSel = got;
    showSelbar();
  }, 12);
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#selbar')) {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) hideSelbar();
    }, 80);
  }
});

$('#selbar').addEventListener('mousedown', (e) => e.preventDefault());

$$('#selbar .dot').forEach((d) => d.addEventListener('click', () => createAnno(d.dataset.color)));

$('#selCopy').addEventListener('click', async () => {
  if (!pendingSel) return;
  try {
    if (window.shiyue && window.shiyue.clipboard) await window.shiyue.clipboard.write(pendingSel.text);
    else await navigator.clipboard.writeText(pendingSel.text);
    toast('已复制');
  } catch (e) { toast('复制失败', true); }
  hideSelbar();
});

async function createAnno(color) {
  if (!pendingSel || !S.cur) return;
  const payload = {
    kind: pendingSel.kind,
    text: pendingSel.text,
    color,
    ranges: pendingSel.ranges || [],
    pages: pendingSel.pages || [],
  };
  try {
    const r = await api('/api/item/' + S.cur.id + '/annotations', 'POST', payload);
    S.annos.push(r.anno);
    if (S.mode === 'pdf') {
      PdfView.setAnnos(S.annos);
    } else {
      (pendingSel.ranges || []).forEach((rg) => paintBlock(rg.b));
    }
    renderAnnos();
    updateAnnoBadge();
    hideSelbar();
    window.getSelection().removeAllRanges();
    setTimeout(() => focusAnno(r.anno.id, true), 90);
    const i = S.items.findIndex((x) => x.id === S.cur.id);
    if (i >= 0) { S.items[i].annoCount = S.annos.length; renderList(); }
  } catch (e) {
    toast(e.message, true);
  }
}

/* ══════════ 批注面板 ══════════ */
function updateAnnoBadge() {
  $('#annoCount').textContent = S.annos.length;
}

function renderAnnos() {
  const box = $('#annoList');
  const empty = $('#annoEmpty');
  updateAnnoBadge();
  box.innerHTML = '';

  if (!S.annos.length) {
    empty.hidden = false;
    empty.innerHTML = S.mode === 'pdf'
      ? '在 PDF 上用鼠标选一段文字，就能划线。<br><span>四种颜色对应不同用途。</span>'
      : '选中正文里的文字，就能划线、写批注。<br><span>四种颜色对应不同用途。</span>';
    return;
  }
  empty.hidden = true;

  const sorted = S.annos.slice().sort((a, b) => {
    if (a.kind === 'pdf' && b.kind === 'pdf') return (a.pages[0] ? a.pages[0].p : 0) - (b.pages[0] ? b.pages[0].p : 0);
    const ra = (a.ranges && a.ranges[0]) || { b: 0 };
    const rb = (b.ranges && b.ranges[0]) || { b: 0 };
    return ra.b - rb.b || ra.s - rb.s;
  });

  for (const a of sorted) {
    const el = document.createElement('div');
    el.className = 'anno c-' + a.color;
    el.dataset.id = a.id;
    const pg = a.kind === 'pdf' && a.pages && a.pages.length
      ? '<div class="anno-page">第 ' + a.pages.map((x) => x.p).join('、') + ' 页</div>' : '';
    el.innerHTML =
      '<div class="anno-quote">' + esc(a.text) + '</div>' + pg +
      '<textarea class="anno-note" placeholder="写点想法…" rows="1"></textarea>' +
      '<div class="anno-foot">' +
        '<span class="anno-time">' + fmtDate(a.createdAt) + '</span>' +
        '<div class="anno-tools">' +
          '<button data-act="goto" title="跳到原文"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 17 17 7M9 7h8v8"/></svg></button>' +
          '<button data-act="del" class="del" title="删除"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg></button>' +
        '</div>' +
      '</div>';

    const note = el.querySelector('.anno-note');
    note.value = a.note || '';
    autoGrow(note);
    let timer = null;
    note.addEventListener('input', () => {
      autoGrow(note);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await api('/api/item/' + S.cur.id + '/annotations/' + a.id, 'PATCH', { note: note.value });
        a.note = note.value;
      }, 600);
    });
    note.addEventListener('click', (e) => e.stopPropagation());

    el.querySelector('.anno-quote').addEventListener('click', () => gotoAnno(a.id));
    el.querySelector('[data-act="goto"]').addEventListener('click', () => gotoAnno(a.id));
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm('删除这条批注？')) return;
      await api('/api/item/' + S.cur.id + '/annotations/' + a.id, 'DELETE');
      S.annos = S.annos.filter((x) => x.id !== a.id);
      repaintAll();
      renderAnnos();
      const i = S.items.findIndex((x) => x.id === S.cur.id);
      if (i >= 0) { S.items[i].annoCount = S.annos.length; renderList(); }
    });

    box.appendChild(el);
  }
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = Math.max(18, t.scrollHeight) + 'px';
}

function gotoAnno(id) {
  const a = S.annos.find((x) => x.id === id);
  if (!a) return;
  if (a.kind === 'pdf') {
    const pg = a.pages && a.pages[0];
    if (pg) PdfView.goToPage(pg.p);
    focusAnno(id);
    return;
  }
  const r = a.ranges && a.ranges[0];
  if (!r) return;
  const el = S.blockEls[r.b];
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  focusAnno(id);
  el.querySelectorAll('mark[data-a="' + id + '"]').forEach((m) => {
    m.classList.remove('flash');
    void m.offsetWidth;
    m.classList.add('flash');
  });
}

function focusAnno(id, focusNote) {
  $$('.anno').forEach((x) => x.classList.toggle('focus', x.dataset.id === id));
  const el = $('.anno[data-id="' + id + '"]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (focusNote) setTimeout(() => el.querySelector('.anno-note').focus(), 220);
  }
  if (!S.sideOpen) toggleSide(true);
}

$('#docBody').addEventListener('click', (e) => {
  const mk = e.target.closest('mark[data-a]');
  if (!mk) return;
  $$('.rd-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'annos'));
  $$('.rd-pane').forEach((p) => p.classList.remove('active'));
  $('#paneAnnos').classList.add('active');
  focusAnno(mk.dataset.a);
});

/* ══════════ 侧栏 / 标签页 ══════════ */
$$('.rd-tab').forEach((t) => t.addEventListener('click', () => {
  $$('.rd-tab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.rd-pane').forEach((p) => p.classList.remove('active'));
  $('#pane' + t.dataset.tab.charAt(0).toUpperCase() + t.dataset.tab.slice(1)).classList.add('active');
}));

function toggleSide(open) {
  S.sideOpen = open === undefined ? !S.sideOpen : open;
  $('#rdSide').classList.toggle('off', !S.sideOpen);
  $('#btnSide').classList.toggle('on', S.sideOpen);
}
$('#btnSide').addEventListener('click', () => toggleSide());

/* ══════════ 笔记（两处同步） ══════════ */
let noteTimer = null;
function bindNote(el) {
  el.addEventListener('input', () => {
    if (!S.cur) return;
    const v = el.value;
    const other = el.id === 'docNote' ? $('#detNote') : $('#docNote');
    if (other && other.value !== v) other.value = v;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      await api('/api/item/' + S.cur.id, 'PATCH', { note: v });
      S.cur.note = v;
      const i = S.items.findIndex((x) => x.id === S.cur.id);
      if (i >= 0) S.items[i].note = v;
      if (S.sel && S.sel.id === S.cur.id) S.sel.note = v;
    }, 700);
  });
}
bindNote($('#docNote'));
bindNote($('#detNote'));

/* ══════════ 工具 ══════════ */
$('#fontPlus').addEventListener('click', () => {
  if (S.mode === 'pdf') { PdfView.setZoom(0.15); setTimeout(updateZoomLabel, 60); return; }
  S.prefs.fs = Math.min(24, S.prefs.fs + 1); savePrefs();
});
$('#fontMinus').addEventListener('click', () => {
  if (S.mode === 'pdf') { PdfView.setZoom(-0.15); setTimeout(updateZoomLabel, 60); return; }
  S.prefs.fs = Math.max(13, S.prefs.fs - 1); savePrefs();
});
$$('.seg button[data-font]').forEach((b) => b.addEventListener('click', () => { S.prefs.font = b.dataset.font; savePrefs(); }));
$$('.seg button[data-width]').forEach((b) => b.addEventListener('click', () => { S.prefs.width = +b.dataset.width; savePrefs(); }));

const THEMES = ['paper', 'white', 'warm'];
$('#btnTheme').addEventListener('click', () => {
  S.prefs.theme = THEMES[(THEMES.indexOf(S.prefs.theme) + 1) % THEMES.length];
  savePrefs();
  toast({ paper: '纸色', white: '纯白', warm: '米黄' }[S.prefs.theme]);
});

$('#btnFit').addEventListener('click', () => {
  if (S.mode === 'pdf') { PdfView.fitWidth(); setTimeout(updateZoomLabel, 80); }
  else toast('已适合版心宽度');
});

$('#btnStar').addEventListener('click', () => { if (S.sel) patchItem({ starred: !S.sel.starred }); });
$('#btnExport').addEventListener('click', () => {
  const id = (S.cur && S.cur.id) || (S.sel && S.sel.id);
  if (id) window.open('/api/item/' + id + '/export', '_blank');
});
$('#btnDelete').addEventListener('click', async () => {
  const it = S.cur || S.sel;
  if (!it) return;
  if (!confirm('删除《' + it.title + '》？批注和文件会一起删掉。')) return;
  await api('/api/item/' + it.id, 'DELETE');
  S.items = S.items.filter((x) => x.id !== it.id);
  if (S.cur && S.cur.id === it.id) closeReader();
  S.sel = null;
  $('#detBody').hidden = true;
  $('#detEmpty').hidden = false;
  renderList();
  toast('已删除');
});
$('#btnOpen').addEventListener('click', () => { if (S.sel) openReader(S.sel.id); });

/* 排序 */
$('#thTitle').addEventListener('click', () => {
  S.sort = { by: 'title', desc: !S.sort.desc };
  renderList();
});
$('#thDate').addEventListener('click', () => {
  S.sort = { by: 'createdAt', desc: !S.sort.desc };
  renderList();
});

/* ══════════ 筛选 / 搜索 ══════════ */
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('.tnode');
  if (!b) return;
  $$('.tnode').forEach((x) => x.classList.toggle('active', x === b));
  S.filter = b.dataset.f;
  renderList();
});

let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  $('#searchClear').hidden = !v;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.query = v; renderList(); }, 140);
});
$('#searchClear').addEventListener('click', () => {
  $('#search').value = '';
  $('#searchClear').hidden = true;
  S.query = '';
  renderList();
});

/* ══════════ 导入：链接 ══════════ */
function openModal() {
  $('#modalMask').hidden = false;
  $('#modalErr').hidden = true;
  setTimeout(async () => {
    const ta = $('#urlInput');
    ta.focus();
    // 剪贴板里正好是一条链接 → 直接填进去。
    // macOS 上 Cmd+V 依赖应用菜单的 paste role，键位偶尔会哑，
    // 所以不让用户去赌那个快捷键。
    if (!ta.value.trim()) {
      const txt = await readClip().catch(() => '');
      const one = txt.trim();
      if (/^https?:\/\/\S+$/i.test(one) && one.length < 2048) {
        ta.value = one;
        ta.select();
      }
    }
  }, 60);
}
function closeModal() { $('#modalMask').hidden = true; $('#urlInput').value = ''; }

/** 读系统剪贴板：桌面端走 preload，浏览器里退回 navigator.clipboard */
async function readClip() {
  if (window.shiyue && window.shiyue.clipboard) return window.shiyue.clipboard.read();
  if (navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText();
  return '';
}

/** 把剪贴板内容追加到输入框，一行一个，去重 */
async function pasteFromClipboard() {
  const ta = $('#urlInput');
  let txt = '';
  try {
    txt = await readClip();
  } catch (e) { /* 没有权限就当空 */ }
  if (!txt.trim()) { toast('剪贴板里没有文字', true); return; }
  const have = new Set(ta.value.split('\n').map((s) => s.trim()).filter(Boolean));
  const add = txt.split('\n').map((s) => s.trim()).filter((s) => s && !have.has(s));
  if (!add.length) { toast('剪贴板内容已经在里面了'); return; }
  ta.value = [ta.value.trim(), ...add].filter(Boolean).join('\n');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  toast('已粘贴 ' + add.length + ' 条');
}

$('#btnImport').addEventListener('click', openModal);
$('#emptyAdd').addEventListener('click', openModal);
$('#modalCancel').addEventListener('click', closeModal);
$('#modalMask').addEventListener('click', (e) => { if (e.target.id === 'modalMask') closeModal(); });
$('#modalOk').addEventListener('click', doImport);
$('#modalPaste').addEventListener('click', pasteFromClipboard);
$('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doImport(); });

async function doImport() {
  const raw = $('#urlInput').value.trim();
  if (!raw) return;
  const btn = $('#modalOk');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  closeModal();
  toast('正在抓取，公众号通常需要几秒…');

  try {
    const r = await api('/api/import', 'POST', { url: raw });
    await loadList();
    if (r.items && r.items.length) {
      selectItem(r.items[0].id);
      openReader(r.items[0].id);
      toast('已存入文库');
    }
    if (r.failed && r.failed.length) toast(r.failed[0].error || '有链接抓取失败', true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始抓取';
  }
}

/* ══════════ 导入：本地 PDF ══════════ */
$('#btnUpload').addEventListener('click', () => $('#fileInput').click());
$('#emptyUpload').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length) uploadFiles(e.target.files);
  e.target.value = '';
});

async function uploadFiles(files) {
  const pdfs = Array.from(files).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) return toast('只支持 PDF 文件', true);
  toast('正在导入 ' + pdfs.length + ' 个文件…');
  const ids = [];
  for (const f of pdfs) {
    try {
      const res = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
      const j = await res.json();
      if (!res.ok) { toast((j && j.error) || ('导入失败：' + f.name), true); continue; }
      ids.push(j.item.id);
    } catch (e) {
      toast('导入失败：' + f.name, true);
    }
  }
  await loadList();
  if (ids.length) {
    selectItem(ids[0]);
    toast('已导入 ' + ids.length + ' 份 PDF');
  }
}

/* 拖拽 */
let dragDepth = 0;
function hasFiles(e) {
  const dt = e.dataTransfer;
  return dt && Array.from(dt.types || []).includes('Files');
}
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#dropVeil').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#dropVeil').hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropVeil').hidden = true;
  if (e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

/* ══════════ 滚动进度（文章） ══════════ */
let progTimer = null;
$('#docScroll').addEventListener('scroll', () => {
  const r = $('#docScroll');
  const max = r.scrollHeight - r.clientHeight;
  const p = max > 8 ? Math.min(1, r.scrollTop / max) : 0;
  document.documentElement.style.setProperty('--prog', p.toFixed(3));
  if (!S.cur || max < 200) return;
  clearTimeout(progTimer);
  progTimer = setTimeout(() => {
    // 1.2 秒里用户可能已经关掉条目，S.cur 会是 null
    if (!S.cur) return;
    const pct = Math.round(p * 100);
    if (Math.abs(pct - (S.cur.progress || 0)) >= 8) {
      S.cur.progress = pct;
      api('/api/item/' + S.cur.id, 'PATCH', { progress: pct }).catch(() => {});
    }
  }, 1200);
});

/* ══════════ 快捷键 ══════════ */
document.addEventListener('keydown', (e) => {
  const inField = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#search').focus(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openModal(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
  if (e.key === 'Escape') {
    if (!$('#modalMask').hidden) return closeModal();
    if (!$('#dataMask').hidden) return ($('#dataMask').hidden = true);
    if (!$('#readerView').hidden && !inField) { hideSelbar(); return; }
    if (!inField) hideSelbar();
  }
  if (e.key === 'Enter' && !inField) {
    if (!$('#selbar').hidden && pendingSel) { createAnno('yellow'); return; }
    if (!$('#readerView').hidden) return;
    if (S.sel) openReader(S.sel.id);
  }
  if (!$('#readerView').hidden && S.mode === 'pdf') {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); PdfView.goToPage(Math.min(PdfView.numPages, PdfView.currentPage + 1)); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); PdfView.goToPage(Math.max(1, PdfView.currentPage - 1)); }
  }
});

document.addEventListener('paste', (e) => {
  const inField = /INPUT|TEXTAREA/.test(e.target.tagName);
  if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
    const pdfs = Array.from(e.clipboardData.files).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (pdfs.length) { e.preventDefault(); uploadFiles(pdfs); return; }
  }
  const text = (e.clipboardData || window.clipboardData).getData('text') || '';
  if (!/https?:\/\//i.test(text) || inField) return;
  e.preventDefault();
  openModal();
  $('#urlInput').value = text.trim();
});

/* ══════════ 数据 ══════════ */
$('#btnData').addEventListener('click', async () => {
  $('#dataMask').hidden = false;
  $('#dataPath').textContent = '读取中…';
  try {
    const st = await api('/api/stats');
    $('#dataPath').textContent = st.dir || 'data/';
  } catch (e) { $('#dataPath').textContent = 'data/'; }
});
$('#dataOpen').addEventListener('click', async () => {
  try { await api('/api/reveal', 'POST'); } catch (e) { toast('打不开，路径见上方', true); }
});
$('#dataOk').addEventListener('click', () => ($('#dataMask').hidden = true));
$('#dataMask').addEventListener('click', (e) => { if (e.target.id === 'dataMask') $('#dataMask').hidden = true; });

$('#btnBib').addEventListener('click', () => {
  if (!S.items.length) return toast('文库还是空的', true);
  window.open('/api/export/bibtex', '_blank');
  toast('已导出 BibTeX，可直接拖进 Zotero');
});

/* ══════════ 启动 ══════════ */
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#\/i\/([\w-]+)/);
  if (m) {
    if (!S.cur || S.cur.id !== m[1]) openReader(m[1]);
  } else if (!$('#readerView').hidden) {
    closeReader();
  }
});

(async function boot() {
  // 快捷键提示按平台改写
  if (IS_MAC) {
    const hint = $('#footHint');
    if (hint) hint.textContent = '双击条目打开阅读器 · ⌘V 粘贴链接 · 拖入 PDF 直接导入';
    const bi = $('#btnImport');
    if (bi) bi.title = '粘贴链接 / 上传 PDF（⌘N）';
  }

  loadPrefs();
  await loadList();

  const m = location.hash.match(/^#\/i\/([\w-]+)/);
  const last = localStorage.getItem('shiyue.last');
  const id = (m && S.items.some((x) => x.id === m[1])) ? m[1]
    : (last && S.items.some((x) => x.id === last)) ? last : null;
  if (id) {
    selectItem(id);
    if (m) openReader(id);
  }
})();
