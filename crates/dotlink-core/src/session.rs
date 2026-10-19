//! Сессия WebSocket: вход (сопряжение или вызов-ответ), затем ввод → ОС и состояние → телефон.
//! Ввод обрабатывается прямо в задаче сессии: расшифровка + SendInput занимают микросекунды.

use crate::core::{Core, Out, SessionInfo};
use crate::crypto::{self, Channel, PairKeys};
use crate::hub::ADMIN_ONLY;
use crate::pairing::Kind;
use crate::proto::{self, Frame, RemoteCmd};
use crate::store::Perms;
use crate::util::{b64, unb64, unb64_arr};
use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

enum Role {
    Admin,
    Remote { device: String, name: String, perms: Perms, chan: Channel },
}

struct Tx {
    sink: SplitSink<WebSocket, Message>,
    chan: Option<Channel>,
}

impl Tx {
    async fn json(&mut self, v: &Value) -> Result<(), axum::Error> {
        let bytes = serde_json::to_vec(v).unwrap_or_default();
        match &mut self.chan {
            Some(c) => self.sink.send(Message::Binary(c.seal(&bytes).into())).await,
            None => self.sink.send(Message::Text(String::from_utf8(bytes).unwrap_or_default().into())).await,
        }
    }
    async fn bin(&mut self, b: &[u8]) -> Result<(), axum::Error> {
        let data = match &mut self.chan {
            Some(c) => c.seal(b),
            None => b.to_vec(),
        };
        self.sink.send(Message::Binary(data.into())).await
    }
}

