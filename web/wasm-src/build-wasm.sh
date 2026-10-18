#!/usr/bin/env bash
# 台語語音轉錄 · 網頁版 —— 建置 whisper.cpp WebAssembly
#
# 用法：
#   bash web/wasm-src/build-wasm.sh            # 需要 emcc 已在 PATH
#   WHISPER_CPP_TAG=v1.9.5 bash web/wasm-src/build-wasm.sh
#
# 產物寫到 web/wasm/：main.js / main.wasm / main.worker.js
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${HERE}/.." && pwd)"
REPO_DIR="$(cd "${WEB_DIR}/.." && pwd)"

# 與 README「釘定的第三方版本」一致；升版時同步更新 README。
WHISPER_CPP_TAG="${WHISPER_CPP_TAG:-v1.9.5}"
WHISPER_CPP_REPO="${WHISPER_CPP_REPO:-https://github.com/ggml-org/whisper.cpp.git}"

BUILD_ROOT="${BUILD_ROOT:-${REPO_DIR}/.cache/whisper-wasm}"
SRC_DIR="${BUILD_ROOT}/whisper.cpp"
OUT_DIR="${WEB_DIR}/wasm"

if ! command -v emcc >/dev/null 2>&1; then
  echo "找不到 emcc。請先安裝並啟用 emsdk：" >&2
  echo "  git clone https://github.com/emscripten-core/emsdk.git" >&2
  echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh" >&2
  exit 1
fi

echo "==> emcc: $(emcc -v 2>&1 | head -n 1)"

if [ ! -d "${SRC_DIR}/.git" ]; then
  mkdir -p "${BUILD_ROOT}"
  echo "==> 取得 whisper.cpp ${WHISPER_CPP_TAG}"
  git clone --depth 1 --branch "${WHISPER_CPP_TAG}" "${WHISPER_CPP_REPO}" "${SRC_DIR}"
else
  echo "==> 重用既有 whisper.cpp：${SRC_DIR}"
fi

echo "==> 設定 CMake（emcmake）"
emcmake cmake -S "${HERE}" -B "${BUILD_ROOT}/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_CPP_DIR="${SRC_DIR}"

echo "==> 編譯（數分鐘）"
cmake --build "${BUILD_ROOT}/build" -j "$(nproc 2>/dev/null || echo 4)"

mkdir -p "${OUT_DIR}"
for f in main.js main.wasm main.worker.js main.data; do
  if [ -f "${BUILD_ROOT}/build/${f}" ]; then
    cp -f "${BUILD_ROOT}/build/${f}" "${OUT_DIR}/${f}"
  elif [ -f "${WEB_DIR}/wasm/${f}" ]; then
    : # 已直接輸出到目標目錄
  fi
done

if [ ! -f "${OUT_DIR}/main.js" ]; then
  echo "建置失敗：找不到 ${OUT_DIR}/main.js" >&2
  exit 1
fi

echo "==> 完成："
ls -lh "${OUT_DIR}"
