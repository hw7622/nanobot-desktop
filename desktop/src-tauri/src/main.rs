#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_UPDATE_ENDPOINT: &str = "https://github.com/hw7622/nanobot-desktop/releases/latest/download/latest.json";
const DEFAULT_UPDATE_CHANNEL: &str = "stable";
const UPDATE_ENDPOINT_OVERRIDE: Option<&str> = option_env!("NANOBOT_DESKTOP_UPDATER_ENDPOINT");
const UPDATE_PUBKEY: Option<&str> = option_env!("NANOBOT_DESKTOP_UPDATER_PUBKEY");
#[cfg(windows)]
const AUTO_LAUNCH_REG_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const AUTO_LAUNCH_REG_NAME: &str = "Nanobot Desktop";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct BackendChild(Mutex<Option<Child>>);
struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateConfigPayload {
    supported: bool,
    configured: bool,
    channel: String,
    endpoint: String,
    pubkey_configured: bool,
    current_version: String,
    pending: Option<UpdatePayload>,
    note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePayload {
    version: String,
    current_version: String,
    date: Option<String>,
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoLaunchPayload {
    supported: bool,
    enabled: bool,
    note: String,
}

#[tauri::command]
async fn updater_status(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<UpdateConfigPayload, String> {
    Ok(build_update_status(&app, pending.0.lock().ok().and_then(|slot| slot.as_ref().map(update_payload))))
}

#[tauri::command]
async fn check_for_updates(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<UpdateConfigPayload, String> {
    let settings = updater_settings();
    if settings.pubkey.is_none() {
        return Ok(build_update_status(
            &app,
            pending.0.lock().ok().and_then(|slot| slot.as_ref().map(update_payload)),
        ));
    }

    let endpoint = settings
        .endpoint
        .parse()
        .map_err(|err: url::ParseError| err.to_string())?;

    let mut builder = app.updater_builder();
    builder = builder
        .endpoints(vec![endpoint])
        .map_err(|err| err.to_string())?
        .pubkey(settings.pubkey.as_deref().unwrap());

    let update = builder
        .build()
        .map_err(|err| err.to_string())?
        .check()
        .await
        .map_err(|err| err.to_string())?;

    let update_payload = update.as_ref().map(update_payload);
    if let Ok(mut slot) = pending.0.lock() {
        *slot = update;
    }

    Ok(build_update_status(&app, update_payload))
}

#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<UpdateConfigPayload, String> {
    let update = {
        let mut slot = pending.0.lock().map_err(|_| "无法锁定更新状态".to_string())?;
        slot.take()
    };

    let Some(update) = update else {
        return Err("当前没有可安装的更新，请先执行检查更新。".to_string());
    };

    update
        .download_and_install(|_chunk_length, _content_length| {}, || {})
        .await
        .map_err(|err| err.to_string())?;

    Ok(build_update_status(&app, None))
}

#[tauri::command]
async fn autostart_status() -> Result<AutoLaunchPayload, String> {
    Ok(read_auto_launch_state())
}

#[tauri::command]
async fn set_autostart(enabled: bool) -> Result<AutoLaunchPayload, String> {
    write_auto_launch_state(enabled)?;
    Ok(read_auto_launch_state())
}

fn main() {
    tauri::Builder::default()
        .manage(BackendChild(Mutex::new(None)))
        .manage(PendingUpdate(Mutex::new(None)))
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            if cfg!(debug_assertions) {
                return Ok(());
            }

            let resource_roots = candidate_resource_roots(app);
            let Some(backend_exe) = find_packaged_exe(&resource_roots, "backend", "nanobot-desktop-backend") else {
                return Ok(());
            };
            let runtime_exe = find_packaged_exe(&resource_roots, "runtime", "nanobot-runtime");
            let app_data_dir = app.path().app_data_dir().ok();

            let mut command = Command::new(&backend_exe);
            command.stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            command.creation_flags(CREATE_NO_WINDOW);
            if let Some(dir) = app_data_dir {
                let _ = std::fs::create_dir_all(&dir);
                command.env("NANOBOT_DESKTOP_DATA_DIR", dir);
            }
            if let Some(runtime_exe) = runtime_exe {
                command.env("NANOBOT_DESKTOP_GATEWAY_BIN", runtime_exe);
            }

            let child = command.spawn().ok();
            let state = app.state::<BackendChild>();
            if let Ok(mut slot) = state.0.lock() {
                *slot = child;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updater_status,
            check_for_updates,
            install_update,
            autostart_status,
            set_autostart
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<BackendChild>();
                let mut slot = match state.0.lock() {
                    Ok(slot) => slot,
                    Err(_) => return,
                };
                if let Some(child) = slot.as_mut() {
                    let _ = child.kill();
                }
                *slot = None;
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Nanobot Desktop");
}

fn build_update_status(app: &tauri::AppHandle, pending: Option<UpdatePayload>) -> UpdateConfigPayload {
    let settings = updater_settings();
    UpdateConfigPayload {
        supported: true,
        configured: settings.pubkey.is_some(),
        channel: settings.channel,
        endpoint: settings.endpoint,
        pubkey_configured: settings.pubkey.is_some(),
        current_version: app.package_info().version.to_string(),
        pending,
        note: if settings.pubkey.is_some() {
            "更新源已配置，可检查 GitHub Release 中的新版本。".to_string()
        } else {
            "尚未配置 updater 公钥。先生成签名密钥并在构建时注入 NANOBOT_DESKTOP_UPDATER_PUBKEY，随后才能真正启用自动更新。".to_string()
        },
    }
}

fn update_payload(update: &Update) -> UpdatePayload {
    UpdatePayload {
        version: update.version.to_string(),
        current_version: update.current_version.to_string(),
        date: update.date.map(|date| date.to_string()),
        body: update.body.clone(),
    }
}

fn candidate_resource_roots<R: tauri::Runtime>(app: &tauri::App<R>) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_unique(&mut roots, resource_dir.clone());
        if let Some(parent) = resource_dir.parent() {
            push_unique(&mut roots, parent.to_path_buf());
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            push_unique(&mut roots, parent.to_path_buf());
        }
    }

    roots
}

fn find_packaged_exe(resource_roots: &[PathBuf], group: &str, base: &str) -> Option<PathBuf> {
    for root in resource_roots {
        let direct = root
            .join("dist")
            .join(group)
            .join(base)
            .join(exe_name(base));
        if direct.exists() {
            return Some(direct);
        }

        let nested = root
            .join("_up_")
            .join("dist")
            .join(group)
            .join(base)
            .join(exe_name(base));
        if nested.exists() {
            return Some(nested);
        }
    }

    None
}

fn push_unique(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !paths.iter().any(|path| path == &candidate) {
        paths.push(candidate);
    }
}

fn exe_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{}.exe", base)
    } else {
        base.to_string()
    }
}

