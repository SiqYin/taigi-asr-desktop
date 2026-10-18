# 台語語音轉錄 · 網頁版 —— whisper.cpp WebAssembly 建置
#
# 用法（在 repo 根目錄）：
#   bash web/wasm-src/build-wasm.sh
#
# 需求：emsdk（emcc 在 PATH）、cmake、git。
# 產物：web/wasm/main.js、web/wasm/main.wasm、web/wasm/main.worker.js

cmake_minimum_required(VERSION 3.20)
project(taigi-whisper-wasm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# WHISPER_CPP_DIR：whisper.cpp 原始碼目錄（由 build-wasm.sh 以固定 tag 取得）。
if(NOT DEFINED WHISPER_CPP_DIR)
    message(FATAL_ERROR "請設定 -DWHISPER_CPP_DIR=<whisper.cpp 原始碼目錄>")
endif()

set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)

# 關鍵：ggml 以 CMAKE_SYSTEM_PROCESSOR 判斷是否走 wasm 最佳化分支
# （ggml-cpu/CMakeLists.txt: elseif (CMAKE_SYSTEM_PROCESSOR MATCHES "wasm")）。
# 在 Windows 主機上用 emcmake 時，這個值可能被探測成 x86，導致 ggml 落入
# else() 分支、加上 -DGGML_CPU_GENERIC 退回無 SIMD 的通用實作——
# 實測會慢上百倍。因此這裡強制覆寫成 wasm。
set(CMAKE_SYSTEM_PROCESSOR "wasm" CACHE STRING "" FORCE)

add_subdirectory(${WHISPER_CPP_DIR} ${CMAKE_BINARY_DIR}/whisper.cpp EXCLUDE_FROM_ALL)

add_executable(taigi-wasm emscripten-taigi.cpp)
target_link_libraries(taigi-wasm PRIVATE whisper)

# 多執行緒（-pthread / SharedArrayBuffer）要求所有物件檔都以 atomics +
# bulk-memory 編譯，否則 wasm-ld 會拒絕 --shared-memory。whisper.cpp 由
# Emscripten 的 -pthread 自動處理，我們的綁定檔要明確加上。
target_compile_options(taigi-wasm PRIVATE -matomics -mbulk-memory -pthread)

# whisper.cpp 內部最多用 8 個執行緒，執行緒池留 16 個餘裕。
set(PTHREAD_POOL_SIZE 16)

target_link_options(taigi-wasm PRIVATE
    --bind
    -sWASM=1
    # 多執行緒：需要 crossOriginIsolated（COOP/COEP），由 coi-serviceworker 提供。
    # Emscripten 3.1.35+ 起以 -pthread 取代舊的 -sUSE_PTHREADS=1；
    # emcc 6.x 已把 USE_PTHREADS 標為 deprecated，且不再可靠地啟用 PThread，
    # 因此這裡用標準 -pthread（編譯與連結兩端都要）。
    -pthread
    -sPTHREAD_POOL_SIZE=${PTHREAD_POOL_SIZE}
    -sPTHREAD_POOL_SIZE_STRICT=0
    # Q4_0 模型 848 MB + 推理暫存；上限 4 GB 以容納 Q5_0（1.03 GB）。
    -sINITIAL_MEMORY=768MB
    -sMAXIMUM_MEMORY=4GB
    -sALLOW_MEMORY_GROWTH=1
    # 多執行緒 + 記憶體成長時，ArrayBuffer 需要可成長，否則 WASM heap 一擴張
    # 就會讓其他執行緒看到失效的檢視。
    -sGROWABLE_ARRAYBUFFERS=1
    -sFORCE_FILESYSTEM=1
    # 以 ES module 輸出：main.js 用 import.meta.url 取得自身路徑，
    # pthread 才能正確找到 main.worker.js（非模組版在 Worker 內會誤判路徑）。
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createTaigiWhisper
    -sEXPORTED_RUNTIME_METHODS=['FS','ccall','cwrap','setValue','getValue','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPF32','HEAPU8','HEAP32','addFunction','removeFunction']
    -sEXPORTED_FUNCTIONS=['_malloc','_free']
    # SIMD 加速（2021 年後的行動裝置皆支援）。
    -msimd128
    -O3
    -flto
    -sASSERTIONS=0
    -sENVIRONMENT=worker
    -sALLOW_UNIMPLEMENTED_SYSCALLS=0
)

set_target_properties(taigi-wasm PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../wasm"
    OUTPUT_NAME "main"
)
