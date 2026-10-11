//! Python sidecar 進程的啟動、就緒探測與生命週期回收。

use std::fs::OpenOptions;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::AppHandle;

const READY_PREFIX: &str = "TAIGI_SIDECAR_READY ";

static SIDECAR: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Child>> {
    SIDECAR.get_or_init(|| Mutex::new(None))
}

#[cfg(windows)]
fn sidecar_cmd(exe: &Path) -> std::process::Command {
    crate::python::silent_cmd(exe)
}

#[cfg(not(windows))]
fn sidecar_cmd(exe: &Path) -> std::process::Command {
    std::process::Command::new(exe)
}

pub fn start(
    app: &AppHandle,
    base: &Path,
    resources: &Path,
    token: &str,
) -> Result<u16, String> {
    let venv_python = base
        .join(if cfg!(windows) { "venv/Scripts/python.exe" } else { "venv/bin/python" });
    if !venv_python.exists() {
        return Err(format!("找不到虛擬環境 Python：{}", venv_python.display()));
    }

    let log_dir = base.join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    let log_path = log_dir.join("sidecar.log");

    let sidecar_src = resources.join("sidecar");
    let model_cache = base.join("models");
    std::fs::create_dir_all(&model_cache).ok();

    // 既有殘留進程先清掉。
    shutdown(app);

    let mut cmd = sidecar_cmd(&venv_python);
    cmd.arg("-m")
        .arg("taigi_sidecar")
        .arg("--base")
        .arg(base)
        .current_dir(base)
        .env("PYTHONPATH", &sidecar_src)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("TAIGI_SIDECAR_TOKEN", token)
        .env("HF_HOME", &model_cache)
        // 避免 HuggingFace 把遙測寫入使用者主目錄。
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("啟動 sidecar 失敗：{e}"))?;

    // Windows：放進 kill-on-close Job Object，App 退出時整個進程樹
    // （Python、ffmpeg）連帶結束，不會留下孤兒程序。
    #[cfg(windows)]
    crate::jobobj::assign_kill_on_close(&child);

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<u16>();
    if let Some(stdout) = child.stdout.take() {
        let log_path = log_path.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                append_log(&log_path, &line);
                if let Some(payload) = line.strip_prefix(READY_PREFIX) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload.trim()) {
                        if let Some(port) = v.get("port").and_then(|p| p.as_u64()) {
                            let _ = ready_tx.send(port as u16);
                        }
                    }
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                append_log(&log_path, &line);
            }
        });
    }

    let port = ready_rx
        .recv_timeout(Duration::from_secs(120))
        .map_err(|_| {
            shutdown(app);
            "sidecar 在 120 秒內未回報就緒，詳見 logs/sidecar.log".to_string()
        })?;

    // ready 訊號之後再做幾次健康檢查（uvicorn socket 已開但路由可能還沒熱）。
    let health_url = format!("http://127.0.0.1:{port}/health");
    let mut ok = false;
    for _ in 0..30 {
        if ureq::get(&health_url)
            .set("X-Taigi-Token", token)
            .timeout(Duration::from_secs(2))
            .call()
            .is_ok()
        {
            ok = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if !ok {
        shutdown(app);
        return Err("sidecar 已啟動但健康檢查失敗，詳見 logs/sidecar.log".into());
    }

    *slot().lock().unwrap() = Some(child);
    Ok(port)
}

fn append_log(path: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// 停止 sidecar。Windows 下 Job Object 也會在行程退出時自動回收子進程。
pub fn shutdown(_app: &AppHandle) {
    let child = slot().lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// 避免未使用警告（PathBuf 在非 Windows 設定中保留）。
#[allow(dead_code)]
fn _assert_pathbuf(_: PathBuf) {}
