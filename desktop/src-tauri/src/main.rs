#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_UPDATE_ENDPOINT: &str =
    "https://github.com/hw7622/nanobot-desktop/releases/latest/download/latest.json";
const DEFAULT_UPDATE_CHANNEL: &str = "stable";
const UPDATE_ENDPOINT_OVERRIDE: Option<&str> = option_env!("NANOBOT_DESKTOP_UPDATER_ENDPOINT");
const UPDATE_PUBKEY: Option<&str> = option_env!("NANOBOT_DESKTOP_UPDATER_PUBKEY");
const EMBEDDED_UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUxMUU1NTUzN0E1MzUwQzIKUldUQ1VGTjZVMVVlNGVyMUoxblIvZGovM0I4aE1XRFVQUE4xZ2dCUU0ydUxqSVplNmdnUXlaWWwK";
#[cfg(windows)]
const AUTO_LAUNCH_REG_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const AUTO_LAUNCH_REG_NAME: &str = "Nanobot Desktop";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const TRAY_ID: &str = "main-tray";
const TRAY_MENU_SHOW: &str = "tray-show";
const TRAY_MENU_QUIT: &str = "tray-quit";

struct BackendChild(Mutex<Option<Child>>);
struct PendingUpdate(Mutex<Option<Update>>);
struct ExitRequested(Mutex<bool>);

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
    Ok(build_update_status(
        &app,
        pending
            .0
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(update_payload)),
    ))
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
            pending
                .0
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(update_payload)),
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
        let mut slot = pending
            .0
            .lock()
            .map_err(|_| "无法锁定更新状态".to_string())?;
        slot.take()
    };

    let Some(update) = update else {
        return Err("当前没有可安装的更新，请先执行检查更新。".to_string());
    };

    stop_managed_backend(&app);

    update
        .download_and_install(|_chunk_length, _content_length| {}, || {})
        .await
        .map_err(|err| err.to_string())?;

    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        app_handle.exit(0);
    });

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

#[tauri::command]
fn handle_close_action(
    action: String,
    app: tauri::AppHandle,
    exit_requested: tauri::State<'_, ExitRequested>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "未找到主窗口".to_string())?;

    match action.as_str() {
        "minimize" => window.hide().map_err(|err| err.to_string())?,
        "exit" => {
            if let Ok(mut flag) = exit_requested.0.lock() {
                *flag = true;
            }
            request_backend_shutdown();
            window.close().map_err(|err| err.to_string())?;
        }
        "cancel" => {}
        _ => return Err("未知关闭操作".to_string()),
    }

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(BackendChild(Mutex::new(None)))
        .manage(PendingUpdate(Mutex::new(None)))
        .manage(ExitRequested(Mutex::new(false)))
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            setup_tray(app)?;

            if !cfg!(debug_assertions) {
                let resource_roots = candidate_resource_roots(app);
                let Some(backend_exe) =
                    find_packaged_exe(&resource_roots, "backend", "nanobot-desktop-backend")
                else {
                    return Ok(());
                };
                let runtime_exe = find_packaged_exe(&resource_roots, "runtime", "nanobot-runtime");

                let mut command = Command::new(&backend_exe);
                command.stdout(Stdio::null()).stderr(Stdio::null());
                #[cfg(windows)]
                command.creation_flags(CREATE_NO_WINDOW);
                command.env(
                    "NANOBOT_DESKTOP_VERSION",
                    app.package_info().version.to_string(),
                );
                if let Some(runtime_exe) = runtime_exe {
                    command.env("NANOBOT_DESKTOP_GATEWAY_BIN", runtime_exe);
                }

                let child = command.spawn().ok();
                {
                    let state = app.state::<BackendChild>();
                    if let Ok(mut slot) = state.0.lock() {
                        *slot = child;
                    };
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updater_status,
            check_for_updates,
            install_update,
            autostart_status,
            set_autostart,
            handle_close_action
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let exit_requested = window
                    .state::<ExitRequested>()
                    .0
                    .lock()
                    .map(|flag| *flag)
                    .unwrap_or(false);
                if !exit_requested {
                    api.prevent_close();
                    if let Some(webview) = window.app_handle().get_webview_window("main") {
                        let _ = webview.eval(close_prompt_script());
                    }
                }
            }
            tauri::WindowEvent::Destroyed => {
                request_backend_shutdown();
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
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Nanobot Desktop");
}

fn setup_tray<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let show_item = MenuItemBuilder::with_id(TRAY_MENU_SHOW, "显示主窗口").build(app)?;
    let quit_item = MenuItemBuilder::with_id(TRAY_MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &quit_item])
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Nanobot Desktop")
        .show_menu_on_left_click(false)
        .on_menu_event(
            |app: &tauri::AppHandle<R>, event| match event.id().as_ref() {
                TRAY_MENU_SHOW => {
                    let _ = show_main_window(app);
                }
                TRAY_MENU_QUIT => {
                    if let Ok(mut flag) = app.state::<ExitRequested>().0.lock() {
                        *flag = true;
                    }
                    request_backend_shutdown();
                    app.exit(0);
                }
                _ => {}
            },
        )
        .on_tray_icon_event(|tray: &tauri::tray::TrayIcon<R>, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                let _ = show_main_window(tray.app_handle());
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let _ = builder.build(app)?;
    Ok(())
}

fn show_main_window<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M) -> tauri::Result<()> {
    if let Some(window) = manager.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

fn request_backend_shutdown() {
    let mut addrs = match ("127.0.0.1", 18791).to_socket_addrs() {
        Ok(addrs) => addrs,
        Err(_) => return,
    };
    let Some(addr) = addrs.next() else {
        return;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(600)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let request = concat!(
        "POST /api/shutdown HTTP/1.1\r\n",
        "Host: 127.0.0.1:18791\r\n",
        "Connection: close\r\n",
        "Content-Length: 0\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return;
    }
    let mut buffer = [0_u8; 256];
    let _ = stream.read(&mut buffer);
}

fn stop_managed_backend(app: &tauri::AppHandle) {
    request_backend_shutdown();

    let state = app.state::<BackendChild>();
    let child = match state.0.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => None,
    };

    let Some(mut child) = child else {
        std::thread::sleep(Duration::from_millis(1200));
        return;
    };

    if wait_for_child_exit(&mut child, Duration::from_secs(6)) {
        return;
    }

    kill_process_tree(&child);
    let _ = child.kill();
    let _ = wait_for_child_exit(&mut child, Duration::from_secs(3));
    let _ = child.wait();
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(_) => return false,
        }
    }
}

