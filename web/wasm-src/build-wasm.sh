#!/usr/bin/env bash
# 台語語音轉錄 · 網頁版 —— 建置 whisper.cpp WebAssembly
#
# 用法：
#   bash web/wasm-src/build-wasm.sh            # 需要 emcc 已在 PATH
#   WHISPER_CPP_TAG=v1.9.5 bash web/wasm-src/build-wasm.sh
#
# 產物寫到 web/wasm/：main.js / main.wasm（＋ pthread 用的 worker 檔）
#
# 這個腳本會擋下兩種「編得出來但效能崩掉」的靜默失敗：
#   1. ggml 沒偵測到 wasm 架構 → 退回無 SIMD 的通用實作（實測慢約 40 倍）
#   2. 產物不是 ES module 或缺少 pthread → Worker 載不進來或退回單執行緒
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${HERE}/.." && pwd)"
REPO_DIR="$(cd "${WEB_DIR}/.." && pwd)"

# 與 README「釘定的第三方版本」一致；升版時同步更新 README。
WHISPER_CPP_TAG="${WHISPER_CPP_TAG:-v1.9.5}"
WHISPER_CPP_REPO="${WHISPER_CPP_REPO:-https://github.com/ggml-org/whisper.cpp.git}"

BUILD_ROOT="${BUILD_ROOT:-${REPO_DIR}/.cache/whisper-wasm}"
SRC_DIR="${BUILD_ROOT}/whisper.cpp"
BUILD_DIR="${BUILD_ROOT}/build"
OUT_DIR="${WEB_DIR}/wasm"

fail() {
  echo "" >&2
  echo "✗ $*" >&2
  exit 1
}

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

# ---------------------------------------------------------------------------
# CMake 設定：把輸出留下來檢查架構偵測結果
# ---------------------------------------------------------------------------
echo "==> 設定 CMake（emcmake）"
CONFIGURE_LOG="${BUILD_ROOT}/configure.log"
mkdir -p "${BUILD_ROOT}"

# EMSCRIPTEN_SYSTEM_PROCESSOR=wasm 是關鍵參數。
#
# Emscripten 的 toolchain 刻意把 CMAKE_SYSTEM_PROCESSOR 設成 x86（註解寫明是
# 為了讓部分專案以為是 32 位元平台），而且是用「一般變數」設定：
#     set(CMAKE_SYSTEM_PROCESSOR ${EMSCRIPTEN_SYSTEM_PROCESSOR})
# 一般變數會優先於 CACHE 條目，所以用 set(... CACHE ... FORCE) 覆寫是無效的。
# ggml 因此落入 else() 分支、加上 -DGGML_CPU_GENERIC，改用無 SIMD 的通用
# 實作 —— 編得出來、跑得動，但實測慢約 40 倍。
#
# 上游 toolchain 自己註明可用 -DEMSCRIPTEN_SYSTEM_PROCESSOR=<arch> 覆寫，
# 這裡就是採用這個官方途徑。
if ! emcmake cmake -S "${HERE}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm \
  -DWHISPER_CPP_DIR="${SRC_DIR}" 2>&1 | tee "${CONFIGURE_LOG}"; then
  fail "CMake 設定失敗，完整輸出見 ${CONFIGURE_LOG}"
fi

# 這是最容易踩、又最難察覺的坑：CMAKE_SYSTEM_PROCESSOR 在部分環境會被
# 探測成 x86，ggml 於是不走 wasm 最佳化分支、改用 -DGGML_CPU_GENERIC
# 的通用實作。編得出來、跑得動，但慢一個數量級。
# （web/wasm-src/CMakeLists.txt 已強制覆寫成 wasm，這裡是第二道防線。）
if grep -q "Unknown CPU architecture" "${CONFIGURE_LOG}"; then
  fail "ggml 未偵測到 wasm 架構，已退回無 SIMD 的通用實作（效能會慢數十倍）。
   請確認 web/wasm-src/CMakeLists.txt 中的 CMAKE_SYSTEM_PROCESSOR 覆寫仍生效。"
fi
if grep -q "GGML_CPU_GENERIC" "${CONFIGURE_LOG}"; then
  fail "ggml 被加上 -DGGML_CPU_GENERIC，表示走的是通用實作而非 wasm SIMD。"
fi
if ! grep -q "Wasm detected" "${CONFIGURE_LOG}"; then
  fail "CMake 輸出中找不到「Wasm detected」，ggml 的 wasm 分支沒有被啟用。"
fi
echo "    ✓ ggml 已走 wasm 最佳化路徑"

# ---------------------------------------------------------------------------
# 編譯
# ---------------------------------------------------------------------------
echo "==> 編譯（數分鐘）"
cmake --build "${BUILD_DIR}" -j "$(nproc 2>/dev/null || echo 4)"

mkdir -p "${OUT_DIR}"
for f in main.js main.wasm main.worker.js main.data; do
  if [ -f "${BUILD_DIR}/${f}" ]; then
    cp -f "${BUILD_DIR}/${f}" "${OUT_DIR}/${f}"
  fi
done

# ---------------------------------------------------------------------------
# 產物檢查：確認是真的能用的東西
# ---------------------------------------------------------------------------
[ -f "${OUT_DIR}/main.js" ] || fail "建置失敗：找不到 ${OUT_DIR}/main.js"
[ -f "${OUT_DIR}/main.wasm" ] || fail "建置失敗：找不到 ${OUT_DIR}/main.wasm"

# Worker 用 import 載入，必須是 ES module 匯出
grep -q "export default" "${OUT_DIR}/main.js" \
  || fail "main.js 不是 ES module（缺少 export default），engine-worker.js 會載不進來"

# 多執行緒：缺了會退回單執行緒，速度差數倍
grep -q "PThread" "${OUT_DIR}/main.js" \
  || fail "main.js 不含 PThread，WASM 未編成多執行緒版本"

WASM_SIZE=$(wc -c < "${OUT_DIR}/main.wasm")
if [ "${WASM_SIZE}" -lt 300000 ]; then
  fail "main.wasm 只有 ${WASM_SIZE} bytes，疑似建置不完整"
fi

echo ""
echo "==> 完成："
ls -lh "${OUT_DIR}"
echo ""
echo "    ggml wasm 最佳化：已啟用"
echo "    多執行緒（pthread）：已啟用"
echo "    ES module 匯出：已確認"