async fn recv_json(stream: &mut SplitStream<WebSocket>) -> Option<Value> {
    loop {
        match stream.next().await? {
            Ok(Message::Text(t)) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

async fn fail(tx: &mut Tx, code: &str) -> Option<Role> {
    let _ = tx.json(&json!({ "t": "error", "code": code })).await;
    None
}

async fn handshake(core: &Arc<Core>, tx: &mut Tx, rx: &mut SplitStream<WebSocket>, addr: SocketAddr) -> Option<Role> {
    let hello = recv_json(rx).await?;
    if hello["t"] != "hello" {
        return fail(tx, "protocol").await;
    }
    let pc = core.pc_info();
    if hello["role"] == "admin" {
        let token = hello["token"].as_str().unwrap_or("");
        if !addr.ip().is_loopback() || !crypto::ct_eq(token.as_bytes(), core.admin_token.as_bytes()) {
            return fail(tx, "forbidden").await;
        }
        tx.json(&json!({ "t": "welcome", "admin": true, "pc": pc })).await.ok()?;
        return Some(Role::Admin);
    }

    let Some(nonce_c) = hello["nonce"].as_str().and_then(unb64_arr::<16>) else { return fail(tx, "protocol").await };
    let nonce_s = crypto::random::<16>();
    let name: String = hello["name"].as_str().unwrap_or("Телефон").trim().chars().take(40).collect();

    if let Some(mode) = hello["pair"].as_str() {
        // ───── сопряжение ─────
        let kind = if mode == "pin" { Kind::Pin } else { Kind::Qr };
        let Some(pub_c) = hello["pub"].as_str().and_then(unb64_arr::<32>) else { return fail(tx, "protocol").await };
        if core.pairing.candidates(kind).is_empty() {
            return fail(tx, "expired").await;
        }
        let keys = PairKeys::generate();
        tx.json(&json!({ "t": "pair-challenge", "pub": b64(&keys.public), "nonce": b64(&nonce_s), "pc": pc })).await.ok()?;
        let proof = recv_json(rx).await?;
        let mac = proof["mac"].as_str().and_then(unb64).unwrap_or_default();
        let z = keys.shared(&pub_c);
        let t = crypto::pair_transcript(&pub_c, &keys.public, &nonce_c, &nonce_s);
        let secret = core.pairing.candidates(kind).into_iter().find(|s| crypto::ct_eq(&crypto::pair_mac(s, b"c", &t, &z), &mac));
        let Some(secret) = secret else {
            if kind == Kind::Pin {
                core.pairing.pin_failed();
                core.publish_pairing();
            }
            return fail(tx, if kind == Kind::Pin { "bad-pin" } else { "bad-secret" }).await;
        };
        core.pairing.consume();
        core.publish_pairing();
        let dk = crypto::device_key(&z, &secret, &t);
        let dev = core.add_device(if name.is_empty() { "Телефон" } else { &name }, &dk);
        tx.json(&json!({ "t": "paired", "device": dev.id, "mac": b64(&crypto::pair_mac(&secret, b"s", &t, &z)), "pc": pc, "perms": dev.perms })).await.ok()?;
        return Some(Role::Remote { device: dev.id, name: dev.name, perms: dev.perms, chan: Channel::new(&dk, &nonce_c, &nonce_s, true) });
    }

    // ───── вход известного устройства ─────
    let Some(dev) = hello["device"].as_str().and_then(|id| core.store.device(id)) else { return fail(tx, "unknown-device").await };
    let Some(dk) = unb64_arr::<32>(&dev.key) else { return fail(tx, "unknown-device").await };
    tx.json(&json!({ "t": "challenge", "nonce": b64(&nonce_s), "pc": pc })).await.ok()?;
    let auth = recv_json(rx).await?;
    let mac = auth["mac"].as_str().and_then(unb64).unwrap_or_default();
    if !crypto::ct_eq(&mac, &crypto::auth_mac(&dk, b"c", &nonce_c, &nonce_s)) {
        return fail(tx, "bad-auth").await;
    }
    tx.json(&json!({ "t": "welcome", "device": dev.id, "mac": b64(&crypto::auth_mac(&dk, b"s", &nonce_c, &nonce_s)), "pc": pc, "perms": dev.perms }))
        .await
        .ok()?;
    Some(Role::Remote { device: dev.id, name: dev.name, perms: dev.perms, chan: Channel::new(&dk, &nonce_c, &nonce_s, true) })
}

fn visible(key: &str, admin: bool, perms: &Perms) -> bool {
    admin || (!ADMIN_ONLY.contains(&key) && (key != "clip" || perms.clipboard))
}

/// Накопитель долей пикселя: телефон шлёт четверти пикселя, ОС принимает целые.
#[derive(Default)]
struct SubPixel {
    x: i32,
    y: i32,
}

impl SubPixel {
    fn take(&mut self, dx: i16, dy: i16) -> (i32, i32) {
        self.x += dx as i32;
        self.y += dy as i32;
        let (px, py) = (self.x / 4, self.y / 4);
        self.x -= px * 4;
        self.y -= py * 4;
        (px, py)
    }
}

pub async fn run(core: Arc<Core>, ws: WebSocket, addr: SocketAddr) {
    let (sink, mut rx) = ws.split();
    let mut tx = Tx { sink, chan: None };
    let role = match tokio::time::timeout(Duration::from_secs(20), handshake(&core, &mut tx, &mut rx, addr)).await {
        Ok(Some(r)) => r,
        _ => {
            let _ = tx.sink.close().await;
            return;
        }
    };
    let (admin, device, mut perms) = match role {
        Role::Admin => (true, None, Perms::default()),
        Role::Remote { device, name, perms, chan } => {
            tracing::info!("подключено устройство «{name}» с {addr}");
            tx.chan = Some(chan);
            (false, Some(device), perms)
        }
    };

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
    let rtt = Arc::new(AtomicU32::new(0));
    let sid = core.register(SessionInfo { device: device.clone(), name: String::new(), addr, since: crate::util::now_ms(), rtt: rtt.clone(), tx: out_tx });

    // подписка до снимка: ни одно изменение не потеряется
    let mut hub_rx = core.hub.subscribe();
    let mut ok = send_snapshot(&core, &mut tx, admin, &perms).await;
    let mut sub = SubPixel::default();
    let mut last_rtt_publish = 0u32;

    while ok {
        tokio::select! {
            m = rx.next() => {
                let Some(Ok(m)) = m else { break };
                match m {
                    Message::Binary(b) => {
                        let plain = match &mut tx.chan {
                            Some(c) => match c.open(&b) { Some(p) => p, None => { tracing::warn!("отброшен кадр с неверной подписью от {addr}"); continue } },
                            None => b.to_vec(),
                        };
                        let Ok(frame) = proto::decode(&plain) else { continue };
                        ok = handle_frame(&core, &mut tx, frame, admin, device.as_deref(), &perms, &mut sub, &rtt, &mut last_rtt_publish).await;
                    }
                    Message::Text(t) if admin => {
                        if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                            let reply = core.admin_cmd(&v);
                            ok = tx.json(&reply).await.is_ok();
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            u = hub_rx.recv() => match u {
                Ok((k, v)) => if visible(k, admin, &perms) {
                    ok = tx.json(&json!({ "t": "state", "k": k, "v": *v })).await.is_ok();
                },
                Err(broadcast::error::RecvError::Lagged(_)) => ok = send_snapshot(&core, &mut tx, admin, &perms).await,
                Err(_) => break,
            },
            o = out_rx.recv() => match o {
                Some(Out::Json(v)) => ok = tx.json(&v).await.is_ok(),
                Some(Out::Perms(p)) => {
                    perms = p;
                    ok = tx.json(&json!({ "t": "perms", "v": perms })).await.is_ok() && send_snapshot(&core, &mut tx, admin, &perms).await;
                }
                Some(Out::Close(code)) => { let _ = tx.json(&json!({ "t": "error", "code": code })).await; break }
                None => break,
            },
        }
    }
    let _ = tx.sink.close().await;
    core.unregister(sid);
    if let Some(d) = device {
        tracing::info!("устройство {d} отключилось");
    }
}

async fn send_snapshot(core: &Core, tx: &mut Tx, admin: bool, perms: &Perms) -> bool {
    let snap: serde_json::Map<String, Value> =
        core.hub.snapshot().into_iter().filter(|(k, _)| visible(k, admin, perms)).map(|(k, v)| (k.to_string(), (*v).clone())).collect();
    tx.json(&json!({ "t": "snapshot", "v": snap })).await.is_ok()
}

#[allow(clippy::too_many_arguments)]
async fn handle_frame(
    core: &Arc<Core>,
    tx: &mut Tx,
    f: Frame,
    admin: bool,
    device: Option<&str>,
    perms: &Perms,
    sub: &mut SubPixel,
    rtt: &AtomicU32,
    last_pub: &mut u32,
) -> bool {
    let p = &core.platform;
    let deny = |what: &str| json!({ "t": "denied", "what": what });
    match f {
        Frame::Ping(t) => {
            return tx.bin(&proto::pong(t)).await.is_ok();
        }
        Frame::Json(v) if v["t"] == "rtt" => {
            // телефон сообщает измеренную задержку — показываем её в дашборде
            let ms = v["ms"].as_u64().unwrap_or(0).min(10_000) as u32;
            rtt.store(ms, Ordering::Relaxed);
            if ms.abs_diff(*last_pub) >= 3 {
                *last_pub = ms;
                core.session_rtt();
            }
        }
        Frame::Move { .. } | Frame::Scroll { .. } | Frame::Button { .. } | Frame::Key { .. } | Frame::Text(_) | Frame::Chord(_) if !perms.input => {
            return tx.json(&deny("input")).await.is_ok();
        }
        Frame::Move { dx, dy } => {
            let (x, y) = sub.take(dx, dy);
            if x != 0 || y != 0 {
                p.mouse_move(x, y);
            }
        }
        Frame::Scroll { v, h } => p.scroll(v as i32, h as i32),
        Frame::Button { button, action } => p.mouse_button(button, action),
        Frame::Key { vk, action } => p.key(vk, action),
        Frame::Text(t) => p.text(&t),
        Frame::Chord(vks) => p.chord(&vks),
        Frame::Volume { level, seq } => {
            if !perms.media {
                return tx.json(&deny("media")).await.is_ok();
            }
            core.set_volume_from(level as f32 / 10_000.0, seq);
        }
        Frame::Json(v) => {
            if admin && v.get("t").and_then(|t| t.as_str()).is_some_and(|t| !matches!(t, "media" | "mute" | "power" | "timer" | "macro" | "clip-set")) {
                let reply = core.admin_cmd(&v);
                return tx.json(&reply).await.is_ok();
            }
            let Ok(cmd) = serde_json::from_value::<RemoteCmd>(v) else { return true };
            let reply = remote_cmd(core, cmd, device, perms);
            if let Some(r) = reply {
                for m in r {
                    if tx.json(&m).await.is_err() {
                        return false;
                    }
                }
            }
        }
    }
    true
}

fn remote_cmd(core: &Arc<Core>, cmd: RemoteCmd, device: Option<&str>, perms: &Perms) -> Option<Vec<Value>> {
    let p = &core.platform;
    let deny = |what: &str| Some(vec![json!({ "t": "denied", "what": what })]);
    let err = |e: anyhow::Error| Some(vec![json!({ "t": "error", "msg": e.to_string() })]);
    match cmd {
        RemoteCmd::Media { a } => {
            if !perms.media {
                return deny("media");
            }
            p.media(a);
        }
        RemoteCmd::Mute { v } => {
            if !perms.media {
                return deny("media");
            }
            p.set_mute(v);
        }
        RemoteCmd::Power { a } => {
            if !perms.power {
                return deny("power");
            }
            if let Err(e) = p.power(a) {
                return err(e);
            }
        }
        RemoteCmd::Timer { a, sec, cancel } => {
            if !perms.power {
                return deny("power");
            }
            match (cancel, a, sec) {
                (true, _, _) => core.cancel_timer(),
                (false, Some(a), Some(s)) if (10..=24 * 3600).contains(&s) => core.set_timer(a, s),
                _ => return Some(vec![json!({ "t": "error", "msg": "таймер: от 10 секунд до 24 часов" })]),
            }
        }
        RemoteCmd::Macro { id } => {
            if !perms.macros {
                return deny("macros");
            }
            if let Err(e) = core.run_macro(&id) {
                return err(e);
            }
        }
        RemoteCmd::ClipSet { text } => {
            if !perms.clipboard {
                return deny("clipboard");
            }
            if let Err(e) = core.set_clipboard_text(text.chars().take(1 << 20).collect()) {
                return err(e);
            }
            return Some(vec![json!({ "t": "ok", "for": "clip-set", "msg": "Скопировано в буфер ПК" })]);
        }
        RemoteCmd::Upload { name, size } => {
            if !perms.files {
                return deny("files");
            }
            let t =
                core.files.issue(crate::files::Ticket::Upload { name: crate::util::safe_file_name(&name), size, from: device.unwrap_or("ПК").to_string() });
            return Some(vec![json!({ "t": "ticket", "name": name, "url": format!("/api/upload/{t}") })]);
        }
        RemoteCmd::ClipFiles => {
            if !perms.files || !perms.clipboard {
                return deny("files");
            }
            return Some(core.clip_file_offers());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subpixel_accumulates() {
        let mut s = SubPixel::default();
        assert_eq!(s.take(1, -1), (0, 0));
        assert_eq!(s.take(1, -1), (0, 0));
        assert_eq!(s.take(2, -2), (1, -1));
        assert_eq!(s.take(9, 0), (2, 0));
        assert_eq!(s.x, 1);
    }

    #[test]
    fn visibility() {
        let p = Perms { clipboard: false, ..Perms::default() };
        assert!(visible("vol", false, &p));
        assert!(!visible("devices", false, &p));
        assert!(!visible("clip", false, &p));
        assert!(visible("devices", true, &p));
    }
}
