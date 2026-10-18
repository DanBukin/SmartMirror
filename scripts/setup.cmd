@echo off
chcp 65001 >nul
rem Установка для Windows: ставит MagicMirror2 рядом с папкой smartmirror (..\MagicMirror).
rem Нужны Node.js 24 LTS (https://nodejs.org) и Git (https://git-scm.com).
setlocal
set "ROOT=%~dp0.."
set "MM_DIR=%ROOT%\..\MagicMirror"

where node >nul 2>nul || (echo Не найден Node.js. Установите Node.js 24 LTS с https://nodejs.org и откройте новое окно cmd. & exit /b 1)
where git >nul 2>nul || (echo Не найден Git. Установите его с https://git-scm.com и откройте новое окно cmd. & exit /b 1)

if not exist "%MM_DIR%" (
  git clone --depth 1 https://github.com/MagicMirrorOrg/MagicMirror.git "%MM_DIR%" || exit /b 1
)
cd /d "%MM_DIR%"
set ELECTRON_SKIP_BINARY_DOWNLOAD=1
call npm install --no-audit --no-fund --omit=dev --engine-strict=false --ignore-scripts || exit /b 1
echo.
echo Готово. Запуск: cd "%ROOT%\studio" ^&^& npm run demo
echo Затем откройте http://localhost:8090
