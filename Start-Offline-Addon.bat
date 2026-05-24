@echo off
title Stremio Offline Downloader Addon
set RT=C:\Users\hbar\AppData\Local\Programs\Stremio\stremio-runtime.exe
set DIR=%~dp0
echo ============================================================
echo   Stremio Offline Downloader Addon
echo ============================================================
echo.
echo   Manifest (install in Stremio):  http://127.0.0.1:11473/manifest.json
echo   Dashboard (downloads/storage):  http://127.0.0.1:11473/
echo.
echo   Keep this window open while using offline downloads.
echo ============================================================
echo.
start "" "http://127.0.0.1:11473/"
"%RT%" "%DIR%addon.js"
pause
