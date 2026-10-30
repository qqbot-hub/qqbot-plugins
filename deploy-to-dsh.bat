@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules\yaml\package.json (
  call npm.cmd ci --ignore-scripts
  if errorlevel 1 exit /b 1
)
title QQBot 主链路一键部署到 DSH
echo 正在按项目部署清单部署 SnowLuma、qq-bridge、DSH，并注册 MCP...
call npm.cmd run deploy:primary
echo.
echo 若提示需要人工操作，请完成扫码或首次登录后重新运行本脚本。
echo 注册完成后请完整退出并重新打开 DSH。
pause
