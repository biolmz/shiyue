#!/bin/bash
# 拾阅 · macOS 打包脚本
# 双击运行，或终端里 ./打包-mac.command
# 产物在 dist/ 下：拾阅-1.2.0-arm64.dmg（M 系列）/ 拾阅-1.2.0-x64.dmg（Intel）

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没有找到 Node.js，请先安装：https://nodejs.org  （或 brew install node）"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

echo ""
echo "  ================================================"
echo "     拾阅 · macOS 打包"
echo "  ================================================"
echo ""

if [ ! -d node_modules ]; then
  echo "  → 首次打包，先装依赖（约 500MB，走国内镜像）"
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  npm install --no-audit --no-fund || { echo "  依赖安装失败"; read -n 1 -s -r -p "  按任意键关闭…"; exit 1; }
fi

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
export CSC_IDENTITY_AUTO_DISCOVERY=false

npm run dist:mac

echo ""
echo "  ================================================"
ls -lh dist/*.dmg 2>/dev/null || echo "  没有生成 dmg，往上翻日志看报错"
echo "  ================================================"
echo ""

open dist 2>/dev/null
read -n 1 -s -r -p "  按任意键关闭…"
