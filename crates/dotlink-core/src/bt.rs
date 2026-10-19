//! Bluetooth: телефон подключается к ПК без Wi-Fi и интернета (RFCOMM). Платформа объявляет службу
//! и отдаёт входящие соединения потоком байтов; здесь они превращаются в обычную сессию — тот же вход
//! по ключу устройства и то же шифрование, кадры по transport::from_stream.
//! Адрес адаптера уходит телефонам в маршрутах и в QR — так телефон знает, куда звонить.

use crate::core::Core;
use crate::platform::{BtAccept, BtConn};
use crate::transport::{self, Via};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub fn start(core: Arc<Core>) {
    tokio::spawn(async move {
        let mut rx = core.settings_tx.subscribe();
        loop {
            let on = rx.borrow_and_update().bluetooth;
            let rt = tokio::runtime::Handle::current();
            let c = core.clone();
            let accept: BtAccept = Arc::new(move |conn| {
                let c = c.clone();
                rt.spawn(serve(c, conn));
            });
            let p = core.platform.clone();
            let r = tokio::task::spawn_blocking(move || p.bluetooth(on, accept)).await;
            let (state, retry) = match r {
                Ok(Ok(Some(addr))) => (json!({ "state": "online", "addr": addr }), false),
                Ok(Ok(None)) if on => (json!({ "state": "unavailable", "msg": "Bluetooth на этом ПК не найден" }), true),
                Ok(Ok(None)) => (json!({ "state": "off" }), false),
                Ok(Err(e)) => (json!({ "state": "error", "msg": format!("Bluetooth: {e:#}") }), true),
                Err(_) => (json!({ "state": "error", "msg": "Bluetooth: сбой" }), true),
            };
            core.hub.set("bt", state);
            core.publish_routes();
            core.publish_pairing();
            // адаптер могут включить позже — пробуем снова раз в 30 секунд
            tokio::select! {
                r = rx.changed() => if r.is_err() { return },
                _ = tokio::time::sleep(Duration::from_secs(30)), if retry => {}
            }
        }
    });
}

/// Адрес адаптера, если служба Bluetooth работает.
pub fn address(core: &Core) -> Option<String> {
    let v = core.hub.get("bt")?;
    (v["state"] == "online").then(|| v["addr"].as_str().map(String::from)).flatten()
}

/// Блокирующий поток RFCOMM ↔ асинхронная труба сессии.
async fn serve(core: Arc<Core>, conn: BtConn) {
    let BtConn { peer, mut read, mut write } = conn;
    tracing::info!("Bluetooth: подключение {peer}");
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let (tr, tw) = tokio::io::split(theirs);
    let (mut or, mut ow) = tokio::io::split(ours);
    let rt = tokio::runtime::Handle::current();
    // приём: Bluetooth → сессия
    std::thread::Builder::new()
        .name("dotlink-bt-rx".into())
        .spawn(move || {
            let mut buf = vec![0u8; 1 << 16];
            loop {
                match read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if rt.block_on(ow.write_all(&buf[..n])).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = rt.block_on(ow.shutdown());
        })
        .ok();
    // отправка: сессия → Bluetooth
    let rt = tokio::runtime::Handle::current();
    std::thread::Builder::new()
        .name("dotlink-bt-tx".into())
        .spawn(move || {
            let mut buf = vec![0u8; 1 << 16];
            loop {
                match rt.block_on(or.read(&mut buf)) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if write(&buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .ok();
    crate::session::run(core, transport::from_stream(tr, tw, Via::Bt, format!("Bluetooth · {peer}"))).await;
}