#[cfg(windows)]
fn quoted_current_exe() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    Ok(format!("\"{}\"", exe.display()))
}

#[cfg(windows)]
fn run_reg_command(args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("reg");
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.creation_flags(CREATE_NO_WINDOW);
    command.output().map_err(|err| err.to_string())
}

#[cfg(windows)]
fn read_auto_launch_state() -> AutoLaunchPayload {
    let expected = quoted_current_exe().ok();
    match run_reg_command(&["query", AUTO_LAUNCH_REG_PATH, "/v", AUTO_LAUNCH_REG_NAME]) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let enabled = expected
                .as_ref()
                .map(|value| stdout.contains(value))
                .unwrap_or(true);
            AutoLaunchPayload {
                supported: true,
                enabled,
                note: if enabled {
                    "开机后会自动启动桌面程序。".to_string()
                } else {
                    "当前未启用开机自启动。".to_string()
                },
            }
        }
        _ => AutoLaunchPayload {
            supported: true,
            enabled: false,
            note: "当前未启用开机自启动。".to_string(),
        },
    }
}

#[cfg(not(windows))]
fn read_auto_launch_state() -> AutoLaunchPayload {
    AutoLaunchPayload {
        supported: false,
        enabled: false,
        note: "当前平台暂未接入开机自启动。".to_string(),
    }
}

#[cfg(windows)]
fn write_auto_launch_state(enabled: bool) -> Result<(), String> {
    if enabled {
        let value = quoted_current_exe()?;
        let output = run_reg_command(&[
            "add",
            AUTO_LAUNCH_REG_PATH,
            "/v",
            AUTO_LAUNCH_REG_NAME,
            "/t",
            "REG_SZ",
            "/d",
            value.as_str(),
            "/f",
        ])?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }

    let output = run_reg_command(&[
        "delete",
        AUTO_LAUNCH_REG_PATH,
        "/v",
        AUTO_LAUNCH_REG_NAME,
        "/f",
    ])?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("Unable to find") || stderr.contains("找不到") {
        return Ok(());
    }
    Err(stderr.trim().to_string())
}

#[cfg(not(windows))]
fn write_auto_launch_state(_enabled: bool) -> Result<(), String> {
    Err("当前平台暂不支持开机自启动设置。".to_string())
}

struct UpdaterSettings {
    endpoint: String,
    pubkey: Option<String>,
    channel: String,
}

fn updater_settings() -> UpdaterSettings {
    UpdaterSettings {
        endpoint: UPDATE_ENDPOINT_OVERRIDE
            .unwrap_or(DEFAULT_UPDATE_ENDPOINT)
            .to_string(),
        pubkey: UPDATE_PUBKEY.map(str::to_string).filter(|value| !value.trim().is_empty()),
        channel: DEFAULT_UPDATE_CHANNEL.to_string(),
    }
}
