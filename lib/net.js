'use strict';
/**
 * net.js — 统一 HTTP 出口
 * 国内直连 GitHub / arXiv / 各类博客经常失败，这里支持：
 *   1) 读 HTTPS_PROXY / HTTP_PROXY 环境变量
 *   2) 自动探测本机常见代理端口（Clash 7897 / V2Ray 10809 …）
 *   3) 都不行则直连
 * 返回对象与 fetch 的 Response 尽量兼容：ok / status / headers.get() / text() / arrayBuffer() / json()
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CANDIDATE_PORTS = [7897, 7890, 7891, 10809, 10808, 1080, 8888, 8080, 6152];

let proxyResolved;   // undefined=未探测  'direct' | 'http://127.0.0.1:7897'
let probing = null;

function tcpOk(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) {}
      resolve(v);
    };
    s.setTimeout(ms || 320);
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    s.on('timeout', () => fin(false));
  });
}

async function probe() {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || '';
  if (env && /^https?:\/\//i.test(env)) {
    try {
      const u = new URL(env);
      if (await tcpOk(u.hostname, u.port || 80)) return env.replace(/\/$/, '');
    } catch (e) {}
  }
  const hits = await Promise.all(
    CANDIDATE_PORTS.map((p) => tcpOk('127.0.0.1', p, 300).then((ok) => (ok ? p : 0)))
  );
  const port = hits.find(Boolean);
  return port ? 'http://127.0.0.1:' + port : 'direct';
}

function getProxy() {
  if (proxyResolved !== undefined) return Promise.resolve(proxyResolved);
  if (!probing) probing = probe().then((r) => { proxyResolved = r; return r; });
  return probing;
}

function proxyLabel(p) {
  return !p || p === 'direct' ? '直连' : p.replace(/^https?:\/\//, '');
}

/* ---------------- 底层请求 ---------------- */

function decodeContent(buf, enc) {
  if (!enc) return buf;
  enc = String(enc).toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
  } catch (e) {}
  return buf;
}

function makeResponse(statusCode, headers, buf) {
  const h = {};
  for (const k of Object.keys(headers)) {
    h[k.toLowerCase()] = Array.isArray(headers[k]) ? headers[k].join(', ') : headers[k];
  }
  const body = decodeContent(buf, h['content-encoding']);
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    url: h.location || '',
    headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
    arrayBuffer: async () => body,
    text: async () => body.toString('utf8'),
    json: async () => JSON.parse(body.toString('utf8')),
    buffer: body,
  };
}

