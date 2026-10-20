'use strict';
/**
 * electron-builder afterPack 钩子（仅 macOS 生效）
 *
 * 为什么需要：
 *   Apple Silicon 上，任何未签名的可执行文件都会被内核直接拒绝（表现为
 *   「应用已损坏，无法打开」）。没有 Apple 开发者证书时 electron-builder 会
 *   整个跳过签名，产物看起来正常但装到 M 系列机器上打不开。
 *
 * 所以这里在打包后补一次 ad-hoc 签名（codesign -s -）。
 *   - 有正式证书时：这一步的签名会被后续正式签名覆盖，无副作用
 *   - 没有证书时：保证 app 至少能在本机运行
 *   - 失败不中断构建，只提示手动命令
 */
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, appName + '.app');

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'pipe',
      timeout: 180000,
    });
    console.log('  • ad-hoc 签名完成  ' + appName + '.app');
  } catch (e) {
    console.warn(
      '  • ad-hoc 签名失败，如遇「应用已损坏」请手动执行：\n' +
      '      codesign --force --deep --sign - "' + appPath + '"'
    );
  }
};
