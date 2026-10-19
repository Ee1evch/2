//! Ретранслятор DotLink.
//!
//! Зачем: телефон в мобильном интернете, ПК — дома за NAT. Напрямую друг до друга им не достучаться,
//! но в интернет выходят оба. ПК держит к ретранслятору управляющее соединение (комнату), телефон
//! приходит в эту комнату, ретранслятор просит ПК открыть трубу и сшивает два WebSocket.
//! Часто после этого телефон и ПК поднимают прямой WebRTC (сквозь NAT по STUN) и ретранслятор
//! остаётся запасным путём.
//!
//! Что видит ретранслятор: только факт соединения и объём. Вход телефона — вызов-ответ по ключу
//! устройства, дальше — XChaCha20-Poly1305 ключами сессии; ни ключей, ни содержимого у него нет,
//! выдать себя за ПК он не может. Сопряжение по PIN через ретранслятор ядро не принимает:
//! короткий PIN можно перебрать оффлайн. По QR (128-битный секрет) — можно.
//!
//! Протокол:
//! - `GET /v1/pc/{room}?secret=S` — управление комнатой (WebSocket), `room = room_id(S)`;
//!   ← `{"t":"incoming","sid":"…"}` — пришёл телефон.
//! - `GET /v1/pc/{room}/{sid}?secret=S` — труба ПК для этого телефона (WebSocket).
//! - `GET /v1/phone/{room}` — труба телефона (WebSocket); 404, если ПК не в сети.
//! - `GET /healthz` — «ok» и счётчики.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// Комната выводится из секрета ПК: ретранслятор проверяет владение, ничего не храня.
/// Та же функция — в `dotlink_core::crypto::room_id`.
pub fn room_id(secret: &str) -> String {
    let h = Sha256::new().chain_update(b"dotlink/relay-room/v1").chain_update(secret.as_bytes()).finalize();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&h[..16])
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_rooms: usize,
    pub max_pipes_per_room: usize,
    pub max_message: usize,
    /// байт в секунду на трубу в каждую сторону (0 — без ограничения)
    pub rate: u64,
    /// сколько телефон ждёт, пока ПК откроет трубу
    pub pending_timeout: Duration,
    /// тишина, после которой соединение считается мёртвым
    pub idle: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_rooms: 10_000,
            max_pipes_per_room: 8,
            max_message: 4 << 20,
            rate: 8 << 20,
            pending_timeout: Duration::from_secs(10),
            idle: Duration::from_secs(75),
        }
    }
}

struct Room {
    gen: u64,
    ctl: mpsc::Sender<String>,
    pending: HashMap<String, (Instant, oneshot::Sender<WebSocket>)>,
    pipes: usize,
}

#[derive(Default)]
struct Stats {
    pipes: AtomicUsize,
    bytes: AtomicU64,
    total: AtomicU64,
}

struct Relay {
    limits: Limits,
    rooms: Mutex<HashMap<String, Room>>,
    gen: AtomicU64,
    stats: Stats,
}

type S = State<Arc<Relay>>;

pub fn router(limits: Limits) -> Router {
    let st = Arc::new(Relay { limits, rooms: Mutex::default(), gen: AtomicU64::new(1), stats: Stats::default() });
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/pc/{room}", get(pc_control))
        .route("/v1/pc/{room}/{sid}", get(pc_pipe))
        .route("/v1/phone/{room}", get(phone))
        .with_state(st)
}

async fn health(State(s): S) -> impl IntoResponse {
    let rooms = s.rooms.lock().len();
    format!(
        "ok rooms={rooms} pipes={} total={} bytes={}\n",
        s.stats.pipes.load(Ordering::Relaxed),
        s.stats.total.load(Ordering::Relaxed),
        s.stats.bytes.load(Ordering::Relaxed)
    )
}

#[derive(Deserialize)]
struct Secret {
    secret: String,
}

fn owns(room: &str, secret: &str) -> bool {
    // сравнение по хэшу — время не зависит от совпадающих символов секрета
    !secret.is_empty() && room_id(secret) == room
}

async fn pc_control(Path(room): Path<String>, Query(q): Query<Secret>, State(s): S, ws: WebSocketUpgrade) -> Response {
    if !owns(&room, &q.secret) {
        return StatusCode::FORBIDDEN.into_response();
    }
    {
        let rooms = s.rooms.lock();
        if rooms.len() >= s.limits.max_rooms && !rooms.contains_key(&room) {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }
    ws.on_upgrade(move |sock| control(s, room, sock))
}

async fn control(s: Arc<Relay>, room: String, mut sock: WebSocket) {
    let (tx, mut rx) = mpsc::channel::<String>(64);
    let gen = s.gen.fetch_add(1, Ordering::Relaxed);
    {
        // новое подключение того же ПК (перезапуск, смена сети) вытесняет старое
        let mut rooms = s.rooms.lock();
        let pipes = rooms.get(&room).map_or(0, |r| r.pipes);
        rooms.insert(room.clone(), Room { gen, ctl: tx, pending: HashMap::new(), pipes });
    }
    tracing::info!("комната {}… открыта", &room[..6.min(room.len())]);
    if sock.send(Message::Text(format!(r#"{{"t":"ready","room":"{room}"}}"#).into())).await.is_ok() {
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    Some(t) => if sock.send(Message::Text(t.into())).await.is_err() { break },
                    None => break,
                },
                m = tokio::time::timeout(s.limits.idle, sock.recv()) => match m {
                    Ok(Some(Ok(Message::Close(_)))) | Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
                    Ok(Some(Ok(_))) => {}
                },
            }
        }
    }
    let mut rooms = s.rooms.lock();
    if rooms.get(&room).is_some_and(|r| r.gen == gen) {
        rooms.remove(&room);
    }
    tracing::info!("комната {}… закрыта", &room[..6.min(room.len())]);
}

