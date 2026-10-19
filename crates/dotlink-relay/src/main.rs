//! dotlink-relay — ретранслятор для связи телефона и ПК из разных сетей.
//!
//! Запуск: `dotlink-relay --listen 0.0.0.0:47900`. TLS (wss://) — за обратным прокси
//! (Caddy, nginx); пример — docs/RELAY.md и deploy/relay/.

use dotlink_relay::{router, Limits};
use std::net::SocketAddr;

fn arg(name: &str) -> Option<String> {
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        if a == name {
            return it.next();
        }
        if let Some(v) = a.strip_prefix(&format!("{name}=")) {
            return Some(v.to_string());
        }
    }
    None
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    if std::env::args().any(|a| a == "--help" || a == "-h") {
        println!("dotlink-relay [--listen ADDR:PORT] [--max-rooms N] [--max-pipes N] [--rate-mbit N]");
        println!("  переменные окружения: DOTLINK_RELAY_LISTEN, PORT");
        return Ok(());
    }
    let listen: SocketAddr = arg("--listen")
        .or_else(|| std::env::var("DOTLINK_RELAY_LISTEN").ok())
        .or_else(|| std::env::var("PORT").ok().map(|p| format!("0.0.0.0:{p}")))
        .unwrap_or_else(|| "0.0.0.0:47900".into())
        .parse()?;
    let mut limits = Limits::default();
    if let Some(n) = arg("--max-rooms") {
        limits.max_rooms = n.parse()?;
    }
    if let Some(n) = arg("--max-pipes") {
        limits.max_pipes_per_room = n.parse()?;
    }
    if let Some(n) = arg("--rate-mbit") {
        limits.rate = n.parse::<u64>()? * 1_000_000 / 8;
    }
    let listener = tokio::net::TcpListener::bind(listen).await?;
    tracing::info!("ретранслятор DotLink слушает {}", listener.local_addr()?);
    axum::serve(listener, router(limits))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
