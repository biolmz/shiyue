'use strict';
/**
 * 把 lib/extract.js 包成浏览器能直接用的全局对象。
 *
 * extract.js 是零依赖的纯字符串处理（不用 fs / net），所以不需要打包器，
 * 套一层 IIFE 把 module.exports 接到 window.ShiyueExtract 就够了。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'lib', 'extract.js'), 'utf8');
const outDir = path.join(root, 'public', 'mobile');
fs.mkdirSync(outDir, { recursive: true });

const out = `/* 由 tools/make-mobile-extract.js 从 lib/extract.js 生成，不要手改 */
(function () {
  var module = { exports: {} };
  var exports = module.exports;
${src}
  window.ShiyueExtract = module.exports;
})();
`;

fs.writeFileSync(path.join(outDir, 'extract.js'), out, 'utf8');
console.log('public/mobile/extract.js', (out.length / 1024).toFixed(1) + ' KB');
