@echo off
chcp 65001 >nul
cd /d "%~dp0"
title qqbot-plugins 插件市场
echo ============================================
echo   qqbot-plugins  ·  AI QQ 机器人插件市场
echo ============================================
if not exist config.json (
  copy config.example.json config.json >nul
  echo 已生成 config.json（默认端口 3210，无口令）
)
echo 正在启动，浏览器会自动打开 http://127.0.0.1:3210
start "" http://127.0.0.1:3210

:loop
node server.js
echo.
echo [服务已退出] 5 秒后自动重启；按 Ctrl+C 或直接关窗口可停止
timeout /t 5 >nul
goto loop
