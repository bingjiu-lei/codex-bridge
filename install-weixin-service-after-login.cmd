@echo off
setlocal
cd /d "%~dp0"
nvm use 24.11.1 >nul
set "CODEXBRIDGE_NODE_BIN=D:\dev\nvm\v24.11.1\node.exe"
set "CODEXBRIDGE_CODEX_BIN=D:\dev\nodejs\node_global\codex.cmd"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\service\install-windows-task.ps1" -DefaultCwd "D:\codexbridge-workspace"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\service\status-windows-task.ps1"
