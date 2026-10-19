//! DotLink — управление Windows-ПК с телефона по локальной сети, без интернета.

pub mod core;
pub mod crypto;
pub mod discovery;
pub mod files;
pub mod hub;
pub mod motion;
pub mod net;
pub mod pairing;
pub mod platform;
pub mod proto;
pub mod rtc;
pub mod server;
pub mod session;
pub mod store;
pub mod transport;
pub mod util;

pub use crate::core::{Core, Host, NoHost};

use axum::serve::ListenerExt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::net::TcpListener;

pub struct Options {
    /// None — настройки только в памяти
    pub data_dir: Option<PathBuf>,
    /// None — порт из настроек (47800); 0 — любой свободный
    pub port: Option<u16>,
    pub bind: IpAddr,
    pub platform: Arc<dyn platform::Platform>,
    pub host: Arc<dyn Host>,
    pub discovery: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            data_dir: default_data_dir(),
            port: None,
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            platform: platform::native(),
            host: Arc::new(NoHost),
            discovery: true,
        }
    }
}

/// %APPDATA%\DotLink на Windows, ~/.config/dotlink на Linux.
pub fn default_data_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(if cfg!(windows) { "DotLink" } else { "dotlink" }))
}

pub struct Running {
    pub core: Arc<Core>,
    pub addr: SocketAddr,
    /// адрес дашборда с токеном администратора (только для 127.0.0.1)
    pub admin_url: String,
    _discovery: Option<discovery::Discovery>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Running {
    pub fn stop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn bind(ip: IpAddr, port: u16, fixed: bool) -> anyhow::Result<TcpListener> {
    let tries = if fixed || port == 0 { 1 } else { 10 };
    let mut last = None;
    for p in port..port.saturating_add(tries) {
        match TcpListener::bind((ip, p)).await {
            Ok(l) => return Ok(l),
            Err(e) => last = Some(e),
        }
    }
    Err(anyhow::anyhow!("порт {port} занят: {}", last.map(|e| e.to_string()).unwrap_or_default()))
}

/// Запуск ядра: сервер, наблюдатели ОС, обнаружение.
pub async fn start(opts: Options) -> anyhow::Result<Running> {
    let store = store::Store::open(opts.data_dir.as_deref())?;
    let want = opts.port.unwrap_or(store.read().settings.port);
    let listener = bind(opts.bind, want, opts.port.is_some()).await?;
    let addr = listener.local_addr()?;
    let token = util::b64url(&crypto::random::<24>());
    let core = Arc::new(Core::new(store, opts.platform.clone(), opts.host.clone(), token.clone(), opts.data_dir.clone()));
    core.port.store(addr.port(), Ordering::Relaxed);

    // события ОС → хаб
    let (etx, erx) = std::sync::mpsc::channel();
    {
        let core = core.clone();
        std::thread::Builder::new().name("dotlink-events".into()).spawn(move || {
            for ev in erx {
                core.handle_event(ev);
            }
        })?;
    }
    core.publish_all();
    opts.platform.start(etx);
    core.clone().sys_loop();

    // адреса и QR обновляются сами: сменилась сеть или истёк PIN
    {
        let core = core.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                t.tick().await;
                core.publish_net();
                core.publish_pairing();
                core.publish_routes();
            }
        });
    }

    let disc = if opts.discovery {
        let c = core.clone();
        let (id, name) = {
            let s = core.store.read();
            (s.pc_id.clone(), s.pc_name.clone())
        };
        Some(discovery::start(move || json_info(&c), &id, &name, addr.port()).await)
    } else {
        None
    };

    let app = server::router(core.clone());
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let listener = listener.tap_io(|s| {
        let _ = s.set_nodelay(true);
    });
    tokio::spawn(async move {
        let r = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await;
        if let Err(e) = r {
            tracing::error!("сервер остановлен: {e}");
        }
    });
    let admin_url = format!("http://127.0.0.1:{}/dashboard/#admin={}", addr.port(), token);
    tracing::info!("DotLink слушает {addr} (платформа: {})", opts.platform.name());
    Ok(Running { core, addr, admin_url, _discovery: disc, stop: Some(stop_tx) })
}

fn json_info(core: &Core) -> serde_json::Value {
    let mut v = core.pc_info();
    v["t"] = serde_json::json!("dotlink");
    v["port"] = serde_json::json!(core.port());
    v["addrs"] = serde_json::json!(net::addrs().into_iter().map(|a| a.ip).collect::<Vec<_>>());
    v
}
