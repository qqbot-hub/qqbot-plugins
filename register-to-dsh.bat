@echo off
chcp 65001 >nul
cd /d "%~dp0"
set /p PROFILE=请输入 DSH profile 名（直接回车用 desktop）:
if "%PROFILE%"=="" set PROFILE=desktop
node scripts\register-dsh.mjs %PROFILE%
echo.
echo 完成后请【完整退出并重新打开 DSH】，然后在 DSH 里搜 mcp__qqhub__ 验证。
pause