function rawRequest(targetUrl, opts) {
  const tu = new URL(targetUrl);
  const isHttps = tu.protocol === 'https:';
  const port = tu.port || (isHttps ? 443 : 80);
  const mod = isHttps ? https : http;

  const headers = Object.assign({
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'Connection': 'close',
  }, opts.headers || {});
  if (!headers.Referer) delete headers.Referer;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } };
    const timer = setTimeout(() => {
      try { req.destroy(); } catch (e2) {}
      fail(new Error('请求超时'));
    }, opts.timeout || 20000);

    const req = mod.request({
      host: tu.hostname,
      port,
      path: tu.pathname + tu.search,
      method: opts.method || 'GET',
      headers,
      agent: false,
      servername: isHttps ? tu.hostname : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(makeResponse(res.statusCode, res.headers, Buffer.concat(chunks)));
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function tunnelRequest(targetUrl, proxyUrl, opts) {
  const tu = new URL(targetUrl);
  const pu = new URL(proxyUrl);
  const isHttps = tu.protocol === 'https:';
  const port = tu.port || (isHttps ? 443 : 80);
  const budget = opts.timeout || 20000;
  const deadline = Date.now() + budget;

  const socket = await new Promise((resolve, reject) => {
    let done = false;
    const preq = http.request({
      host: pu.hostname,
      port: pu.port || 80,
      method: 'CONNECT',
      path: tu.hostname + ':' + port,
      headers: { Host: tu.hostname + ':' + port },
      timeout: Math.min(budget, 12000),
      agent: false,
    });
    const t = setTimeout(() => { try { preq.destroy(); } catch (e) {} reject(new Error('代理连接超时')); }, Math.min(budget, 12000));
    preq.on('connect', (res, sock) => {
      clearTimeout(t);
      if (done) return;
      done = true;
      if (res.statusCode !== 200) {
        sock.destroy();
        return reject(new Error('代理拒绝连接（HTTP ' + res.statusCode + '）'));
      }
      resolve(sock);
    });
    preq.on('error', (e) => { clearTimeout(t); if (!done) { done = true; reject(new Error('连不上代理 ' + pu.host + '：' + e.message)); } });
    preq.setTimeout(Math.min(budget, 12000), () => preq.destroy(new Error('代理连接超时')));
    preq.end();
  });

  let finalSocket = socket;
  if (isHttps) {
    finalSocket = await new Promise((resolve, reject) => {
      const ts = tls.connect({ socket, servername: tu.hostname, ALPNProtocols: ['http/1.1'] }, () => resolve(ts));
      ts.on('error', reject);
    });
  }

  const mod = isHttps ? https : http;
  const headers = Object.assign({
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'Connection': 'close',
  }, opts.headers || {});
  if (!headers.Referer) delete headers.Referer;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { finalSocket.destroy(); } catch (e2) {}
      reject(e);
    };
    const remain = Math.max(1000, deadline - Date.now());
    const timer = setTimeout(() => fail(new Error('请求超时')), remain);

    const req = mod.request({
      host: tu.hostname,
      port,
      path: tu.pathname + tu.search,
      method: opts.method || 'GET',
      headers,
      agent: false,
      createConnection: () => finalSocket,
      servername: isHttps ? tu.hostname : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(makeResponse(res.statusCode, res.headers, Buffer.concat(chunks)));
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* 记录直连失败的域名，5 分钟内直接走代理 */
const directFail = new Map();
function directBlocked(host) {
  const t = directFail.get(host);
  if (!t) return false;
  if (Date.now() - t > 5 * 60 * 1000) { directFail.delete(host); return false; }
  return true;
}

async function followWith(url, opts, via) {
  let current = url;
  let redirects = 0;
  for (;;) {
    const o = Object.assign({}, opts);
    const res = via === 'direct'
      ? await rawRequest(current, o)
      : await tunnelRequest(current, via, o);
    const loc = res.headers.get('location');
    if (loc && res.status >= 300 && res.status < 400 && redirects < 5) {
      redirects++;
      current = new URL(loc, current).href;
      continue;
    }
    res.finalUrl = current;
    return res;
  }
}

/**
 * 发起请求：直连优先（快），失败自动切代理
 * @param {string} url
 * @param {object} opts { timeout, directTimeout, headers, method, body, referer }
 */
async function request(url, opts) {
  opts = opts || {};
  if (opts.referer) {
    opts.headers = Object.assign({ Referer: opts.referer }, opts.headers || {});
  }

  let host = '';
  try { host = new URL(url).hostname; } catch (e) { throw new Error('链接格式不对'); }

  const proxy = await getProxy();
  const total = opts.timeout || 25000;
  const attempts = [];

  if (!directBlocked(host)) {
    attempts.push({ via: 'direct', timeout: opts.directTimeout || Math.min(8000, total) });
  }
  if (proxy !== 'direct') attempts.push({ via: proxy, timeout: total });
  if (!attempts.length) attempts.push({ via: 'direct', timeout: total });

  let lastErr = null;
  for (const a of attempts) {
    try {
      return await followWith(url, Object.assign({}, opts, { timeout: a.timeout }), a.via);
    } catch (e) {
      lastErr = e;
      if (a.via === 'direct') directFail.set(host, Date.now());
    }
  }
  throw new Error((lastErr && lastErr.message) || '请求失败');
}

/* 首次调用前的预热，避免第一次请求卡在探测上 */
function warmup() {
  getProxy().catch(() => {});
}

module.exports = { request, getProxy, proxyLabel, warmup, UA };
