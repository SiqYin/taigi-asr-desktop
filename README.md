# 台語語音轉錄 · Taigi ASR（桌面版 · 網頁版 · 安卓版）

把 [thc1006/breeze-asr-taigi](https://github.com/thc1006/breeze-asr-taigi)（核心模型為
MediaTek [Breeze-ASR-26](https://huggingface.co/MediaTek-Research/Breeze-ASR-26)，
以 Whisper-large-v2 用約一萬小時台語資料微調）包裝成**開箱即用的轉錄工具**：
拖入台語影片／音訊 → 自動轉錄 → 輸出 SRT / VTT / TXT / JSON 字幕與逐字稿。

同一個模型，三種執行方式：

| 版本 | 平台 | 執行方式 | 取得 |
| --- | --- | --- | --- |
| **桌面版** | Windows 10/11 x64 | Tauri 2 外殼 + 本機 Python sidecar（faster-whisper / CT2） | [Releases](https://github.com/SiqYin/taigi-asr-desktop/releases) 下載 NSIS 安裝包 |
| **網頁版** | 任何現代瀏覽器（桌機／手機／平板） | 純前端，whisper.cpp 以 WebAssembly 在瀏覽器內推理 | <https://siqyin.github.io/taigi-asr-desktop/> |
| **安卓版** | Android 7.0+ | WebView 殼承載同一個網頁版，離線可用 | Releases 下載 APK |

三者輸出格式逐位元組一致（有自動化測試守著，見〈驗證〉），都支援
句級時間戳記、可選逐字時間戳記、多檔排隊、即時進度與取消。

> 狀態：v1.0.0。Windows 版為既有發布；網頁版與安卓版為本次新增。

## 三種版本怎麼選

- **想要最快、最省事、要處理長影片** → 桌面版。有 NVIDIA GPU 時自動用 CUDA 加速
  （4GB 顯存即跑得動），純 CPU 亦可；首次啟動自動準備 Python 環境並下載 2.9 GB 模型。
- **不想安裝、想在手機或平板上用、或只是偶爾轉一段** → 網頁版。開啟網址即用，
  模型下載一次後存在瀏覽器快取；檔案不上傳到任何伺服器。
- **想要手機上的獨立 App（可離線、有桌面圖示）** → 安卓版 APK。

## 桌面版架構

桌面架構參考 [deepseek-harness-desktop](https://github.com/fendouai/deepseek-harness-desktop)：
Tauri 2 小型外殼負責視窗與進程監管，真正的推理由本機 Python sidecar
在 `127.0.0.1` 隨機埠提供；應用退出時整個進程樹（Python、ffmpeg）一併回收。

## 特色

- **台語專用模型**：桌面版用 `paulpengtw/faster-whisper-Breeze-ASR-26`（CT2 預轉換版），
  網頁／安卓版用同一顆模型的 `weemed/Breeze-ASR-26-GGML`（whisper.cpp 版）；
  三者句級時間戳記，可選逐字時間戳記。
- **低顯存 / 無 GPU 皆可跑**：依顯存自動選擇 `int8_float16`（4GB 級 GPU 主力路徑）
  或純 CPU `int8`，決策表與上游一致；**不需要安裝 torch**。
- **零指令操作**：首次啟動自動準備 Python 環境（有系統 Python 3.10–3.13 就沿用；
  沒有則自動下載 SHA-256 釘定的 [python-build-standalone](https://github.com/astral-sh/python-build-standalone)）、
  建立 venv、安裝依賴、下載模型（約 2.9 GB，只此一次）。
- **常見影音格式全支援**：mp4 / mkv / mov / mp3 / m4a / wav / flac / ogg / webm…
  （桌面版透過 sidecar 自帶的 ffmpeg；網頁版用瀏覽器內建解碼器，
  遇到 mkv / mov 等容器會自動退回即時擷取模式）。
- **模型常駐、批次轉錄**：多檔排隊，模型只載入一次；即時進度、逐句結果、取消任務。
- **三端響應式**：網頁版針對桌機（雙欄）、手機（單欄 + 底部固定動作列）、
  平板與手機橫向（短高度自動切雙欄）分別調校，並處理瀏海安全區與觸控目標大小。
- **可上字幕**：網頁／安卓版內建預覽播放器，轉錄結果直接掛成 VTT 字幕軌，
  點逐字稿可跳到對應時間。
- **隱私**：全程本機推理。桌面版 sidecar 只監聽 loopback 並以隨機 token 鑑權；
  網頁／安卓版完全在瀏覽器內運算，無任何上傳。

## 架構

```
┌─────────────────────────────┐
│ Tauri 2 視窗（WebView 前端） │  拖放、任務列表、設定（Vanilla TS + Vite）
└──────────────┬──────────────┘
               │ invoke / event（進度推送）
┌──────────────┴──────────────┐
│ Rust 外殼（src-tauri）       │  環境引導、進程監管、Job Object 進程樹回收
└──────────────┬──────────────┘
               │ 啟動 python -m taigi_sidecar（127.0.0.1:隨機埠, token）
┌──────────────┴──────────────┐
│ Python sidecar（FastAPI）    │  任務佇列 / SSE / ffmpeg / 格式輸出
│  faster-whisper（CT2）       │  Breeze-ASR-26 模型常駐
└─────────────────────────────┘
```

- 前端不直接讀寫檔案：檔案／資料夾經 Tauri 對話框與視窗拖放取得**本機路徑**，
  交給同機的 sidecar 處理，避免把大型影片複製進 HTTP。
- 模型快取、設定、日誌都在 Tauri 應用資料目錄：
  `%APPDATA%\ai.taigi.asrdesktop\`（`models/`、`config.json`、`logs/`）。

## 從原始碼構建

需求：[Tauri 2 先決條件](https://v2.tauri.app/start/prerequisites/)（Windows 上需
Microsoft C++ Build Tools、WebView2 Runtime，後者 Win10/11 通常內建）、Node 20+、
pnpm、Rup stable。

```powershell
git clone <your-repo-url> taigi-asr-desktop
cd taigi-asr-desktop
pnpm install
pnpm tauri dev      # 開發模式
pnpm tauri build    # 產出 src-tauri/target/release/bundle/nsis/*.exe
```

開發模式下 sidecar 的 Python 原始碼來自 `src-tauri/resources/sidecar/`（透過
`PYTHONPATH` 載入），首次啟動一樣會走完整環境引導。

## 網頁版架構

```
┌──────────────────────────────────────────────┐
│ 瀏覽器（GitHub Pages 靜態託管）              │
│                                              │
│  主執行緒                                    │
│    ├─ 音訊解碼：decodeAudioData → 16 kHz     │
│    ├─ 分塊：依安靜點切 300 秒區塊            │
│    ├─ 模型快取：IndexedDB（848 MB，一次）    │
│    └─ 字幕輸出：SRT / VTT / TXT / JSON       │
│                  │ postMessage               │
│  Worker（module）│                           │
│    └─ whisper.cpp WASM（pthread 多執行緒）   │
│         └─ Breeze-ASR-26 GGML Q4_0/Q5_0      │
│                                              │
│  coi-serviceworker.js → 注入 COOP/COEP       │
│    （GitHub Pages 無法自訂標頭，靠它取得     │
│      SharedArrayBuffer 才能多執行緒）        │
└──────────────────────────────────────────────┘
```

關鍵設計取捨：

- **為什麼用 whisper.cpp 而不是 faster-whisper**：CT2 無法編譯到 WebAssembly；
  whisper.cpp 有官方 WASM 目標，且社群已提供同款模型的 GGML 量化版。
- **為什麼不用 sherpa-onnx ONNX 版**：ONNX 版 RTF 約 1.3（比 CT2 慢 6 倍），
  而 GGML Q4_0 在 CPU 4 執行緒的 RTF 是 0.40，瀏覽器上體驗明顯更好。
- **為什麼模型放 IndexedDB**：848 MB 放 HTTP 快取容易被瀏覽器淘汰，
  IndexedDB 搭配 `navigator.storage.persist()` 更可靠。
- **為什麼要 coi-serviceworker**：`SharedArrayBuffer` 需要 cross-origin isolation，
  而 GitHub Pages 不能設 HTTP 標頭。Service Worker 必須放在**網站根目錄**，
  否則作用域只涵蓋子目錄、無法控制主頁面（這是最容易踩的坑）。
- **分塊轉錄**：長音訊按安靜點切成約 300 秒區塊，避免單次塞爆 WASM 記憶體，
  也讓進度條與取消更即時。

## 安卓版

安卓版是**同一個網頁版的 WebView 殼**，不是另一份實作——所以功能、介面、
三端適配完全一致，且離線可用（模型存在 WebView 的 IndexedDB）。

兩個關鍵點：

- 用 `WebViewAssetLoader` 以 `https://appassets.androidplatform.net/` 提供資產，
  **不能用 `file://`**：Service Worker 只在安全來源可用，而多執行緒 WASM 需要
  Service Worker 注入 COOP/COEP 來取得 `SharedArrayBuffer`。用 `file://` 會靜默
  退回單執行緒，速度差數倍。
- 透過 `JavascriptInterface`（`TaigiAndroid.saveText`）把字幕寫進系統「下載」目錄，
  這是桌面版「輸出到資料夾」在 Android 上的等價行為。

## 從原始碼構建

### 桌面版（Windows）

需求：[Tauri 2 先決條件](https://v2.tauri.app/start/prerequisites/)（Windows 上需
Microsoft C++ Build Tools、WebView2 Runtime，後者 Win10/11 通常內建）、Node 20+、
pnpm、Rust stable。

```powershell
git clone https://github.com/SiqYin/taigi-asr-desktop.git
cd taigi-asr-desktop
pnpm install
pnpm tauri dev      # 開發模式
pnpm tauri build    # 產出 src-tauri/target/release/bundle/nsis/*.exe
```

開發模式下 sidecar 的 Python 原始碼來自 `src-tauri/resources/sidecar/`（透過
`PYTHONPATH` 載入），首次啟動一樣會走完整環境引導。

### 網頁版

網頁版需要先編譯 whisper.cpp 的 WebAssembly 產物（`web/wasm/main.js` + `main.wasm`）。
GitHub Actions 會自動完成，本機開發則需要 emsdk：

```bash
# 1) 安裝 emsdk
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh

# 2) 編譯 WASM（釘定 whisper.cpp v1.9.5）
cd .. && bash web/wasm-src/build-wasm.sh

# 3) 本機預覽（模擬 GitHub Pages，不含 COOP/COEP 標頭）
node tools/serve-web.mjs      # → http://127.0.0.1:4319/
```

> Windows 上若遇到 `clang: error: unable to make temporary file`，把 `TMP`／`TEMP`
> 指向工作區內的目錄（例如 `.cache/emtmp`）即可——某些受限環境的系統臨時目錄
> 對 clang 不可用。

### 安卓版

```bash
bash web/wasm-src/build-wasm.sh        # 先有 WASM
bash scripts/stage-android-assets.sh   # 把 web/ + wasm/ 放進 assets
cd android && gradle assembleRelease   # 產出 app/build/outputs/apk/release/
```

未設定簽章環境變數時輸出的是未簽章 APK；CI 會用 secrets 中的 keystore 簽章。

## 專案結構

```
src/                     # 桌面版前端（Vanilla TypeScript + Vite）
src-tauri/
  src/
    lib.rs               # 狀態機、Tauri 命令
    python.rs            # Python 探測、standalone 下載、venv、bootstrap 監管
    sidecar.rs           # sidecar 進程啟動 / 就緒探測 / 關閉回收
    jobobj.rs            # Windows Job Object（KILL_ON_JOB_CLOSE）
  resources/
    bootstrap.py         # 首次環境安裝（pip + 模型預載，JSON Lines 進度）
    requirements*.txt
    sidecar/taigi_sidecar/
      __main__.py        # port 0 啟動，輸出 TAIGI_SIDECAR_READY
      app.py             # FastAPI 路由 + SSE
      jobs.py            # 單 worker 任務佇列
      runner.py          # 硬體探測 + faster-whisper 封裝
      settings.py / events.py
web/                     # 網頁版（純靜態，GitHub Pages 託管）
  index.html
  coi-serviceworker.js   # 注入 COOP/COEP（必須在根目錄）
  css/style.css          # 三端響應式樣式
  js/
    main.js              # 主控：任務佇列、進度、預覽上字幕
    engine-worker.js     # Worker：WASM 載入與辨識
    audio.js             # 音訊解碼、16 kHz 重採樣、靜音切塊
    cache.js             # 模型 IndexedDB 快取
    models.js            # 模型登記表
    subtitles.js         # 四種字幕格式（與桌面端逐位元組一致）
  wasm-src/
    emscripten-taigi.cpp # whisper.cpp 的 embind 綁定（含時間戳）
    CMakeLists.txt
    build-wasm.sh
android/                 # 安卓 WebView 殼（Gradle）
  app/src/main/java/ai/taigi/asrweb/MainActivity.java
scripts/stage-android-assets.sh
tools/                   # 開發與驗證工具
  serve-web.mjs          # 本機靜態伺服器（模擬 Pages）
  chrome.mjs             # 跨平台尋找 Chrome / Edge（測試共用）
  e2e-web.mjs            # 三端版面與功能端到端測試
  e2e-production.mjs     # 正式路徑端到端（拖入檔案→辨識→輸出）
  e2e-inference.mjs      # 真實模型推理端到端測試
  profile-inference.mjs  # 推理效能剖析
  verify-subtitle-parity.py  # 字幕格式與桌面端逐位元組比對
  verify-wasm-browser.mjs    # WASM 在瀏覽器中的載入與 API 驗證
  verify-model-cache.mjs     # 模型只下載一次的回歸測試
  verify-deployed-site.mjs   # 線上正式網址的部署驗證
  *-worker.js            # 上述測試在瀏覽器 Worker 內執行的輔助腳本
.github/workflows/
  ci.yml                 # sidecar 冒煙測試 + Windows 構建
  release.yml            # tag 發 Windows Release
  web.yml                # 編譯 WASM + 部署 GitHub Pages
  android.yml            # 構建 APK 並附加到 Release
```

## 效能實測與適用範圍（重要）

網頁版與桌面版用的是**同一顆模型**（Breeze-ASR-26，Whisper-large-v2 微調，1.55B 參數），
但執行環境差異巨大，實測數據如下：

| 版本 | 執行環境 | RTF（即時倍率） | 11 秒音訊耗時 |
| --- | --- | --- | --- |
| 桌面版 | CTranslate2 原生 + GPU（4GB 顯存） | **0.21** | 約 2 秒 |
| 桌面版 | CTranslate2 原生 + CPU | 約 0.5–1.0 | 約 6–11 秒 |
| 網頁／安卓版 | whisper.cpp WASM（SIMD + 4 執行緒） | **9–19** | 99–205 秒 |

RTF = 處理時間 ÷ 音訊長度，越小越快。實測環境：Chrome 128、16 執行緒 CPU、
`WASM_SIMD=1`、`REPACK=1`、`threads_ran=4`（已確認 SIMD 與多執行緒都生效）。

**這個差距的來源**（已逐項驗證，不是設定問題）：

1. **模型本身很大**：large-v2 有 1.55B 參數，一次編碼器前向就要算 30 秒窗口。
2. **WASM 有固有開銷**：瀏覽器沙箱內無法用 AVX2/AVX512 等原生指令集，
   只能靠 128 位元 SIMD，矩陣運算效率約為原生實作的 1/3～1/5。
3. **whisper.cpp 單段限制**：`whisper_full` 內部把 `n_threads` 夾到解碼器數量，
   單一音檔等同單執行緒；`whisper_full_parallel` 在 Emscripten pthread 下會
   因 C++ 例外 unwinding 而崩潰，因此不可用。

**因此網頁版的定位是「免安裝、隨開即用、隱私優先」的輕量方案**，適合：

- 短音檔（1–3 分鐘內的台語片段、訪談節錄、課堂錄音）
- 手機／平板上臨時處理，不想安裝任何東西
- 在別人的電腦上（無法安裝軟體）應急使用

**不適合**：長影片（30 分鐘以上）、批次處理大量檔案、需要頻繁轉錄的日常工作
——這些請用桌面版，速度差距達 40 倍以上。

若日後要提升網頁版速度，可行方向：改用 whisper-small/base 級別的台語模型
（需先有對應的 GGML 轉換版）、或接入雲端 GPU 推理 API（但會失去「不上傳」的隱私特性）。

## 驗證

本專案對「網頁版與桌面端功能一致」有自動化證據：

```bash
pnpm web:verify                     # 字幕格式與桌面端 Python 逐位元組比對（20 項）
pnpm web:verify:wasm                # WASM 在瀏覽器中載入、embind API 齊全（8 項）
pnpm web:verify:cache               # 模型只下載一次、之後走快取（9 項）
pnpm web:e2e                        # 三端版面 + 功能（37 項）
pnpm web:e2e:prod                   # 正式路徑：拖入檔案→辨識→輸出字幕
node tools/verify-deployed-site.mjs # 打線上正式網址驗證部署結果（14 項）
node tools/e2e-inference.mjs        # 真實模型推理 → 字幕（需先下載模型與測試音訊）
```

測試需要本機有 Chrome / Edge；找不到時會提示設定 `CHROME_PATH`。

`tools/verify-deployed-site.mjs` 直接驗證已部署的
<https://siqyin.github.io/taigi-asr-desktop/>：跨域隔離是否生效、
WASM 能否在**應用自己的 Worker** 中初始化、三端版面是否無溢出。

> 注意：驗證 WASM 必須走 Worker 路徑。頁面帶有 CSP
> （`script-src 'self' 'wasm-unsafe-eval'`），Emscripten 的 glue 在主執行緒
> 會用到 `new Function` 而被擋下；正式版本是在 Worker 內載入，Worker 有
> 獨立的 CSP 環境。若在主執行緒直接 `import()`，測到的不是使用者的實際情況。

`tools/e2e-web.mjs` 會量測 7 種視窗尺寸（桌機 1440/1280、平板橫向 1180、
平板直向 820、手機橫向 844、手機直向 390、小手機 360），確認無水平溢出、
欄數切換正確、手機底部動作列固定可見，並輸出截圖到 `web/screenshots/`。

## 釘定的第三方版本

| 元件 | 版本 |
| --- | --- |
| breeze-asr-taigi | commit `59da766e9156fed409666d15c1879176baac1fa0`（見 `bootstrap.py`） |
| 桌面版模型 | `paulpengtw/faster-whisper-Breeze-ASR-26`（CT2，首次啟動下載約 2.9 GB） |
| 網頁／安卓版模型 | `weemed/Breeze-ASR-26-GGML`（Q4_0 848 MB / Q5_0 1.03 GB） |
| whisper.cpp | tag `v1.9.5`（WASM 建置，見 `web/wasm-src/build-wasm.sh`） |
| Emscripten | 最新版（CI 用 `emscripten-core/setup-emsdk@v14`） |
| coi-serviceworker | v0.1.7（MIT，`web/coi-serviceworker.js`） |
| 後備 Python | python-build-standalone CPython 3.11.17 / tag `20261009`（SHA-256 釘定於 `python.rs`） |

## 致謝

- [MediaTek Research](https://huggingface.co/MediaTek-Research) — Breeze-ASR-26 官方模型
- [thc1006/breeze-asr-taigi](https://github.com/thc1006/breeze-asr-taigi) — 台語轉錄器與低顯存配置
- [paulpengtw](https://huggingface.co/paulpengtw) — CT2 預轉換模型
- [weemed](https://huggingface.co/weemed) — GGML / ONNX 邊緣版本模型
- [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) — WASM 推理引擎
- [gzuidhof/coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) — GitHub Pages 跨域隔離
- [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)、
  [OpenAI Whisper](https://github.com/openai/whisper)
- [fendouai/deepseek-harness-desktop](https://github.com/fendouai/deepseek-harness-desktop)
  — Tauri 外殼 + 本機 sidecar 的架構原型
- [SiqYin/shavian-transliteratar](https://github.com/SiqYin/shavian-transliteratar)
  — 網頁版／安卓 WebView 殼的實作參考

## 授權

本專案程式碼採 [MIT](LICENSE)。模型本身的授權以各 HuggingFace 模型頁面公告為準。
