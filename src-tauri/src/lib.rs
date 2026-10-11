//! Taigi ASR Desktop — Tauri 2 host.
//!
//! 架構參考 deepseek-harness-desktop：Tauri 外殼只負責桌面整合（視窗、檔案
//! 對話框、生命週期），真正的轉錄能力由本機 Python sidecar 在
//! 127.0.0.1 隨機埠提供。Rust 端的職責：
//!
//! 1. 準備 Python 執行環境（系統 Python → 否則下載 python-build-standalone）；
//! 2. 建立 venv 並執行 bootstrap.py 安裝依賴與預載模型；
//! 3. 啟動 / 監管 sidecar 進程，等待 readiness，應用退出時回收整個進程樹；
//! 4. 把 sidecar URL + ephemeral token 交給前端。

mod jobobj;
mod python;
mod sidecar;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

static BOOTSTRAP_BUSY: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
struct BackendInfo {
    url: String,
    token: String,
}

/// 前端通過 `get_status` 與 `status-changed` 事件拿到的唯一狀態機。
#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum HostStatus {
    Preparing {
        phase: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        fraction: Option<f64>,
    },
    Ready {
        backend: BackendInfo,
    },
    Error {
        message: String,
    },
}

struct Shared {
    status: Mutex<HostStatus>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            status: Mutex::new(HostStatus::Preparing {
                phase: "init".into(),
                message: "啟動中…".into(),
                fraction: None,
            }),
        }
    }
}

impl Shared {
    fn set(&self, app: &AppHandle, status: HostStatus) {
        *self.status.lock().unwrap() = status.clone();
        let _ = app.emit("status-changed", status);
    }
}

/// 64 hex chars 的臨時 token。只監聽 loopback，token 用於防止本機其他行程
/// 與瀏覽器頁面未經授權呼叫 sidecar。
fn generate_token() -> String {
    use sha2::{Digest, Sha256};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = Sha256::new();
    h.update(std::process::id().to_le_bytes());
    h.update(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            .to_le_bytes(),
    );
    h.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    hex::encode(h.finalize())
}

fn prepare_and_launch(app: AppHandle) {
    let shared: State<Shared> = app.state();
    if let Err(err) = (|| -> Result<(), String> {
        let base = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("無法取得應用資料目錄：{e}"))?;
        std::fs::create_dir_all(base.join("logs")).ok();

        let resources = app
            .path()
            .resource_dir()
            .map_err(|e| format!("無法取得資源目錄：{e}"))?
            .join("resources");

        shared.set(
            &app,
            HostStatus::Preparing {
                phase: "python".into(),
                message: "檢查 Python 執行環境…".into(),
                fraction: None,
            },
        );
        let base_python = python::ensure_base_python(&app, &base)?;

        shared.set(
            &app,
            HostStatus::Preparing {
                phase: "venv".into(),
                message: "建立虛擬環境（首次啟動約需 1 分鐘）…".into(),
                fraction: None,
            },
        );
        python::ensure_venv(&base, &base_python)?;

        let gpu = python::detect_nvidia_gpu();
        python::ensure_dependencies(&app, &base, &resources, gpu)?;

        shared.set(
            &app,
            HostStatus::Preparing {
                phase: "launch".into(),
                message: "啟動台語辨識引擎…".into(),
                fraction: None,
            },
        );
        let token = generate_token();
        let port = sidecar::start(&app, &base, &resources, &token)?;

        shared.set(
            &app,
            HostStatus::Ready {
                backend: BackendInfo {
                    url: format!("http://127.0.0.1:{port}"),
                    token,
                },
            },
        );
        Ok(())
    })() {
        shared.set(&app, HostStatus::Error { message: err });
    }
}

#[tauri::command]
fn get_status(state: State<Shared>) -> HostStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn retry_setup(app: AppHandle) -> Result<(), String> {
    // 同時只允許一個引導流程。
    if BOOTSTRAP_BUSY.swap(1, Ordering::SeqCst) == 1 {
        return Err("環境準備已在進行中".into());
    }
    std::thread::spawn(move || {
        prepare_and_launch(app.clone());
        BOOTSTRAP_BUSY.store(0, Ordering::SeqCst);
    });
    Ok(())
}

/// 回傳 sidecar 日誌路徑，讓前端用 opener 外掛在檔案總管中顯示。
#[tauri::command]
fn log_file_path(app: AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("{e}"))?;
    Ok(base.join("logs").join("sidecar.log"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            retry_setup,
            log_file_path
        ])
        .manage(Shared::default())
        .setup(|app| {
            let app = app.handle().clone();
            BOOTSTRAP_BUSY.store(1, Ordering::SeqCst);
            std::thread::spawn(move || {
                prepare_and_launch(app.clone());
                BOOTSTRAP_BUSY.store(0, Ordering::SeqCst);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("啟動 Taigi ASR Desktop 失敗")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                sidecar::shutdown(app);
            }
        });
}
