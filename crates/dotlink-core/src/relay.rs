//! Клиент ретранслятора (crates/dotlink-relay): ПК держит свою комнату открытой и на каждый приход
//! телефона открывает отдельную трубу. Дальше по трубе идёт обычная сессия — тот же вход по ключу
//! и то же шифрование, ретранслятор видит только шифр. Адрес задаётся в настройках дашборда;
//! смена адреса применяется сразу.

use crate::core::Core;
use crate::transport::{self, Via};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

/// `wss://host[:port][/путь]` из того, что ввёл человек: `relay.example.com`, `https://…`, `ws://…`.
pub fn ws_base(input: &str) -> String {
    let s = input.trim().trim_end_matches('/');
    let s = if let Some(r) = s.strip_prefix("https://") {
        format!("wss://{r}")
    } else if let Some(r) = s.strip_prefix("http://") {
        format!("ws://{r}")
    } else if s.starts_with("wss://") || s.starts_with("ws://") {
        s.to_string()
    } else {
        format!("wss://{s}")
    };
    s.trim_end_matches('/').to_string()
}

fn status(core: &Core, state: &str, url: &str, msg: Option<String>) {
    core.hub.set("relay", json!({ "state": state, "url": url, "msg": msg, "room": core.store.read().room() }));
}

pub fn start(core: Arc<Core>) {
    tokio::spawn(async move {
        let mut rx = core.settings_tx.subscribe();
        let mut backoff = 1u64;
        loop {
            let url = rx.borrow_and_update().relay_url.trim().to_string();
            if url.is_empty() {
                status(&core, "off", "", None);
                if rx.changed().await.is_err() {
                    return;
                }
                continue;
            }
            status(&core, "connecting", &url, None);
            tokio::select! {
                r = room(&core, &url) => {
                    let msg = match r { Ok(()) => "соединение закрыто".to_string(), Err(e) => format!("{e:#}") };
                    tracing::warn!("ретранслятор {url}: {msg}");
                    status(&core, "error", &url, Some(msg));
                    // повтор с нарастающей паузой; новые настройки — сразу
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
                        r = rx.changed() => if r.is_err() { return },
                    }
                    backoff = (backoff * 2).min(30);
                }
                r = rx.changed() => if r.is_err() { return },
            }
        }
    });
}

async fn room(core: &Arc<Core>, url: &str) -> anyhow::Result<()> {
    let base = ws_base(url);
    let (room, secret) = {
        let c = core.store.read();
        (c.room(), c.room_secret.clone())
    };
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(format!("{base}/v1/pc/{room}?secret={secret}"))).await??;
    status(core, "online", url, None);
    tracing::info!("ретранслятор {url}: комната открыта");
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    loop {
        tokio::select! {
            m = ws.next() => {
                let m = match m { Some(Ok(m)) => m, Some(Err(e)) => return Err(e.into()), None => return Ok(()) };
                if let Message::Text(t) = m {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap_or_default();
                    if v["t"] == "incoming" {
                        if let Some(sid) = v["sid"].as_str() {
                            let (core, url) = (core.clone(), format!("{base}/v1/pc/{room}/{sid}?secret={secret}"));
                            let host = base.split("://").nth(1).unwrap_or(&base).split('/').next().unwrap_or("").to_string();
                            tokio::spawn(async move {
                                match tokio_tungstenite::connect_async(url).await {
                                    Ok((pipe, _)) => crate::session::run(core, transport::from_tungstenite(pipe, Via::Relay, format!("через {host}"))).await,
                                    Err(e) => tracing::warn!("труба ретранслятора: {e}"),
                                }
                            });
                        }
                    }
                }
            }
            _ = ping.tick() => ws.send(Message::Ping(Vec::new().into())).await?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_relay_address() {
        assert_eq!(ws_base("relay.example.com"), "wss://relay.example.com");
        assert_eq!(ws_base("https://relay.example.com/"), "wss://relay.example.com");
        assert_eq!(ws_base("http://10.0.0.2:47900"), "ws://10.0.0.2:47900");
        assert_eq!(ws_base(" ws://r:1/base/ "), "ws://r:1/base");
    }
}