#[cfg(windows)]
fn kill_process_tree(child: &Child) {
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let _ = command.status();
}

#[cfg(not(windows))]
fn kill_process_tree(_child: &Child) {}

fn close_prompt_script() -> &'static str {
    r#"
(() => {
  const existing = document.getElementById('__nanobotClosePrompt');
  if (existing) return;
  const wrap = document.createElement('div');
  wrap.id = '__nanobotClosePrompt';
  wrap.style.position = 'fixed';
  wrap.style.inset = '0';
  wrap.style.zIndex = '2147483647';
  wrap.style.display = 'grid';
  wrap.style.placeItems = 'center';
  wrap.style.padding = '24px';
  wrap.style.background = 'rgba(15, 23, 42, 0.34)';
  wrap.style.backdropFilter = 'blur(6px)';
  wrap.innerHTML = `
    <section style="width:min(460px,calc(100vw - 32px));display:grid;gap:12px;padding:24px;border:1px solid rgba(226,232,240,0.9);border-radius:24px;background:rgba(255,255,255,0.98);box-shadow:0 24px 60px rgba(15,23,42,0.2);font-family:'Microsoft YaHei UI',sans-serif;">
      <p style="margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;">窗口关闭</p>
      <h3 style="margin:0;font-size:24px;line-height:1.2;color:#0f172a;">选择“最小化”还是“关闭”</h3>
      <p style="margin:0;color:#475569;line-height:1.6;">最小化会继续在托盘后台运行；关闭会直接退出桌面端。</p>
      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:4px;">
        <button data-action="minimize" style="border:0;border-radius:999px;padding:10px 16px;background:#0f766e;color:#fff;font:inherit;cursor:pointer;">最小化</button>
        <button data-action="exit" style="border:1px solid #cbd5e1;border-radius:999px;padding:10px 16px;background:#fff;color:#0f172a;font:inherit;cursor:pointer;">关闭</button>
        <button data-action="cancel" style="border:1px solid #cbd5e1;border-radius:999px;padding:10px 16px;background:#fff;color:#64748b;font:inherit;cursor:pointer;">取消</button>
      </div>
    </section>
  `;
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (event) => {
    if (event.target === wrap) remove();
  });
  for (const button of wrap.querySelectorAll('[data-action]')) {
    button.addEventListener('click', async () => {
      const action = button.getAttribute('data-action');
      remove();
      try {
        if (window.__NANOBOT_SUBMIT_CLOSE_ACTION__) {
          await window.__NANOBOT_SUBMIT_CLOSE_ACTION__(action);
          return;
        }
        if (action === 'cancel') return;
        await window.__TAURI__?.core?.invoke?.('handle_close_action', { action });
      } catch (error) {
        alert(`关闭操作失败：${error?.message || error}`);
      }
    });
  }
  document.body.appendChild(wrap);
})();
"#
}

fn build_update_status(
    app: &tauri::AppHandle,
    pending: Option<UpdatePayload>,
) -> UpdateConfigPayload {
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
            "已配置更新签名，可手动检查 GitHub Release 中的新版本。".to_string()
        } else {
            "未找到更新签名公钥，当前无法检查更新。".to_string()
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
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
        pubkey: resolve_updater_pubkey(),
        channel: DEFAULT_UPDATE_CHANNEL.to_string(),
    }
}

fn resolve_updater_pubkey() -> Option<String> {
    if let Some(value) = UPDATE_PUBKEY {
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    if let Ok(value) = std::env::var("NANOBOT_DESKTOP_UPDATER_PUBKEY") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }

    let value = EMBEDDED_UPDATE_PUBKEY.trim();
    if !value.is_empty() {
        return Some(value.to_string());
    }

    None
}
