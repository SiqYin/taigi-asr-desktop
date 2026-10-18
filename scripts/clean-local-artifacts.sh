#!/usr/bin/env bash
# 清除本任務在本機產生的所有下載物與建置中間檔。
#
# 只刪「可重新產生」的東西，原始碼與 git 版控內容一律不動：
#   .cache/            模型（848 MB）、測試音訊、emsdk 臨時目錄、建置中間檔
#   emsdk/             Emscripten SDK（約 1.5 GB，僅編譯 WASM 用）
#   web/wasm/          WASM 建置產物（CI 會重新編譯）
#   web/screenshots/   端到端測試截圖
#   node_modules/      前端依賴
#   android/.../assets/www/  安卓 assets 暫存
#   android/.gradle, android/build, android/app/build  Gradle 產物
#   dist/, src-tauri/target/  桌面版建置產物
#
# 用法：
#   bash scripts/clean-local-artifacts.sh          # 詢問後刪除
#   bash scripts/clean-local-artifacts.sh --yes    # 不詢問直接刪除
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ASSUME_YES=0
if [ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ]; then
  ASSUME_YES=1
fi

TARGETS=(
  ".cache"
  "emsdk"
  "web/wasm"
  "web/screenshots"
  "node_modules"
  "android/app/src/main/assets/www"
  "android/.gradle"
  "android/build"
  "android/app/build"
  "android/local.properties"
  "android/app/release.keystore"
  "dist"
  "src-tauri/target"
)

echo "將清除以下本機產物（原始碼不受影響）："
for t in "${TARGETS[@]}"; do
  if [ -e "$ROOT/$t" ]; then
    size=$(du -sh "$ROOT/$t" 2>/dev/null | cut -f1 || echo "?")
    echo "  ✓ $t  ($size)"
  fi
done

if [ "$ASSUME_YES" -ne 1 ]; then
  echo
  printf "確定要刪除嗎？[y/N] "
  read -r answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "已取消。"; exit 0 ;;
  esac
fi

for t in "${TARGETS[@]}"; do
  if [ -e "$ROOT/$t" ]; then
    rm -rf "$ROOT/$t"
    echo "已刪除：$t"
  fi
done

echo
echo "完成。剩餘的 git 版控內容："
git -C "$ROOT" status --short 2>/dev/null | head -n 40 || true
