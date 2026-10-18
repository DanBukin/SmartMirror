@echo off
chcp 65001 >nul
rem Запускает Studio и виртуальное зеркало с демо-данными.
cd /d "%~dp0..\studio"
rem Если зеркало не открывается, задайте порт вручную, например: set MM_PORT=8091
start "" http://localhost:8090
node server.js --demo
