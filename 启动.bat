@echo off
chcp 65001 >nul
title 拾阅 · 文献阅读器
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>nul || set "NODE_EXE=C:\Users\Kael\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

echo.
echo   ================================================
echo      拾阅 · 文献与长文阅读器
echo      正在启动，浏览器会自动打开…
echo   ================================================
echo.

start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:7788"
"%NODE_EXE%" server.js

echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
