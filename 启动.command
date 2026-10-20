#!/bin/bash
# 拾阅 · macOS 直接运行（不想装应用时用这个）
# 首次使用若双击无反应，在终端执行：chmod +x 启动.command

cd "$(dirname "$0")" || exit 1
PORT="${PORT:-7788}"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没有找到 Node.js。"
  echo "  请先安装：https://nodejs.org  （或 brew install node）"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

echo ""
echo "  ================================================"
echo "     拾阅 · 文献与长文阅读器"
echo "     正在启动，浏览器会自动打开…"
echo "  ================================================"
echo ""

( sleep 2; open "http://127.0.0.1:$PORT" ) &
PORT="$PORT" exec node server.js
