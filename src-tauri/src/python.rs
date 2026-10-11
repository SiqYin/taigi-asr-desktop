//! Python 執行環境的準備：直譯器探測 / 獨立運行時下載 / venv / 依賴安裝。

use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::HostStatus;

/// python-build-standalone（CPython 3.11.17, 20261009, Windows x64）。
/// 當使用者本機沒有 Python 3.10+ 時的後備運行時，對應 harness-desktop
/// 捆綁 Node.js 的做法；SHA-256 在上游 release 的 SHA256SUMS 中釘定。
#[cfg(windows)]
const STANDALONE_PYTHON_URL: &str =
    "https://github.com/astral-sh/python-build-standalone/releases/download/20261009/\
cpython-3.11.17+20261009-x86_64-pc-windows-msvc-install_only.tar.gz";
#[cfg(windows)]
const STANDALONE_PYTHON_SHA256: &str =
    "4d307648d2fe5f8d927e10380cc33eb7afd8a34a7efe0ed786b5860b5f2d3408";

const MIN_MINOR: u32 = 10;
const MAX_MINOR: u32 = 13;

fn preparing(app: &AppHandle, phase: &str, message: impl Into<String>, fraction: Option<f64>) {
    let shared = app.state::<crate::Shared>();
    shared.set(
        app,
        HostStatus::Preparing {
            phase: phase.into(),
            message: message.into(),
            fraction,
        },
    );
}

/// Windows 下隱藏主控台視窗（CREATE_NO_WINDOW），避免引導時閃黑框。
#[cfg(windows)]
pub(crate) fn silent_cmd(cmd_path: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new(cmd_path);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
pub(crate) fn silent_cmd(cmd_path: &Path) -> Command {
    Command::new(cmd_path)
}

/// 執行 `python --version` 並解析版號。`prefix_args` 給 py launcher 用（-3）。
fn probe(cmd_path: &str, prefix_args: &[&str]) -> Option<(u32, u32)> {
    let out = silent_cmd(Path::new(cmd_path))
        .args(prefix_args)
        .arg("--version")
        .output()
        .ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let ver = text.lines().find_map(|line| {
        let line = line.trim();
        line.strip_prefix("Python ")
            .and_then(|s| s.split_whitespace().next())
            .map(str::to_string)
    })?;
    let mut parts = ver.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    if major == 3 && (MIN_MINOR..=MAX_MINOR).contains(&minor) {
        Some((major, minor))
    } else {
        None
    }
}

fn venv_python(base: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        base.join("venv").join("Scripts").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        base.join("venv").join("bin").join("python")
    }
}

fn standalone_python(base: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        base.join("python").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        base.join("python").join("bin").join("python3")
    }
}

/// 回傳一個可用的基底直譯器（用來建立 venv）。
pub fn ensure_base_python(app: &AppHandle, base: &Path) -> Result<PathBuf, String> {
    // 1) 先前已下載的獨立運行時。
    let bundled = standalone_python(base);
    if bundled.exists() && probe(&bundled.to_string_lossy(), &[]).is_some() {
        return Ok(bundled);
    }

    // 2) 系統 Python：py launcher → python3 → python。
    let candidates: &[(&str, &[&str])] = &[("py", &["-3"][..]), ("python3", &[]), ("python", &[])];
    for (exe, args) in candidates {
        if let Some(_ver) = probe(exe, args) {
            // py launcher 不能直接當作 venv 的解譯器路徑；用 `py -3 -m venv`
            // 建 venv 即可，這裡回傳一個描述用的假路徑，後續靠 invoke() 分流。
            return Ok(PathBuf::from(exe));
        }
    }

    // 3) 下載獨立運行時（Windows）。
    #[cfg(windows)]
    {
        download_standalone(app, base)?;
        if probe(&bundled.to_string_lossy(), &[]).is_some() {
            return Ok(bundled);
        }
        return Err("下載的 Python 運行時無法執行".into());
    }
    #[cfg(not(windows))]
    {
        let _ = bundled;
        Err(
            "找不到 Python 3.10–3.13。請安裝 Python（建議 3.11）後重試：https://www.python.org/downloads/"
                .into(),
        )
    }
}

