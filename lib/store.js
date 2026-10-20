'use strict';
/**
 * store.js — 极简文件型存储（无数据库依赖，全部落 data/ 目录）
 * data/library.json          文库索引（轻量，列表用）
 * data/items/<id>.json       单篇正文（blocks）
 * data/items/<id>.anno.json  单篇批注
 * data/media/<id>/<n>.<ext>  正文配图（本地缓存，离线可看）
 */
const fs = require('fs');
const path = require('path');

const DATA = process.env.SHIYUE_DATA || path.join(__dirname, '..', 'data');
const ITEMS = path.join(DATA, 'items');
const MEDIA = path.join(DATA, 'media');
const INDEX = path.join(DATA, 'library.json');

function ensureDirs() {
  for (const d of [DATA, ITEMS, MEDIA]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function newId(prefix) {
  return (prefix || 'i') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------------- 索引 ---------------- */

function getIndex() {
  ensureDirs();
  const list = readJSON(INDEX, []);
  return Array.isArray(list) ? list : [];
}

function saveIndex(list) {
  ensureDirs();
  writeJSON(INDEX, list);
}

function upsertIndex(meta) {
  const list = getIndex();
  const i = list.findIndex((x) => x.id === meta.id);
  if (i >= 0) list[i] = Object.assign({}, list[i], meta);
  else list.unshift(meta);
  saveIndex(list);
  return meta;
}

function patchIndex(id, patch) {
  const list = getIndex();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  list[i] = Object.assign({}, list[i], patch, { updatedAt: new Date().toISOString() });
  saveIndex(list);
  return list[i];
}

function removeItem(id) {
  const list = getIndex().filter((x) => x.id !== id);
  saveIndex(list);
  for (const p of [
    path.join(ITEMS, id + '.json'),
    path.join(ITEMS, id + '.anno.json'),
  ]) {
    try { fs.unlinkSync(p); } catch (e) {}
  }
  rmDir(path.join(MEDIA, id));
}

function rmDir(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) rmDir(p);
      else fs.unlinkSync(p);
    }
    fs.rmdirSync(dir);
  } catch (e) {}
}

/* ---------------- 正文 ---------------- */

function saveDoc(id, doc) {
  ensureDirs();
  writeJSON(path.join(ITEMS, id + '.json'), doc);
}

function getDoc(id) {
  return readJSON(path.join(ITEMS, id + '.json'), null);
}

/* ---------------- 批注 ---------------- */

function getAnnos(id) {
  const a = readJSON(path.join(ITEMS, id + '.anno.json'), []);
  return Array.isArray(a) ? a : [];
}

function saveAnnos(id, list) {
  ensureDirs();
  writeJSON(path.join(ITEMS, id + '.anno.json'), list);
  patchIndex(id, { annoCount: list.length });
}

/* ---------------- 媒体 ---------------- */

function mediaDir(id) {
  const d = path.join(MEDIA, id);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = {
  DATA, ITEMS, MEDIA, INDEX,
  ensureDirs, newId, readJSON, writeJSON,
  getIndex, saveIndex, upsertIndex, patchIndex, removeItem,
  saveDoc, getDoc, getAnnos, saveAnnos, mediaDir,
};
