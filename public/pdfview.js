'use strict';
/**
 * pdfview.js — PDF 阅读器（基于本地 pdf.js 4.x）
 *
 * 能力：
 *   · 逐页 canvas 渲染 + 透明文本层（可选中、可复制）
 *   · 选区 → 归一化矩形（0~1），存进批注，缩放自适应
 *   · 侧栏缩略图，懒渲染
 *   · 跨页选择、滚动页码同步
 */
(function () {
  const VENDOR = '/vendor/pdfjs/';
  const S = {
    lib: null,
    doc: null,
    pages: [],          // {num, w, h, el, cv, tl, hl, rendered, rendering, scaleUsed}
    scale: 1,
    baseW: 612,
    annos: [],
    wrap: null,         // 滚动容器
    stack: null,        // 页面堆栈
    thumbs: null,
    curPage: 1,
    queue: [],
    busy: false,
    token: 0,
    onPageChange: null,
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  async function ensureLib() {
    if (S.lib) return S.lib;
    const lib = await import(VENDOR + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';
    S.lib = lib;
    return lib;
  }

  /* ---------------- 打开 ---------------- */

  async function open(url, wrapEl, opts) {
    opts = opts || {};
    close();
    const myToken = ++S.token;
    const lib = await ensureLib();
    S.wrap = wrapEl;
    S.wrap.innerHTML = '<div class="pdf-loading"><div class="spinner"></div><span>正在解析 PDF…</span></div>';

    // Android 版没有 HTTP 服务，直接递字节（Uint8Array），省掉 blob URL 的来回
    const source = (url && url.constructor === Uint8Array)
      ? { data: url }
      : { url };

    const doc = await lib.getDocument(Object.assign(source, {
      cMapUrl: VENDOR + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: VENDOR + 'standard_fonts/',
      enableXfa: true,
    })).promise;

    if (myToken !== S.token) return null;
    S.doc = doc;

    // 先取第一页定基准宽度
    const p1 = await doc.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    S.baseW = vp1.width;

    // 批量取所有页尺寸（限并发，避免 100 页卡死）
    const sizes = new Array(doc.numPages);
    sizes[0] = { w: vp1.width, h: vp1.height };
    let cursor = 2;
    async function worker() {
      while (cursor <= doc.numPages) {
        const n = cursor++;
        try {
          const pg = await doc.getPage(n);
          const v = pg.getViewport({ scale: 1 });
          sizes[n - 1] = { w: v.width, h: v.height };
        } catch (e) {
          sizes[n - 1] = { w: vp1.width, h: vp1.height };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, doc.numPages) }, worker));
    if (myToken !== S.token) return null;

    S.pages = sizes.map((sz, i) => ({
      num: i + 1,
      w: sz.w || vp1.width,
      h: sz.h || vp1.height,
      el: null, cv: null, tl: null, hl: null,
      rendered: false, rendering: false, scaleUsed: 0, thumbDone: false,
    }));

    buildDom();
    buildThumbs(opts.thumbsEl);
    fitWidth();
    if (opts.annos) setAnnos(opts.annos);
    if (opts.page) setTimeout(() => goToPage(opts.page), 120);

    return { numPages: doc.numPages, width: vp1.width, height: vp1.height };
  }

  /* ---------------- 缩略图 ---------------- */

  function buildThumbs(host) {
    S.thumbs = host || null;
    S.thumbEls = [];
    if (S.thumbIO) { try { S.thumbIO.disconnect(); } catch (e) {} S.thumbIO = null; }
    if (!host) return;
    host.innerHTML = '';
    for (const p of S.pages) {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.dataset.p = p.num;
      d.innerHTML = '<div class="ph"></div><span class="tn">' + p.num + '</span>';
      d.addEventListener('click', () => goToPage(p.num));
      host.appendChild(d);
      S.thumbEls.push(d);
    }
    S.thumbIO = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) renderThumb(+e.target.dataset.p);
    }, { root: host, rootMargin: '500px 0px' });
    S.thumbEls.forEach((el) => S.thumbIO.observe(el));
  }

  async function renderThumb(num) {
    const p = S.pages[num - 1];
    if (!p || p.thumbDone || !S.doc) return;
    p.thumbDone = true;
    try {
      const page = await S.doc.getPage(num);
      const vp0 = page.getViewport({ scale: 1 });
      const s = 156 / vp0.width;
      const v = page.getViewport({ scale: s });
      const cv = document.createElement('canvas');
      cv.width = Math.floor(v.width);
      cv.height = Math.floor(v.height);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: v }).promise;
      const el = S.thumbEls[num - 1];
      const ph = el && el.querySelector('.ph');
      if (ph) ph.replaceWith(cv);
    } catch (e) {
      p.thumbDone = false;
    }
  }

  function markThumbActive(num) {
    if (!S.thumbEls) return;
    const el = S.thumbEls[num - 1];
    if (!el) return;
    if (S.lastThumb === el) return;
    if (S.lastThumb) S.lastThumb.classList.remove('on');
    el.classList.add('on');
    S.lastThumb = el;
    const r = el.getBoundingClientRect();
    const hr = S.thumbs.getBoundingClientRect();
    if (r.top < hr.top || r.bottom > hr.bottom) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function buildDom() {
    const stack = document.createElement('div');
    stack.className = 'pdf-stack';
    S.stack = stack;

    for (const p of S.pages) {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = p.num;
      el.innerHTML =
        '<canvas></canvas>' +
        '<div class="pdf-hl"></div>' +
        '<div class="textLayer"></div>' +
        '<div class="pdf-pageno">' + p.num + '</div>';
      p.el = el;
      p.cv = el.querySelector('canvas');
      p.hl = el.querySelector('.pdf-hl');
      p.tl = el.querySelector('.textLayer');
      stack.appendChild(el);
    }

    S.wrap.innerHTML = '';
    S.wrap.appendChild(stack);

    S.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const idx = +e.target.dataset.page - 1;
        enqueue(idx);
        enqueue(idx + 1);
        enqueue(idx - 1);
      }
    }, { root: S.wrap, rootMargin: '900px 0px' });

    S.pages.forEach((p) => S.io.observe(p.el));

    S.wrap.addEventListener('scroll', onScrollPassive, { passive: true });
  }

  /* ---------------- 渲染 ---------------- */

  function enqueue(idx) {
    if (idx < 0 || idx >= S.pages.length) return;
    const p = S.pages[idx];
    if (p.rendered && Math.abs(p.scaleUsed - S.scale) < 0.001) return;
    if (S.queue.indexOf(idx) === -1) S.queue.push(idx);
    pump();
  }

  async function pump() {
    if (S.busy || !S.queue.length) return;
    S.busy = true;
    const idx = S.queue.shift();
    try { await renderPage(idx); } catch (e) { /* 单页失败不影响整篇 */ }
    S.busy = false;
    if (S.queue.length) pump();
  }

  async function renderPage(idx) {
    const p = S.pages[idx];
    if (!p || !S.doc) return;
    const scale = S.scale;
    if (p.rendered && Math.abs(p.scaleUsed - scale) < 0.001) return;

    p.rendering = true;
    const page = await S.doc.getPage(p.num);
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const cv = p.cv;
    cv.width = Math.floor(vp.width * dpr);
    cv.height = Math.floor(vp.height * dpr);
    cv.style.width = vp.width + 'px';
    cv.style.height = vp.height + 'px';
    const ctx = cv.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);

    await page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;

    p.el.style.width = vp.width + 'px';
    p.el.style.height = vp.height + 'px';
    p.el.style.setProperty('--scale-factor', scale);

    // 文本层
    const tl = p.tl;
    tl.innerHTML = '';
    tl.style.width = vp.width + 'px';
    tl.style.height = vp.height + 'px';
    try {
      const textLayer = new S.lib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: tl,
        viewport: vp,
      });
      await textLayer.render();
    } catch (e) {
      // 极少数 PDF 文本层失败，不影响看图
    }

    p.rendered = true;
    p.rendering = false;
    p.scaleUsed = scale;
    paintPage(idx);
  }

  /* ---------------- 缩放 ---------------- */

  function fitWidth() {
    if (!S.wrap || !S.pages.length) return;
    const avail = S.wrap.clientWidth - 56;
    const s = clamp(avail / S.baseW, 0.2, 4);
    applyScale(s);
  }

  function setZoom(delta) {
    applyScale(clamp(S.scale + delta, 0.25, 5));
  }

  function setZoomTo(s) {
    applyScale(clamp(s, 0.25, 5));
  }

  function applyScale(s) {
    const changed = Math.abs(s - S.scale) > 0.0005;
    S.scale = s;
    for (const p of S.pages) {
      p.el.style.width = Math.floor(p.w * s) + 'px';
      p.el.style.height = Math.floor(p.h * s) + 'px';
      p.el.style.setProperty('--scale-factor', s);
      // 尺寸变了先清空，等重新渲染
      if (changed && p.rendered) {
        p.rendered = false;
        p.cv.width = 0; p.cv.height = 0;
        p.tl.innerHTML = '';
        p.hl.innerHTML = '';
      }
    }
    S.queue = [];
    const keep = S.curPage;
    // 重新触发可视区域渲染
    requestAnimationFrame(() => {
      for (let i = 0; i < S.pages.length; i++) {
        const r = S.pages[i].el.getBoundingClientRect();
        if (r.bottom > -1200 && r.top < window.innerHeight + 1200) enqueue(i);
      }
      if (keep) goToPage(keep, true);
    });
  }

  /* ---------------- 高亮 ---------------- */

  function setAnnos(list) {
    S.annos = (list || []).filter((a) => a.kind === 'pdf' && a.pages && a.pages.length);
    paintAll();
  }

  function paintAll() {
    for (let i = 0; i < S.pages.length; i++) paintPage(i);
  }

  function paintPage(idx) {
    const p = S.pages[idx];
    if (!p || !p.hl) return;
    p.hl.innerHTML = '';
    const no = p.num;
    for (const a of S.annos) {
      const pg = a.pages.find((x) => x.p === no);
      if (!pg || !pg.rects) continue;
      for (const r of pg.rects) {
        const d = document.createElement('div');
        d.className = 'pdf-hlr hc-' + (a.color || 'yellow');
        d.dataset.a = a.id;
        d.style.left = (r.x * 100).toFixed(3) + '%';
        d.style.top = (r.y * 100).toFixed(3) + '%';
        d.style.width = (r.w * 100).toFixed(3) + '%';
        d.style.height = (r.h * 100).toFixed(3) + '%';
        p.hl.appendChild(d);
      }
    }
  }

  /** 把当前选区转成 {pages:[{p,rects:[{x,y,w,h}]}], text} */
  function getSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!S.stack || !S.stack.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return null;

    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) return null;

    const pageRects = S.pages.map((p) => ({ p: p.num, el: p.el, r: p.el.getBoundingClientRect() }));
    const byPage = new Map();

    for (const r of rects) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      for (const pr of pageRects) {
        if (cx < pr.r.left - 2 || cx > pr.r.right + 2) continue;
        if (cy < pr.r.top - 2 || cy > pr.r.bottom + 2) continue;
        const arr = byPage.get(pr.p) || [];
        arr.push({
          x: +((r.left - pr.r.left) / pr.r.width).toFixed(4),
          y: +((r.top - pr.r.top) / pr.r.height).toFixed(4),
          w: +(r.width / pr.r.width).toFixed(4),
          h: +(r.height / pr.r.height).toFixed(4),
        });
        byPage.set(pr.p, arr);
        break;
      }
    }
    if (!byPage.size) return null;

    // 同一行被切成多段的矩形合并（视觉更平整）
    const pages = [...byPage.entries()].map(([p, rs]) => ({ p, rects: mergeRects(rs) }));
    return { pages, text };
  }

  function mergeRects(rs) {
    const sorted = rs.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last &&
          Math.abs(last.y - r.y) < 0.004 &&
          Math.abs(last.h - r.h) < 0.004 &&
          r.x - (last.x + last.w) < 0.012) {
        const right = Math.max(last.x + last.w, r.x + r.w);
        last.w = right - last.x;
      } else {
        out.push(Object.assign({}, r));
      }
    }
    return out;
  }

  /* ---------------- 导航 ---------------- */

  function goToPage(n, instant) {
    const p = S.pages[n - 1];
    if (!p || !S.wrap) return;
    const top = p.el.offsetTop - 14;
    S.wrap.scrollTo({ top, behavior: instant ? 'auto' : 'smooth' });
    S.curPage = n;
    markThumbActive(n);
    if (S.onPageChange) S.onPageChange(n);
  }

  let scrollTimer = null;
  function onScrollPassive() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (!S.wrap) return;
      const mid = S.wrap.scrollTop + S.wrap.clientHeight * 0.35;
      let best = S.curPage;
      for (const p of S.pages) {
        if (!p.el) continue;
        if (p.el.offsetTop <= mid) best = p.num;
        else break;
      }
      if (best !== S.curPage) {
        S.curPage = best;
        markThumbActive(best);
        if (S.onPageChange) S.onPageChange(best);
      }
      // 滚动进度
      const max = S.wrap.scrollHeight - S.wrap.clientHeight;
      if (max > 10) {
        document.documentElement.style.setProperty('--prog', (S.wrap.scrollTop / max).toFixed(3));
      }
    }, 90);
  }

  function destroy() {
    if (S.io) { try { S.io.disconnect(); } catch (e) {} }
    if (S.wrap) S.wrap.removeEventListener('scroll', onScrollPassive);
    for (const p of S.pages) {
      if (p.cv) { p.cv.width = 0; p.cv.height = 0; }
    }
    S.pages = [];
    S.queue = [];
    S.annos = [];
    S.busy = false;
  }

  function close() {
    S.token++;
    destroy();
    if (S.doc) { try { S.doc.destroy(); } catch (e) {} }
    S.doc = null;
    if (S.wrap) S.wrap.innerHTML = '';
    S.wrap = null;
    S.stack = null;
  }

  window.PdfView = {
    open, close, destroy,
    fitWidth, setZoom, setZoomTo, goToPage,
    setAnnos, paintAll, getSelection,
    get numPages() { return S.pages.length; },
    get currentPage() { return S.curPage; },
    get scale() { return S.scale; },
    set onPageChange(fn) { S.onPageChange = fn; },
    get rendering() { return S.busy; },
    get state() { return S; },
  };
})();
