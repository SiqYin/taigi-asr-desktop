#!/usr/bin/env bash
# 把網頁版（web/ + 建置好的 web/wasm/）與圖示暫存進安卓殼的 assets 目錄。
#
# 用法（repo 根目錄）：
#   bash scripts/stage-android-assets.sh
#
# 前置：先跑過 web/wasm-src/build-wasm.sh 產生 web/wasm/。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="${ROOT}/web"
WASM="${WEB}/wasm"
DEST="${ROOT}/android/app/src/main/assets/www"

if [ ! -f "${WASM}/main.js" ]; then
  echo "找不到 ${WASM}/main.js" >&2
  echo "請先建置 WASM：bash web/wasm-src/build-wasm.sh" >&2
  exit 1
fi

echo "==> 清理 ${DEST}"
rm -rf "${DEST}"
mkdir -p "${DEST}"

echo "==> 複製網頁版（web/ 自包含：index.html、coi-serviceworker.js、css/、js/、icons/）"
cp "${WEB}/index.html" "${WEB}/manifest.webmanifest" "${WEB}/coi-serviceworker.js" "${DEST}/"
cp -r "${WEB}/css" "${WEB}/js" "${WEB}/icons" "${DEST}/"
cp -r "${WASM}" "${DEST}/wasm"

echo "==> 複製啟動圖示（Android mipmap，沿用桌面端 Tauri 圖示）"
ICONS="${ROOT}/src-tauri/icons"
for dpi in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  SRC_DIR="${ICONS}/android/mipmap-${dpi}"
  DST_DIR="${ROOT}/android/app/src/main/res/mipmap-${dpi}"
  if [ -d "${SRC_DIR}" ]; then
    mkdir -p "${DST_DIR}"
    cp "${SRC_DIR}"/ic_launcher*.png "${DST_DIR}/" 2>/dev/null || true
  fi
done

mkdir -p "${ROOT}/android/app/src/main/res/mipmap-anydpi-v26"
cp "${ICONS}/android/mipmap-anydpi-v26/ic_launcher.xml" \
   "${ROOT}/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml" 2>/dev/null || true
mkdir -p "${ROOT}/android/app/src/main/res/values"
cp "${ICONS}/android/values/ic_launcher_background.xml" \
   "${ROOT}/android/app/src/main/res/values/ic_launcher_background.xml" 2>/dev/null || true

echo "==> 完成，內容："
du -sh "${DEST}"
find "${DEST}" -maxdepth 1 -mindepth 1 | sort
