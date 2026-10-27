@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   QQ-Plugin-Hub  AI QQ 机器人插件市场
echo ============================================
if not exist config.json (
  copy config.example.json config.json >nul
  echo 已生成 config.json（默认端口 3210，无口令）
)
start "" http://127.0.0.1:3210
node server.js
pause
