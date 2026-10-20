'use strict';
/**
 * boot.js — Android 版后端
 *
 * 桌面版是「Node 起一个本地 HTTP 服务，前端 fetch 它」。APK 里没有 Node，
 * 所以这里用同一套路由名、同一套返回结构，把实现换成
 * CapacitorHttp（原生请求，不受 CORS 限制）+ IndexedDB（数据全在本机）。
 *
 * 前端只在 app.js 顶部认三个钩子：
 *   window.SHIYUE_API      api(url, method, body)
 *   window.SHIYUE_UPLOAD   (File) -> {item}
 *   window.SHIYUE_EXPORT   ('markdown'|'bibtex', id)
 * 桌面/网页里本文件直接 return，什么也不做。
 */
(function () {
  const Cap = window.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const forced = /[?&]local=1/.test(location.search);   // 浏览器里调试用
  if (!isNative && !forced) return;
  if (!window.ShiyueExtract) { console.error('[拾阅] extract.js 没加载'); return; }

  const EX = window.ShiyueExtract;
  const UA = 'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

  /* ══════════ 工具 ══════════ */
  const newId = (p) => (p || 'i') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const fileOf = (u) => { try { return decodeURIComponent((new URL(u).pathname.split('/').pop() || '')); } catch (e) { return ''; } };
  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ══════════ IndexedDB ══════════ */
  const DB_NAME = 'shiyue';
  const DB_VER = 1;
  let dbp = null;

  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('doc')) d.createObjectStore('doc', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('anno')) {
          d.createObjectStore('anno', { keyPath: 'id' }).createIndex('itemId', 'itemId');
        }
        if (!d.objectStoreNames.contains('media')) d.createObjectStore('media', { keyPath: 'path' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }

  const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const store = async (name, mode) => (await openDb()).transaction(name, mode).objectStore(name);

  const dbGet = async (s, k) => wrap((await store(s, 'readonly')).get(k));
  const dbAll = async (s) => wrap((await store(s, 'readonly')).getAll());
  const dbPut = async (s, v) => wrap((await store(s, 'readwrite')).put(v));
  const dbDel = async (s, k) => wrap((await store(s, 'readwrite')).delete(k));
  const dbAnnos = async (itemId) => wrap((await store('anno', 'readonly')).index('itemId').getAll(itemId));

  /* ══════════ 媒体（PDF、配图）══════════ */
  const urlCache = new Map();

  async function putMedia(path, blob) {
    await dbPut('media', { path, blob });
    return path;
  }

  /** 本地路径 → blob URL；已经是外链/data 的原样返回 */
  async function mediaUrl(path) {
    if (!path) return '';
    if (/^(data:|blob:|https?:)/i.test(path)) return path;
    if (urlCache.has(path)) return urlCache.get(path);
    const rec = await dbGet('media', path);
    if (!rec) return '';
    const u = URL.createObjectURL(rec.blob);
    urlCache.set(path, u);
    return u;
  }

  async function readMediaBytes(path) {
    const rec = await dbGet('media', path);
    if (!rec) return null;
    return new Uint8Array(await rec.blob.arrayBuffer());
  }

  /* ══════════ 网络 ══════════ */
  const Http = Cap && Cap.Plugins && Cap.Plugins.CapacitorHttp;

  async function httpGet(url, opt) {
    opt = opt || {};
    const headers = Object.assign({ 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' }, opt.headers || {});
    if (Http) {
      const r = await Http.get({
        url,
        headers,
        responseType: opt.binary ? 'arraybuffer' : 'text',
        connectTimeout: 20000,
        readTimeout: 40000,
      });
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      const data = r.data;
      if (opt.binary) {
        const bytes = typeof data === 'string' ? b64ToBytes(data) : new Uint8Array(data);
        return { bytes };
      }
      return { text: typeof data === 'string' ? data : JSON.stringify(data) };
    }
    // 浏览器调试：会被 CORS 挡，能连通就不错了
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (opt.binary) return { bytes: new Uint8Array(await r.arrayBuffer()) };
    return { text: await r.text() };
  }

  /* ══════════ 抓取 ══════════ */
  function detectKind(url) {
    const u = String(url).toLowerCase();
    if (/mp\.weixin\.qq\.com/.test(u)) return 'wechat';
    if (/arxiv\.org\/(abs|pdf)\//.test(u)) return 'arxiv';
    if (/(^|\/\/)(dx\.)?doi\.org\//.test(u) || /^10\.\d{4,9}\/\S+$/.test(url)) return 'doi';
    if (/\.pdf($|[?#])/.test(u)) return 'pdf';
    return 'web';
  }

  async function crossref(doi) {
    const r = await httpGet('https://api.crossref.org/works/' + encodeURIComponent(doi), {
      headers: { Accept: 'application/json' },
    });
    const m = (JSON.parse(r.text).message) || {};
    const authors = (m.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
    const dp = (m.issued && m.issued['date-parts'] && m.issued['date-parts'][0]) || [];
    return {
      title: (m.title && m.title[0]) || '',
      author: authors.join(', '),
      date: dp.length ? dp.join('-') : '',
      journal: (m['container-title'] && m['container-title'][0]) || '',
      doi: m.DOI || doi,
      desc: String(m.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    };
  }

  /** 正文里的图抓到本地，换成 /media/<id>/<n>，断网也能看 */
  async function localizeImages(id, blocks, baseUrl) {
    let n = 0;
    for (const b of blocks) {
      if (b.type !== 'img' || !b.src) continue;
      let abs = b.src;
      try { abs = new URL(b.src, baseUrl).href; } catch (e) { continue; }
      if (!/^https?:/i.test(abs)) continue;
      try {
        const r = await httpGet(abs, { binary: true, headers: { Referer: baseUrl } });
        if (!r.bytes || r.bytes.length < 200) continue;
        const ext = /\.png($|\?)/i.test(abs) ? 'png' : /\.gif($|\?)/i.test(abs) ? 'gif' : /\.webp($|\?)/i.test(abs) ? 'webp' : 'jpg';
        const p = 'media/' + id + '/' + (++n) + '.' + ext;
        await putMedia(p, new Blob([r.bytes]));
        b.src = '/' + p;
      } catch (e) { /* 抓不到就留远程地址 */ }
    }
    return blocks;
  }

  function countChars(blocks) {
    return blocks.reduce((a, b) => a + (b.type === 'img' ? 0 : String(b.text || '').length), 0);
  }

  async function importUrl(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url) throw new Error('请粘贴一个链接');
    const id = newId('i');
    let kind = detectKind(url);
    let blocks = [];
    let meta = {};
    let pdfPath = '';

    if (kind === 'pdf') {
      const r = await httpGet(url, { binary: true });
      pdfPath = 'media/' + id + '/paper.pdf';
      await putMedia(pdfPath, new Blob([r.bytes], { type: 'application/pdf' }));
      meta = { title: fileOf(url).replace(/\.pdf$/i, ''), site: hostOf(url) };
    } else if (kind === 'doi') {
      const doi = (url.match(/10\.\d{4,9}\/[^\s?#]+/) || [])[0] || url;
      const cm = await crossref(doi);
      meta = { title: cm.title, author: cm.author, date: cm.date, journal: cm.journal, doi: cm.doi, desc: cm.desc };
      blocks = [
        { type: 'h2', text: '题录' },
        { type: 'li', text: 'DOI: ' + doi },
      ];
      if (cm.journal) blocks.push({ type: 'li', text: '期刊：' + cm.journal });
      if (cm.date) blocks.push({ type: 'li', text: '日期：' + cm.date });
      if (cm.desc) blocks.push({ type: 'h2', text: '摘要' }, { type: 'p', text: cm.desc });
      if (!cm.desc) blocks.push({ type: 'p', text: '这个 DOI 暂时只有题录。全文多半要机构订阅，要点可以写在右侧「笔记」里。' });
    } else {
      const r = await httpGet(url);
      const ex = EX.extract(r.text || '', url);
      blocks = ex.blocks || [];
      meta = ex.meta || {};
      if (ex.title && !meta.title) meta.title = ex.title;
      if (!blocks.length) throw new Error('没抓到正文，可能需要登录或被反爬拦住了');

      // arXiv 顺手把 PDF 也存下来
      if (kind === 'arxiv') {
        const aid = (url.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i) || [])[1];
        if (aid) {
          try {
            const pr = await httpGet('https://arxiv.org/pdf/' + aid, { binary: true });
            pdfPath = 'media/' + id + '/paper.pdf';
            await putMedia(pdfPath, new Blob([pr.bytes], { type: 'application/pdf' }));
          } catch (e) { /* 没有就没有 */ }
        }
      }
    }

    await localizeImages(id, blocks, url);

    // 正文开头重复标题就去掉
    const t = String(meta.title || '').trim();
    if (t) {
      const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
      while (blocks.length && blocks[0].type === 'h2' && norm(blocks[0].text) === norm(t)) blocks.shift();
    }

    const chars = countChars(blocks);
    const now = new Date().toISOString();
    const item = {
      id,
      kind: pdfPath ? (kind === 'pdf' ? 'pdf' : kind + '+pdf') : kind,
      url,
      title: meta.title || '未命名',
      site: meta.site || hostOf(url),
      author: String(meta.author || '').slice(0, 120),
      date: meta.date || '',
      journal: meta.journal || '',
      doi: meta.doi || '',
      desc: meta.desc || '',
      cover: (blocks.find((b) => b.type === 'img' && b.src) || {}).src || '',
      tags: [],
      starred: false,
      read: false,
      progress: 0,
      note: '',
      pdf: pdfPath,
      chars,
      readingTime: Math.max(1, Math.round(chars / (meta.journal ? 500 : 400))),
      createdAt: now,
      updatedAt: now,
      annoCount: 0,
      addedAt: Date.now(),
    };

    await dbPut('doc', { id, blocks, meta: item });
    await dbPut('meta', item);
    return item;
  }

  /* ══════════ PDF 上传 ══════════ */
  async function uploadPdf(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode.apply(null, buf.slice(0, 5)).indexOf('%PDF') !== 0) {
      throw new Error('不是有效的 PDF 文件');
    }
    const id = newId('i');
    const path = 'media/' + id + '/paper.pdf';
    await putMedia(path, new Blob([buf], { type: 'application/pdf' }));

    let title = '';
    let pages = 0;
    try {
      const lib = await import('/vendor/pdfjs/pdf.min.mjs');
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      const doc = await lib.getDocument({ data: buf }).promise;
      pages = doc.numPages;
      const m = await doc.getMetadata().catch(() => null);
      const info = (m && m.info) || {};
      if (info.Title && String(info.Title).length > 3) title = String(info.Title);
      if (!title && info.Author) title = '';
    } catch (e) { /* 拿不到元数据不影响阅读 */ }

    const base = String(file.name || 'document.pdf')
      .replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || /^(untitled|document|microsoft word|新建|无标题)/i.test(title)) title = base || '未命名';

    const now = new Date().toISOString();
    const item = {
      id,
      kind: 'pdf',
      url: '',
      title,
      site: '本地 PDF',
      author: '',
      date: '',
      journal: '',
      doi: '',
      desc: '',
      cover: '',
      tags: [],
      starred: false,
      read: false,
      progress: 0,
      note: '',
      pdf: path,
      chars: 0,
      pages,
      readingTime: Math.max(1, Math.round(pages / 2)) || 1,
      createdAt: now,
      updatedAt: now,
      annoCount: 0,
      addedAt: Date.now(),
    };
    await dbPut('doc', { id, blocks: [], meta: item });
    await dbPut('meta', item);
    return item;
  }

  /* ══════════ 列表 / 详情 ══════════ */
  async function listItems(q) {
    let list = await dbAll('meta');
    list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    if (q) {
      const kw = String(q).toLowerCase();
      list = list.filter((it) =>
        (it.title || '').toLowerCase().includes(kw) ||
        (it.site || '').toLowerCase().includes(kw) ||
        (it.author || '').toLowerCase().includes(kw) ||
        (it.desc || '').toLowerCase().includes(kw) ||
        (it.note || '').toLowerCase().includes(kw) ||
        (it.tags || []).some((t) => String(t).toLowerCase().includes(kw)));
    }
    return list.map(stripHeavy);
  }

  /** 列表不需要正文和二进制，减掉体积 */
  function stripHeavy(it) {
    const o = Object.assign({}, it);
    delete o.addedAt;
    return o;
  }

  async function getItem(id) {
    const meta = await dbGet('meta', id);
    const doc = await dbGet('doc', id);
    if (!meta || !doc) throw new Error('不存在');

    // 配图换成 blob URL，PDF 直接给字节（pdf.js 认这个）
    const blocks = [];
    for (const b of doc.blocks || []) {
      if (b.type === 'img' && b.src && b.src.startsWith('/media/')) {
        const u = await mediaUrl(b.src.slice(1));
        blocks.push(Object.assign({}, b, { src: u || b.src, stored: b.src }));
      } else blocks.push(b);
    }

    const item = Object.assign({}, meta);
    let pdfBytes = null;
    if (item.pdf) {
      const p = item.pdf.replace(/^\//, '');
      pdfBytes = await readMediaBytes(p);
      // 有字节就递字节；万一丢了再退回本地路径
      item.pdf = pdfBytes || ('/' + p);
    }

    return { item: stripHeavy(item), blocks, annotations: await dbAnnos(id) };
  }

  async function patchItem(id, patch) {
    const meta = await dbGet('meta', id);
    if (!meta) throw new Error('不存在');
    const allow = ['title', 'tags', 'starred', 'read', 'progress', 'note', 'author', 'site', 'journal', 'date'];
    for (const k of allow) if (k in patch) meta[k] = patch[k];
    meta.updatedAt = new Date().toISOString();
    await dbPut('meta', meta);
    const doc = await dbGet('doc', id);
    if (doc) { doc.meta = meta; await dbPut('doc', doc); }
    return stripHeavy(meta);
  }

  async function removeItem(id) {
    const doc = await dbGet('doc', id);
    await dbDel('meta', id);
    await dbDel('doc', id);
    const annos = await dbAnnos(id);
    for (const a of annos) await dbDel('anno', a.id);
    // 清掉这篇的媒体
    const all = await dbAll('media');
    for (const m of all) if (m.path.indexOf('media/' + id + '/') === 0) await dbDel('media', m.path);
    if (doc) { /* 索引里没有反向引用，无需处理 */ }
  }

  /* ══════════ 导出 ══════════ */
  function mdOf(item, blocks, annos) {
    const L = [];
    L.push('# ' + (item.title || '未命名'), '');
    const info = [];
    if (item.author) info.push('作者：' + item.author);
    if (item.site) info.push('来源：' + item.site);
    if (item.date) info.push('日期：' + item.date);
    if (item.journal) info.push('期刊：' + item.journal);
    if (item.doi) info.push('DOI：' + item.doi);
    if (item.url) info.push('链接：' + item.url);
    if (info.length) L.push('> ' + info.join('  \n> '), '');
    if (item.note) L.push('## 笔记', '', item.note, '');
    if (annos.length) {
      L.push('## 批注', '');
      annos.forEach((a, i) => {
        L.push('**' + (i + 1) + '.** ' + (a.text || '').replace(/\n+/g, ' '));
        if (a.note) L.push('', '> ' + a.note);
        L.push('');
      });
    }
    if (blocks.length) {
      L.push('## 正文', '');
      for (const b of blocks) {
        if (b.type === 'img') L.push('![](' + (b.src || '') + ')', '');
        else if (b.type === 'h2') L.push('### ' + b.text, '');
        else if (b.type === 'h3') L.push('#### ' + b.text, '');
        else if (b.type === 'li') L.push('- ' + b.text);
        else if (b.type === 'quote') L.push('> ' + b.text, '');
        else if (b.type === 'pre') L.push('```', b.text, '```', '');
        else L.push(b.text, '');
      }
    }
    return L.join('\n');
  }

  function bibOf(items) {
    const esc = (s) => String(s || '').replace(/[{}]/g, '');
    return items.map((it) => {
      const key = (String(it.author || it.site || 'shiyue').split(/[,，]/)[0] || 'shiyue')
        .replace(/\s+/g, '') + (String(it.date || '').slice(0, 4) || '');
      const type = it.journal ? 'article' : 'misc';
      const rows = [
        '@' + type + '{' + key + ',',
        '  title = {' + esc(it.title) + '},',
        it.author ? '  author = {' + esc(it.author) + '},' : '',
        it.journal ? '  journal = {' + esc(it.journal) + '},' : '',
        it.date ? '  year = {' + esc(String(it.date).slice(0, 4)) + '},' : '',
        it.doi ? '  doi = {' + esc(it.doi) + '},' : '',
        it.url ? '  url = {' + esc(it.url) + '},' : '',
        '  note = {拾阅本地文库}',
        '}',
      ].filter(Boolean);
      return rows.join('\n');
    }).join('\n\n') + '\n';
  }

  async function saveText(name, text) {
    const FS = Cap && Cap.Plugins && Cap.Plugins.Filesystem;
    const Share = Cap && Cap.Plugins && Cap.Plugins.Share;
    if (FS) {
      const r = await FS.writeFile({
        path: name,
        data: text,
        directory: 'DOCUMENTS',
        encoding: 'utf8',
        recursive: true,
      });
      if (Share) {
        try {
          await Share.share({ title: name, url: r.uri, dialogTitle: '保存或分享 ' + name });
        } catch (e) { /* 用户取消分享不算错 */ }
      }
      return r.uri;
    }
    // 浏览器兜底：直接触发下载
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return name;
  }

  async function exportAs(kind, id) {
    if (kind === 'bibtex') {
      const items = await dbAll('meta');
      return saveText('拾阅文库-' + new Date().toISOString().slice(0, 10) + '.bib', bibOf(items));
    }
    const d = await getItem(id);
    const safe = String(d.item.title || 'note').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    return saveText(safe + '.md', mdOf(d.item, d.blocks, d.annotations));
  }

  /* ══════════ 路由（与 server.js 同名同形）══════════ */
  async function api(url, method, body) {
    const m = (method || 'GET').toUpperCase();
    const [path, qs] = String(url).split('?');
    const q = new URLSearchParams(qs || '');
    let mm;

    if (path === '/api/items' && m === 'GET') return { items: await listItems(q.get('q') || '') };

    if (path === '/api/import' && m === 'POST') {
      const raw = String((body && body.url) || '').trim();
      if (!raw) throw new Error('请粘贴一个链接');
      const urls = raw.split(/\s*[\n,]\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      const done = [];
      const failed = [];
      for (const u of urls) {
        try { done.push(await importUrl(u)); }
        catch (e) { failed.push({ url: u, error: e.message || String(e) }); }
        await sleep(200);
      }
      if (!done.length && failed.length) throw new Error(failed[0].error);
      return { items: done, failed };
    }

    if ((mm = path.match(/^\/api\/item\/([\w-]+)$/))) {
      const id = mm[1];
      if (m === 'GET') return getItem(id);
      if (m === 'PATCH') return { item: await patchItem(id, body || {}) };
      if (m === 'DELETE') { await removeItem(id); return { ok: true }; }
    }

    if ((mm = path.match(/^\/api\/item\/([\w-]+)\/annotations$/)) && m === 'POST') {
      const itemId = mm[1];
      const kind = body && body.kind === 'pdf' ? 'pdf' : 'text';
      if (kind === 'pdf') { if (!body.pages || !body.pages.length) throw new Error('缺少选区'); }
      else if (!body.ranges || !body.ranges.length) throw new Error('缺少选区');
      const anno = {
        id: newId('a'),
        itemId,
        kind,
        ranges: kind === 'text' ? body.ranges : [],
        pages: kind === 'pdf' ? body.pages : [],
        text: String(body.text || ''),
        note: String(body.note || ''),
        color: body.color || 'yellow',
        tags: [],
        createdAt: new Date().toISOString(),
      };
      await dbPut('anno', anno);
      const list = await dbAnnos(itemId);
      await patchItem(itemId, { annoCount: list.length }).catch(() => {});
      const meta = await dbGet('meta', itemId);
      if (meta) { meta.annoCount = list.length; await dbPut('meta', meta); }
      return { anno, count: list.length };
    }

    if ((mm = path.match(/^\/api\/item\/([\w-]+)\/annotations\/([\w-]+)$/))) {
      const itemId = mm[1];
      const aid = mm[2];
      const anno = await dbGet('anno', aid);
      if (!anno || anno.itemId !== itemId) throw new Error('批注不存在');
      if (m === 'PATCH') {
        for (const k of ['note', 'color', 'tags']) if (body && k in body) anno[k] = body[k];
        await dbPut('anno', anno);
        return { anno };
      }
      if (m === 'DELETE') {
        await dbDel('anno', aid);
        const list = await dbAnnos(itemId);
        const meta = await dbGet('meta', itemId);
        if (meta) { meta.annoCount = list.length; await dbPut('meta', meta); }
        return { ok: true, count: list.length };
      }
    }

    if (path === '/api/stats') {
      const list = await dbAll('meta');
      return {
        total: list.length,
        annos: list.reduce((a, b) => a + (b.annoCount || 0), 0),
        tags: [...new Set(list.flatMap((x) => x.tags || []))],
        proxy: '设备直连',
        dir: '本机存储（IndexedDB）',
      };
    }

    if (path === '/api/reveal' && m === 'POST') throw new Error('手机上没有文件夹可打开');

    throw new Error('未知接口 ' + path);
  }

  /* ══════════ 交给页面 ══════════ */
  window.SHIYUE_API = api;
  window.SHIYUE_UPLOAD = async (file) => ({ item: await uploadPdf(file) });
  window.SHIYUE_EXPORT = exportAs;
  window.SHIYUE_PLATFORM = 'android';

  // 页面里「从剪贴板粘贴」和选区复制都认 window.shiyue（和桌面版 preload 同名），
  // 没有原生插件就让它落回 navigator.clipboard
  const Clip = Cap && Cap.Plugins && Cap.Plugins.Clipboard;
  if (Clip) {
    window.shiyue = {
      platform: 'android',
      clipboard: {
        read: () => Clip.read().then((r) => (r && r.value) || ''),
        write: (text) => Clip.write({ string: String(text == null ? '' : text) }),
      },
    };
  }

  // 供设置页显示
  window.SHIYUE_LOCAL = true;
  console.log('[拾阅] Android 本地后端已接管');
})();
