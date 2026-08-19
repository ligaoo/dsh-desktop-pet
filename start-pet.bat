@echo off
rem One-click start for the desktop pet (no console window, no node icon).
rem Double-click or run from a shell.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0lib\entries\window.js"
