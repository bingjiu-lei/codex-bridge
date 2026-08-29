@echo off
setlocal
cd /d "%~dp0"
nvm use 24.11.1 >nul
set "CODEX_REAL_BIN=D:\dev\nodejs\node_global\codex.cmd"
set "CODEX_APP_SERVER_TRANSPORT=stdio"
set "CODEXBRIDGE_FFMPEG_PATH=D:\bilibili-video\video-tools\ffmpeg.exe"
set "CODEXBRIDGE_DEFAULT_CWD=D:\codexbridge-workspace"
set "CODEXBRIDGE_LOCALE=zh-CN"
npm run weixin:login -- --timeout-sec 480
