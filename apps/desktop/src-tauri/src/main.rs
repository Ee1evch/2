//! DotLink для Windows: запускает ядро (сервер, обнаружение, управление ПК), показывает дашборд
//! и живёт в трее. Закрытие окна сворачивает в трей, ядро продолжает работать.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dotlink_core::Host;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

/// Ядро держим живым всё время работы приложения.
struct Core(#[allow(dead_code)] Mutex<dotlink_core::Running>);
struct DashUrl(String);

struct TauriHost(AppHandle);

impl dotlink_core::Host for TauriHost {
    fn autostart(&self) -> Option<bool> {
        self.0.autolaunch().is_enabled().ok()
    }
    fn set_autostart(&self, on: bool) -> anyhow::Result<()> {
        let a = self.0.autolaunch();
        let r = if on { a.enable() } else { a.disable() };
        r.map_err(|e| anyhow::anyhow!(e.to_string()))
    }
    fn notify(&self, title: &str, body: &str) {
        let _ = self.0.notification().builder().title(title).body(body).show();
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url = app.state::<DashUrl>().0.clone();
    let Ok(url) = url.parse() else { return };
    let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("DotLink")
        .inner_size(1180.0, 780.0)
        .min_inner_size(900.0, 620.0)
        .background_color(tauri::window::Color(9, 9, 10, 255))
        .build();
    if let Ok(w) = w {
        let _ = w.set_focus();
    }
}

fn main() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    let minimized = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        // второй запуск (ярлык, автозапуск) просто показывает окно уже работающего DotLink
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let host = Arc::new(TauriHost(handle.clone()));
            let running = tauri::async_runtime::block_on(dotlink_core::start(dotlink_core::Options { host: host.clone(), ..Default::default() }))?;
            // при первом запуске включаем автозапуск, если он включён в настройках
            if running.core.store.read().settings.autostart && host.autostart() == Some(false) {
                let _ = host.set_autostart(true);
                running.core.publish_config();
            }
            app.manage(DashUrl(running.admin_url.clone()));
            app.manage(Core(Mutex::new(running)));

            let open = MenuItem::with_id(app, "open", "Открыть DotLink", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
            let mut tray = TrayIconBuilder::with_id("dotlink").tooltip("DotLink — пульт для ПК").menu(&menu).show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, e| match e.id().as_ref() {
                "open" => show(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    show(tray.app_handle());
                }
            })
            .build(app)?;

            if !minimized {
                show(&handle);
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            // крестик прячет окно в трей — телефон остаётся на связи
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("не удалось запустить DotLink")
        .run(|_, e| {
            // окон нет, но приложение должно жить в трее
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = e {
                api.prevent_exit();
            }
        });
}
