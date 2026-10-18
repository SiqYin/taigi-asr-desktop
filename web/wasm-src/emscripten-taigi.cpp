// 台語語音轉錄 · 網頁版 —— whisper.cpp 的 Emscripten 綁定。
//
// 與 whisper.cpp 官方 examples/whisper.wasm/emscripten.cpp 的差異：
//   官方範例只把逐句結果 printf 到 stdout，網頁端拿不到時間戳；
//   本檔把「模型初始化 / 逐句文字 / 逐句起訖時間 / 進度 / 取消」都匯出成
//   JS 可呼叫的函式，讓前端能產生 SRT / VTT / TXT / JSON 字幕。
//
// 參數與桌面端保持一致（見 src-tauri/resources/sidecar/taigi_sidecar/runner.py）：
//   language = "zh"、beam_size 預設 5、開啟時間戳、可選逐字時間戳。
//
// 注意：所有時間值都以「整數毫秒 / 10 毫秒單位」回傳（int），避免 embind 把
// int64_t 轉成 JS BigInt 造成前端型別困擾。10 ms 為單位時 int32 可表示約
// 248 天，遠超實際需求。

#include "whisper.h"

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/threading.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace {

// 保留兩個 context 槽位，方便「取消後重試」時重用已載入的模型。
constexpr size_t kMaxContexts = 2;

struct Slot {
    whisper_context * ctx = nullptr;
    std::string model_path;
};

std::vector<Slot> g_slots(kMaxContexts);

// 短於這個樣本數（約 45 秒）就不值得切段平行處理——切段本身有
// 邊界重疊與合併成本，短音檔直接單次辨識反而更快。
constexpr int kWasmParallelMinSamples = 16000 * 45;

// 由 JS 端設定：true 表示使用者已要求取消目前這輪辨識。
std::atomic<bool> g_cancel{false};

int g_last_progress = -1;

}  // namespace

// 進度回呼：把 0..100 的整數百分比交給 JS 端（主執行緒的 Worker）。
EM_JS(void, taigi_js_progress, (int percent), {
    if (typeof self !== 'undefined' && self.postMessage) {
        self.postMessage({ type: 'native-progress', percent: percent });
    }
});

namespace {

void progress_callback(struct whisper_context * /*ctx*/,
                       struct whisper_state * /*state*/,
                       int progress,
                       void * /*user_data*/) {
    if (progress < 0) return;
    const int clamped = progress > 100 ? 100 : progress;
    if (clamped == g_last_progress) return;  // 去重，避免洗版
    g_last_progress = clamped;
    taigi_js_progress(clamped);
}

bool abort_callback(void * /*user_data*/) {
    return g_cancel.load(std::memory_order_relaxed);
}

whisper_context * context_of(int handle) {
    const int index = handle - 1;
    if (index < 0 || static_cast<size_t>(index) >= g_slots.size()) return nullptr;
    return g_slots[index].ctx;
}

}  // namespace

