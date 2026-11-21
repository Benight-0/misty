@echo off
cd /d "%~dp0"
echo Archival: http://127.0.0.1:8787
echo Keep Docker Desktop running. Close this window to stop Archival.
node --disable-warning=ExperimentalWarning app\server.mjs
pause