#[cfg(windows)]
fn download_standalone(app: &AppHandle, base: &Path) -> Result<(), String> {
    let pyroot = base.join("python");
    std::fs::create_dir_all(&pyroot).map_err(|e| e.to_string())?;
    let archive_file = base.join("python-runtime.tar.gz");

    preparing(
        app,
        "python",
        "下載獨立 Python 運行時（約 25 MB）…",
        Some(0.0),
    );

    let resp = ureq::get(STANDALONE_PYTHON_URL)
        .timeout(Duration::from_secs(300))
        .call()
        .map_err(|e| format!("下載 Python 失敗：{e}"))?;
    let total = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok());
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&archive_file).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        downloaded += n as u64;
        if let Some(total) = total {
            let frac = downloaded as f64 / total as f64;
            if (downloaded / (512 * 1024)) as u64 != ((downloaded - n as u64) / (512 * 1024)) as u64 {
                preparing(app, "python", "下載獨立 Python 運行時…", Some(frac.clamp(0.0, 1.0)));
            }
        }
    }
    drop(file);

    let digest = hex::encode(hasher.finalize());
    if !digest.eq_ignore_ascii_case(STANDALONE_PYTHON_SHA256) {
        let _ = std::fs::remove_file(&archive_file);
        return Err(format!(
            "Python 運行時校驗失敗（SHA-256 不符），請重試。\n預期：{STANDALONE_PYTHON_SHA256}\n實際：{digest}"
        ));
    }

    preparing(app, "python", "解壓 Python 運行時…", None);
    let tar_gz = std::fs::File::open(&archive_file).map_err(|e| e.to_string())?;
    let decoder = flate2::read::GzDecoder::new(tar_gz);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let rel = entry.path().map_err(|e| e.to_string())?.into_owned();
        use std::path::Component;
        if rel.components().any(|c| {
            matches!(
                c,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        }) {
            return Err("Python 壓縮檔包含非法路徑".into());
        }
        entry.unpack_in(base).map_err(|e| e.to_string())?;
    }
    std::fs::remove_file(&archive_file).ok();
    Ok(())
}

/// 用基底直譯器建 venv。py launcher 的情形用 `py -3 -m venv`。
pub fn ensure_venv(base: &Path, base_python: &Path) -> Result<(), String> {
    let venv_py = venv_python(base);
    if venv_py.exists() {
        return Ok(());
    }
    let exe = base_python.to_string_lossy().to_string();
    let mut cmd = if exe == "py" {
        let mut c = silent_cmd(Path::new("py"));
        c.arg("-3");
        c
    } else {
        silent_cmd(base_python)
    };
    cmd.arg("-m").arg("venv").arg(base.join("venv"));
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("無法啟動 Python 建立虛擬環境：{e}"))?;
    if !out.status.success() {
        return Err(format!(
            "建立虛擬環境失敗：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    if !venv_py.exists() {
        return Err("虛擬環境建立後找不到 python 執行檔".into());
    }
    Ok(())
}

/// 粗查是否有 NVIDIA GPU；真正的可用性（CUDA / cuDNN）由 sidecar 驗證。
pub fn detect_nvidia_gpu() -> bool {
    #[cfg(windows)]
    let mut cmd = silent_cmd(Path::new("nvidia-smi"));
    #[cfg(not(windows))]
    let mut cmd = Command::new("nvidia-smi");
    cmd.arg("--query-gpu=name")
        .arg("--format=csv,noheader")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    matches!(cmd.output(), Ok(o) if o.status.success() && !o.stdout.is_empty())
}

fn fingerprint(resources: &Path, gpu: bool) -> Result<String, String> {
    let mut h = Sha256::new();
    for name in ["bootstrap.py", "requirements.txt", "requirements-gpu.txt"] {
        let data = std::fs::read(resources.join(name)).map_err(|e| format!("讀取 {name} 失敗：{e}"))?;
        h.update(name.as_bytes());
        h.update(&(data.len() as u64).to_le_bytes());
        h.update(&data);
    }
    h.update([u8::from(gpu)]);
    Ok(hex::encode(h.finalize()))
}

/// 依賴就緒檢查：以資源檔雜湊 + GPU 旗標作為指紋，變更才重跑 bootstrap。
pub fn ensure_dependencies(
    app: &AppHandle,
    base: &Path,
    resources: &Path,
    gpu: bool,
) -> Result<(), String> {
    let fp = fingerprint(resources, gpu)?;
    let marker = base.join("install.json");
    if let Ok(data) = std::fs::read_to_string(&marker) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
            if v.get("fingerprint").and_then(|x| x.as_str()) == Some(&fp) {
                return Ok(());
            }
        }
    }

    let venv_py = venv_python(base);
    let bootstrap = resources.join("bootstrap.py");
    let req = resources.join("requirements.txt");
    let gpu_req = resources.join("requirements-gpu.txt");

    let mut cmd = silent_cmd(&venv_py);
    cmd.arg(&bootstrap)
        .arg("--base")
        .arg(base)
        .arg("--requirements")
        .arg(&req)
        .arg("--gpu-requirements")
        .arg(&gpu_req)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .env("PIP_NO_INPUT", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if gpu {
        cmd.arg("--gpu");
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("無法啟動環境安裝程式：{e}"))?;
    let stdout = child.stdout.take().ok_or("無法取得安裝程式輸出")?;
    let reader = std::io::BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        // bootstrap.py 輸出 JSON Lines；非 JSON 行當一般日誌顯示。
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            let phase = v
                .get("phase")
                .and_then(|x| x.as_str())
                .unwrap_or("deps")
                .to_string();
            let message = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let fraction = v.get("fraction").and_then(|x| x.as_f64());
            preparing(app, &phase, message, fraction);
        } else {
            let short: String = line.chars().take(200).collect();
            if !short.trim().is_empty() {
                preparing(app, "deps", short, None);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "環境安裝失敗（結束代碼 {}）。日誌：{}",
            status.code().unwrap_or(-1),
            base.join("logs").join("bootstrap.log").display()
        ));
    }

    std::fs::write(
        &marker,
        json!({ "fingerprint": fp, "gpu": gpu })
            .to_string(),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}


