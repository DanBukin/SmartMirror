#!/usr/bin/env bash
# Ставит MagicMirror² рядом с этим репозиторием (../MagicMirror).
# Работает и на обычном компьютере (виртуальное зеркало), и на Raspberry Pi.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MM_DIR="${MM_DIR:-$ROOT/../MagicMirror}"

if [ ! -d "$MM_DIR" ]; then
  git clone --depth 1 https://github.com/MagicMirrorOrg/MagicMirror.git "$MM_DIR"
fi
cd "$MM_DIR"
# Electron нужен только для полноэкранного режима на самом зеркале.
if [ "${WITH_ELECTRON:-0}" = "1" ]; then
  npm run install-mm
else
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-audit --no-fund --omit=dev --engine-strict=false
fi
echo "MagicMirror² установлен в $MM_DIR"