async fn pc_pipe(Path((room, sid)): Path<(String, String)>, Query(q): Query<Secret>, State(s): S, ws: WebSocketUpgrade) -> Response {
    if !owns(&room, &q.secret) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let waiting = s.rooms.lock().get_mut(&room).and_then(|r| r.pending.remove(&sid)).map(|(_, tx)| tx);
    let Some(tx) = waiting else { return StatusCode::NOT_FOUND.into_response() };
    ws.max_message_size(s.limits.max_message).on_upgrade(move |pc| async move {
        let _ = tx.send(pc);
    })
}

async fn phone(Path(room): Path<String>, State(s): S, ws: WebSocketUpgrade) -> Response {
    let sid = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 12]>());
    let (tx, rx) = oneshot::channel();
    {
        let mut rooms = s.rooms.lock();
        let Some(r) = rooms.get_mut(&room) else { return StatusCode::NOT_FOUND.into_response() };
        let timeout = s.limits.pending_timeout;
        r.pending.retain(|_, (at, _)| at.elapsed() < timeout);
        if r.pipes + r.pending.len() >= s.limits.max_pipes_per_room {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        if r.ctl.try_send(format!(r#"{{"t":"incoming","sid":"{sid}"}}"#)).is_err() {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        r.pending.insert(sid.clone(), (Instant::now(), tx));
    }
    ws.max_message_size(s.limits.max_message).on_upgrade(move |ph| async move {
        let pc = tokio::time::timeout(s.limits.pending_timeout, rx).await;
        let Ok(Ok(pc)) = pc else {
            if let Some(r) = s.rooms.lock().get_mut(&room) {
                r.pending.remove(&sid);
            }
            return;
        };
        let count = |d: isize| {
            if let Some(r) = s.rooms.lock().get_mut(&room) {
                r.pipes = r.pipes.saturating_add_signed(d);
            }
        };
        count(1);
        s.stats.pipes.fetch_add(1, Ordering::Relaxed);
        s.stats.total.fetch_add(1, Ordering::Relaxed);
        splice(ph, pc, &s).await;
        s.stats.pipes.fetch_sub(1, Ordering::Relaxed);
        count(-1);
    })
}

/// Сшить две трубы: всё, что пришло с одной, уходит в другую как есть.
async fn splice(a: WebSocket, b: WebSocket, s: &Relay) {
    let (a_tx, a_rx) = a.split();
    let (b_tx, b_rx) = b.split();
    tokio::select! {
        _ = pump(a_rx, b_tx, s) => {}
        _ = pump(b_rx, a_tx, s) => {}
    }
}

async fn pump<R, W>(mut rx: R, mut tx: W, s: &Relay)
where
    R: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
    W: futures_util::Sink<Message> + Unpin,
{
    let rate = s.limits.rate as f64;
    let mut tokens = rate;
    let mut last = Instant::now();
    loop {
        let m = match tokio::time::timeout(s.limits.idle, rx.next()).await {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let len = match &m {
            Message::Text(t) => t.len(),
            Message::Binary(b) => b.len(),
            Message::Close(_) => break,
            // пинги отвечает сам WebSocket — дальше не передаём
            Message::Ping(_) | Message::Pong(_) => continue,
        };
        if rate > 0.0 {
            let now = Instant::now();
            tokens = (tokens + rate * now.duration_since(last).as_secs_f64()).min(rate);
            last = now;
            tokens -= len as f64;
            if tokens < 0.0 {
                tokio::time::sleep(Duration::from_secs_f64(-tokens / rate)).await;
            }
        }
        s.stats.bytes.fetch_add(len as u64, Ordering::Relaxed);
        if tx.send(m).await.is_err() {
            break;
        }
    }
    let _ = tx.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Общий вектор с dotlink_core::crypto::room_id.
    #[test]
    fn room_vector() {
        assert_eq!(room_id("секрет-комнаты"), ROOM_VEC);
        assert!(owns(&room_id("a"), "a"));
        assert!(!owns(&room_id("a"), "b"));
        assert!(!owns(&room_id(""), ""));
    }

    const ROOM_VEC: &str = "HS9MAAq_dZ-4U56mlDIxtA";
}
