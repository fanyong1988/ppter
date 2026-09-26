@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title ppter ppt

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，正在打开中文安装页面...
  start "" "https://nodejs.org/zh-cn/download"
  echo 安装完成后，请重新双击 start-server.bat。
  pause
  exit /b 1
)

node scripts\start.js
if errorlevel 1 pause
endlocal
