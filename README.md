# 台語語音轉錄桌面客戶端 · Taigi ASR Desktop

把 [thc1006/breeze-asr-taigi](https://github.com/thc1006/breeze-asr-taigi)（核心模型為
MediaTek [Breeze-ASR-26](https://huggingface.co/MediaTek-Research/Breeze-ASR-26)，
以 Whisper-large-v2 用約一萬小時台語資料微調）包裝成**開箱即用的 Windows 桌面應用**：
拖入台語影片／音訊 → 自動轉錄 → 輸出 SRT / VTT / TXT / JSON 字幕與逐字稿。

桌面架構參考 [deepseek-harness-desktop](https://github.com/fendouai/deepseek-harness-desktop)：
Tauri 2 小型外殼負責視窗與進程監管，真正的推理由本機 Python sidecar
在 `127.0.0.1` 隨機埠提供；應用退出時整個進程樹（Python、ffmpeg）一併回收。

> 狀態：v1.0.0。發布 Windows x64（NSIS）安裝包，由 GitHub Actions 在打 tag 時自動構建。

## 特色

- **台語專用模型**：`paulpengtw/faster-whisper-Breeze-ASR-26`（CT2 預轉換版），
  句級時間戳記，可選逐字時間戳記。
- **低顯存 / 無 GPU 皆可跑**：依顯存自動選擇 `int8_float16`（4GB 級 GPU 主力路徑）
  或純 CPU `int8`，決策表與上游一致；**不需要安裝 torch**。
- **零指令操作**：首次啟動自動準備 Python 環境（有系統 Python 3.10–3.13 就沿用；
  沒有則自動下載 SHA-256 釘定的 [python-build-standalone](https://github.com/astral-sh/python-build-standalone)）、
  建立 venv、安裝依賴、下載模型（約 2.9 GB，只此一次）。
- **常見影音格式全支援**：mp4 / mkv / mov / mp3 / m4a / wav / flac / ogg / webm…
  （透過 sidecar 自帶的 ffmpeg）。
- **模型常駐、批次轉錄**：多檔排隊，模型只載入一次；即時進度、逐句結果、取消任務。
- **隱私**：全程本機推理，sidecar 只監聽 loopback 並以隨機 token 鑑權，無雲端上傳。

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

## 專案結構

```
src/                     # 前端（Vanilla TypeScript + Vite）
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
.github/workflows/       # CI：sidecar 冒煙測試 + NSIS 構建；tag 發 Release
```

## 釘定的第三方版本

| 元件 | 版本 |
| --- | --- |
| breeze-asr-taigi | commit `59da766e9156fed409666d15c1879176baac1fa0`（見 `bootstrap.py`） |
| 模型 | `paulpengtw/faster-whisper-Breeze-ASR-26`（HuggingFace，首次啟動下載） |
| 後備 Python | python-build-standalone CPython 3.11.17 / tag `20261009`（SHA-256 釘定於 `python.rs`） |

## 致謝

- [MediaTek Research](https://huggingface.co/MediaTek-Research) — Breeze-ASR-26 官方模型
- [thc1006/breeze-asr-taigi](https://github.com/thc1006/breeze-asr-taigi) — 台語轉錄器與低顯存配置
- [paulpengtw](https://huggingface.co/paulpengtw) — CT2 預轉換模型
- [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)、
  [OpenAI Whisper](https://github.com/openai/whisper)
- [fendouai/deepseek-harness-desktop](https://github.com/fendouai/deepseek-harness-desktop)
  — Tauri 外殼 + 本機 sidecar 的架構原型

## 授權

本專案程式碼採 [MIT](LICENSE)。模型本身的授權以各 HuggingFace 模型頁面公告為準。