EMSCRIPTEN_BINDINGS(taigi_whisper) {
    // ------------------------------------------------------------------
    // 生命週期
    // ------------------------------------------------------------------

    // 回傳 1-based handle；0 表示失敗。
    emscripten::function("init", emscripten::optional_override([](const std::string & path_model) -> int {
        for (size_t i = 0; i < g_slots.size(); ++i) {
            if (g_slots[i].ctx != nullptr && g_slots[i].model_path == path_model) {
                return static_cast<int>(i + 1);  // 重用已載入的模型
            }
        }

        whisper_context_params cparams = whisper_context_default_params();
        cparams.use_gpu = false;  // WASM 內沒有 GPU 後端
        cparams.flash_attn = false;

        for (size_t i = 0; i < g_slots.size(); ++i) {
            if (g_slots[i].ctx == nullptr) {
                whisper_context * ctx =
                    whisper_init_from_file_with_params(path_model.c_str(), cparams);
                if (ctx == nullptr) return 0;
                g_slots[i].ctx = ctx;
                g_slots[i].model_path = path_model;
                return static_cast<int>(i + 1);
            }
        }
        return 0;  // 沒有空位
    }));

    emscripten::function("free", emscripten::optional_override([](int handle) {
        const int index = handle - 1;
        if (index < 0 || static_cast<size_t>(index) >= g_slots.size()) return;
        if (g_slots[index].ctx != nullptr) {
            whisper_free(g_slots[index].ctx);
            g_slots[index].ctx = nullptr;
            g_slots[index].model_path.clear();
        }
    }));

    emscripten::function("is_multilingual", emscripten::optional_override([](int handle) -> bool {
        whisper_context * ctx = context_of(handle);
        if (ctx == nullptr) return false;
        return whisper_is_multilingual(ctx) != 0;
    }));

    // ------------------------------------------------------------------
    // 辨識
    // ------------------------------------------------------------------

    // pcm_ptr 指向 HEAPF32 中 n_samples 個 16 kHz 單聲道樣本。
    // 回傳 0 成功、-1 參數錯、-2 模型未載入、-3 已取消、-4 推理失敗。
    emscripten::function(
        "full_default",
        emscripten::optional_override([](int handle, int n_samples, uintptr_t pcm_ptr,
                                         const std::string & language, int beam_size,
                                         bool word_timestamps) -> int {
            whisper_context * ctx = context_of(handle);
            if (ctx == nullptr) return -2;
            if (n_samples <= 0) return -1;

            g_cancel.store(false, std::memory_order_relaxed);
            g_last_progress = -1;

            whisper_full_params params =
                whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
            const bool multilingual = whisper_is_multilingual(ctx) != 0;

            params.print_realtime = false;
            params.print_progress = false;
            params.print_timestamps = false;
            params.print_special = false;
            params.translate = false;
            params.language = multilingual ? language.c_str() : "en";
            params.detect_language = false;

            // 與桌面端一致：CPU 執行緒數取可用核心，上限 8（WASM 執行緒池為 16）。
            params.n_threads =
                std::min(8, std::max(1, static_cast<int>(emscripten_num_logical_cores())));

            params.beam_search.beam_size = beam_size > 0 ? beam_size : 5;
            params.token_timestamps = word_timestamps;
            params.no_timestamps = false;
            params.single_segment = false;
            params.suppress_blank = true;
            params.temperature = 0.0f;
            // 關閉溫度回退（temperature_inc = 0 表示解碼失敗時不升溫重試）。
            // whisper 預設會在結果不理想時依序用 0.0 / 0.2 / … / 1.0 重跑最多
            // 6 輪，每輪都是一次完整前向計算——在瀏覽器裡就是數倍時間。
            // 桌面端用 faster-whisper 時不會走這條路徑，因此兩邊行為一致。
            params.temperature_inc = 0.0f;
            params.progress_callback = progress_callback;
            params.progress_callback_user_data = nullptr;
            params.abort_callback = abort_callback;
            params.abort_callback_user_data = nullptr;

            const float * pcm = reinterpret_cast<const float *>(pcm_ptr);

            // 注意：whisper.cpp 單段辨識會把 n_threads 夾到「當前解碼器數量」，
            // 對單一音檔而言等於 1 執行緒（見 whisper.cpp：
            // n_threads = std::min(params.n_threads, n_decoders_cur)）。
            // 前端因此把長音訊切塊後逐塊呼叫本函式，而不是依賴單次多執行緒。
            const int rc = whisper_full(ctx, params, pcm, n_samples);
            if (rc != 0) {
                return g_cancel.load() ? -3 : -4;
            }
            return g_cancel.load() ? -3 : 0;
        }));

    // 註：不提供 whisper_full_parallel 綁定。
    // 它在 Emscripten 的 pthread 環境下會因 C++ 例外 unwinding 觸發 abort
    // （實測崩潰訊息 "unwind"），且需要一次把整段長音訊放進 WASM 記憶體。
    // 前端改為把長音訊切成約 300 秒的區塊、逐塊呼叫 full_default：
    // 記憶體佔用固定、進度與取消即時，也不會踩到那個崩潰。

    emscripten::function("cancel", emscripten::optional_override([]() {
        g_cancel.store(true, std::memory_order_relaxed);
    }));

    // ------------------------------------------------------------------
    // 結果讀取（時間單位皆為 10 毫秒，JS 端除以 100 得秒）
    // ------------------------------------------------------------------

    emscripten::function("full_n_segments", emscripten::optional_override([](int handle) -> int {
        whisper_context * ctx = context_of(handle);
        return ctx == nullptr ? 0 : whisper_full_n_segments(ctx);
    }));

    emscripten::function("full_get_segment_text",
                         emscripten::optional_override([](int handle, int i) -> std::string {
                             whisper_context * ctx = context_of(handle);
                             if (ctx == nullptr) return std::string();
                             const char * text = whisper_full_get_segment_text(ctx, i);
                             return text != nullptr ? std::string(text) : std::string();
                         }));

    emscripten::function("full_get_segment_t0",
                         emscripten::optional_override([](int handle, int i) -> int {
                             whisper_context * ctx = context_of(handle);
                             if (ctx == nullptr) return 0;
                             return static_cast<int>(whisper_full_get_segment_t0(ctx, i));
                         }));

    emscripten::function("full_get_segment_t1",
                         emscripten::optional_override([](int handle, int i) -> int {
                             whisper_context * ctx = context_of(handle);
                             if (ctx == nullptr) return 0;
                             return static_cast<int>(whisper_full_get_segment_t1(ctx, i));
                         }));

    // 逐字時間戳記（word_timestamps = true 時可用），供精細字幕與 JSON 使用。
    emscripten::function("full_n_tokens", emscripten::optional_override([](int handle, int i) -> int {
        whisper_context * ctx = context_of(handle);
        return ctx == nullptr ? 0 : whisper_full_n_tokens(ctx, i);
    }));

    emscripten::function("full_get_token_text",
                         emscripten::optional_override([](int handle, int i, int t) -> std::string {
                             whisper_context * ctx = context_of(handle);
                             if (ctx == nullptr) return std::string();
                             const char * text = whisper_full_get_token_text(ctx, i, t);
                             return text != nullptr ? std::string(text) : std::string();
                         }));

    emscripten::function("full_get_token_t0",
                         emscripten::optional_override([](int handle, int i, int t) -> int {
                             whisper_context * ctx = context_of(handle);
                             if (ctx == nullptr) return 0;
                             return static_cast<int>(whisper_full_get_token_data(ctx, i, t).t0);
                         }));

    emscripten::function("full_get_token_t1",
                         emscripten::optional_override([](int handle, int i, int t) -> int {
                             whisper_context * ctx = context_of(handle);
                             if (ctx == nullptr) return 0;
                             return static_cast<int>(whisper_full_get_token_data(ctx, i, t).t1);
                         }));

    // ------------------------------------------------------------------
    // 資訊
    // ------------------------------------------------------------------

    // 供前端查詢執行緒設定（診斷用）
    emscripten::function("thread_config", emscripten::optional_override([]() -> std::string {
        const int logical = static_cast<int>(emscripten_num_logical_cores());
        char buf[160];
        std::snprintf(buf, sizeof(buf), "logical_cores=%d n_threads=%d", logical,
                      std::min(8, std::max(1, logical)));
        return std::string(buf);
    }));

    // 執行緒自檢：真的開 4 個 std::thread 並確認它們都跑起來。
    // 若回報 threads_ran=4，代表 pthread 版正常；回報 0 或當掉表示
    // WASM 沒有真正啟用多執行緒（會退回單執行緒，速度慢一個數量級）。
    emscripten::function("thread_selftest", emscripten::optional_override([]() -> std::string {
        std::atomic<int> counter{0};
        try {
            std::vector<std::thread> threads;
            threads.reserve(4);
            for (int i = 0; i < 4; ++i) {
                threads.emplace_back([&counter]() {
                    counter.fetch_add(1, std::memory_order_relaxed);
                });
            }
            for (auto & t : threads) {
                if (t.joinable()) t.join();
            }
        } catch (const std::exception & err) {
            return std::string("exception:") + err.what();
        } catch (...) {
            return std::string("exception:unknown");
        }
        char buf[128];
        std::snprintf(buf, sizeof(buf), "threads_ran=%d", counter.load());
        return std::string(buf);
    }));

    emscripten::function("version", emscripten::optional_override([]() -> std::string {
        return std::string(whisper_version());
    }));

    emscripten::function("system_info", emscripten::optional_override([]() -> std::string {
        return std::string(whisper_print_system_info());
    }));
}
