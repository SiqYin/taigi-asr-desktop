#!/usr/bin/env bash
# 驗證 build-wasm.sh 的防護邏輯真的能擋下「編得出來但效能崩掉」的情況。
#
# 背景：CMAKE_SYSTEM_PROCESSOR 在部分環境會被探測成 x86，ggml 於是不走
# wasm 最佳化分支、改用通用實作 —— 編得出來、跑得動，但慢約 40 倍。
# 這個陷阱曾讓排查耗費數小時，因此固化為建置腳本的檢查。
#
# 本測試不需要 emsdk：用假的 configure log 與假產物驗證檢查邏輯本身。
#
# 用法：bash scripts/test-wasm-build-guards.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="${ROOT}/web/wasm-src/build-wasm.sh"
CMAKE_FILE="${ROOT}/web/wasm-src/CMakeLists.txt"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "${expected}" = "${actual}" ]; then
    echo "✓ ${name}"
    PASS=$((PASS + 1))
  else
    echo "✗ ${name}（預期 ${expected}，實際 ${actual}）"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# 1) 腳本本身語法正確
# ---------------------------------------------------------------------------
if bash -n "${BUILD_SCRIPT}" 2>/dev/null; then
  check "build-wasm.sh 語法正確" "ok" "ok"
else
  check "build-wasm.sh 語法正確" "ok" "syntax-error"
fi

# ---------------------------------------------------------------------------
# 2) 防護字串確實存在於腳本中
# ---------------------------------------------------------------------------
for pattern in \
  "Unknown CPU architecture" \
  "GGML_CPU_GENERIC" \
  "Wasm detected" \
  "export default" \
  "PThread"
do
  if grep -qF "${pattern}" "${BUILD_SCRIPT}"; then
    check "腳本包含檢查：${pattern}" "found" "found"
  else
    check "腳本包含檢查：${pattern}" "found" "missing"
  fi
done

# ---------------------------------------------------------------------------
# 2b) 必須帶 EMSCRIPTEN_SYSTEM_PROCESSOR=wasm
#
# Emscripten toolchain 用「一般變數」把 CMAKE_SYSTEM_PROCESSOR 設成 x86，
# 一般變數優先於 CACHE 條目，所以只能在命令列用這個參數覆寫。
# 少了它，ggml 會退回無 SIMD 的通用實作（實測慢約 40 倍）。
# ---------------------------------------------------------------------------
if grep -qF -- "-DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm" "${BUILD_SCRIPT}"; then
  check "build-wasm.sh 帶 EMSCRIPTEN_SYSTEM_PROCESSOR=wasm" "found" "found"
else
  check "build-wasm.sh 帶 EMSCRIPTEN_SYSTEM_PROCESSOR=wasm" "found" "missing"
fi

if grep -qF "EMSCRIPTEN_SYSTEM_PROCESSOR" "${CMAKE_FILE}"; then
  check "CMakeLists 有對應的說明或檢查" "found" "found"
else
  check "CMakeLists 有對應的說明或檢查" "found" "missing"
fi

# ---------------------------------------------------------------------------
# 3) 用假 log 驗證判定邏輯（重現腳本中的條件）
# ---------------------------------------------------------------------------
judge_log() {
  local log="$1"
  if grep -q "Unknown CPU architecture" "${log}"; then
    echo "reject-generic"
  elif grep -q "GGML_CPU_GENERIC" "${log}"; then
    echo "reject-generic"
  elif ! grep -q "Wasm detected" "${log}"; then
    echo "reject-no-wasm"
  else
    echo "accept"
  fi
}

# 正常情況：有 Wasm detected、無通用實作字樣
cat > "${TMP}/good.log" <<'EOF'
-- The CXX compiler identification is Clang
-- Wasm detected
-- Adding CPU backend variant ggml-cpu:  
-- Configuring done
EOF
check "正常 build log 應被接受" "accept" "$(judge_log "${TMP}/good.log")"

# 陷阱一：Windows 上 emcmake 把架構探測成 x86
cat > "${TMP}/x86.log" <<'EOF'
-- CMAKE_SYSTEM_PROCESSOR: x86
-- Unknown CPU architecture.  Falling back to generic implementations.
-- Adding CPU backend variant ggml-cpu: -DGGML_CPU_GENERIC 
EOF
check "架構被探測成 x86 應被擋下" "reject-generic" "$(judge_log "${TMP}/x86.log")"

# 陷阱二：明確被加上 GGML_CPU_GENERIC
cat > "${TMP}/generic.log" <<'EOF'
-- Adding CPU backend variant ggml-cpu: -DGGML_CPU_GENERIC 
EOF
check "含 GGML_CPU_GENERIC 應被擋下" "reject-generic" "$(judge_log "${TMP}/generic.log")"

# 陷阱三：完全沒有 wasm 偵測訊息
cat > "${TMP}/silent.log" <<'EOF'
-- Configuring done
-- Generating done
EOF
check "缺少 Wasm detected 應被擋下" "reject-no-wasm" "$(judge_log "${TMP}/silent.log")"

# ---------------------------------------------------------------------------
# 4) 產物檢查邏輯（用假產物重現）
# ---------------------------------------------------------------------------
judge_artifact() {
  local js="$1" wasm_size="$2"
  if ! grep -q "export default" "${js}"; then
    echo "reject-not-esm"
  elif ! grep -q "PThread" "${js}"; then
    echo "reject-no-pthread"
  elif [ "${wasm_size}" -lt 300000 ]; then
    echo "reject-too-small"
  else
    echo "accept"
  fi
}

echo 'export default function(){}; /* PThread */' > "${TMP}/good.js"
check "正常產物應被接受" "accept" "$(judge_artifact "${TMP}/good.js" 1200000)"

echo 'var Module = function(){};' > "${TMP}/commonjs.js"
check "非 ES module 產物應被擋下" "reject-not-esm" "$(judge_artifact "${TMP}/commonjs.js" 1200000)"

echo 'export default function(){};' > "${TMP}/nopthread.js"
check "缺 pthread 的產物應被擋下" "reject-no-pthread" "$(judge_artifact "${TMP}/nopthread.js" 1200000)"

echo 'export default function(){}; /* PThread */' > "${TMP}/tiny.js"
check "過小的 wasm 應被擋下" "reject-too-small" "$(judge_artifact "${TMP}/tiny.js" 1000)"

# ---------------------------------------------------------------------------
echo ""
echo "${PASS}/$((PASS + FAIL)) 項通過"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
echo "建置防護邏輯驗證通過"
