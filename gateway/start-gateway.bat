@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 记忆网关 memory-gateway

if not exist gateway.config.json (
  echo ============================================
  echo   第一次使用：已帮你复制配置模板
  echo ============================================
  copy /y gateway.config.example.json gateway.config.json >nul
  echo 请编辑 gateway.config.json，填好下面两项后再重新双击：
  echo   upstream.apiKey  -^> 你的 DeepSeek Key
  echo   core.token       -^> 跟 memory-core 的 MEMORY_TOKEN 一致（默认 local-token）
  echo.
  echo 另外记得先把记忆引擎跑起来（见 gateway\README.md 第 1 步）。
  echo.
  pause
  exit /b 1
)

echo ============================================
echo   记忆网关启动中：http://127.0.0.1:8781/v1
echo   记忆引擎应已在 http://127.0.0.1:8780
echo   关闭本窗口即停止
echo ============================================
echo.
node memory-gateway.mjs --config gateway.config.json
echo.
echo 网关已退出。按任意键关闭窗口。
pause >nul
