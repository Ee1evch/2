//! Сессия: вход (сопряжение или вызов-ответ), затем ввод → ОС и состояние → телефон.
//!
//! Один и тот же код обслуживает любой канал (`Wire`): WebSocket в локальной сети, трубу через
//! ретранслятор, Bluetooth. Поверх него телефон может поднять прямой канал WebRTC — сигналинг идёт
//! внутри этой же зашифрованной сессии, после чего команды идут по «ctl», а движения — по «fast» (как UDP).

use crate::core::{Core, Out, SessionInfo};
use crate::crypto::{self, Channel, PairKeys, LABEL_RTC_CTL, LABEL_RTC_FAST};
use crate::hub::ADMIN_ONLY;
use crate::pairing::Kind;
use crate::proto::{self, Frame, RemoteCmd};
use crate::rtc::{self, Rtc, RtcEvent};
use crate::store::Perms;
use crate::transport::{Msg, Via, Wire};
use crate::util::{b64, unb64, unb64_arr};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

struct Keys {
    dk: [u8; 32],
    nc: [u8; 16],
    ns: [u8; 16],
}

#[allow(clippy::large_enum_variant)] // одна на сессию
enum Role {
    Admin,
    Remote { device: String, name: String, perms: Perms, chan: Channel, keys: Keys },
}

/// Откуда пришёл кадр — ответ на пинг уходит тем же путём, чтобы задержка была честной.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Path {
    Wire,
    Ctl,
    Fast,
}

/// Отправка: основной канал или WebRTC, с шифрованием телефона (у дашборда — без).
struct Tx {
    wire: mpsc::Sender<Msg>,
    chan: Option<Channel>,
    rtc: Option<Arc<Rtc>>,
    rtc_ctl: Option<Channel>,
    rtc_fast: Option<Channel>,
    rtc_open: bool,
}

impl Tx {
    async fn wire_bin(&mut self, plain: &[u8]) -> bool {
        let data = match &mut self.chan {
            Some(c) => c.seal(plain),
            None => plain.to_vec(),
        };
        self.wire.send(Msg::Bin(data)).await.is_ok()
    }

    /// Надёжная доставка: по WebRTC «ctl», если он открыт и кадр небольшой, иначе основным каналом.
    async fn reliable(&mut self, plain: &[u8]) -> bool {
        if self.rtc_open && plain.len() + 32 <= rtc::MAX_DC_MESSAGE {
            if let (Some(rtc), Some(c)) = (self.rtc.clone(), self.rtc_ctl.as_mut()) {
                if rtc.send(rtc::Kind::Ctl, &c.seal(plain)).await {
                    return true;
                }
            }
        }
        self.wire_bin(plain).await
    }

    /// Можно потерять, нельзя задержать: движения курсора на телефоне.
    async fn fast(&mut self, plain: &[u8]) -> bool {
        if self.rtc_open {
            if let (Some(rtc), Some(c)) = (self.rtc.clone(), self.rtc_fast.as_mut()) {
                if rtc.send(rtc::Kind::Fast, &c.seal(plain)).await {
                    return true;
                }
            }
        }
        let data = match &mut self.chan {
            Some(c) => c.seal(plain),
            None => plain.to_vec(),
        };
        // очередь основного канала полна — кадр движения не стоит ожидания
        !matches!(self.wire.try_send(Msg::Bin(data)), Err(mpsc::error::TrySendError::Closed(_)))
    }

    async fn reply(&mut self, path: Path, plain: &[u8]) -> bool {
        match path {
            Path::Fast => self.fast(plain).await,
            Path::Ctl => self.reliable(plain).await,
            Path::Wire => self.wire_bin(plain).await,
        }
    }

    async fn json(&mut self, v: &Value) -> bool {
        let bytes = serde_json::to_vec(v).unwrap_or_default();
        if self.chan.is_none() {
            return self.wire.send(Msg::Text(String::from_utf8(bytes).unwrap_or_default())).await.is_ok();
        }
        self.reliable(&bytes).await
    }

    /// Только основным каналом: сигналинг WebRTC и крупные кадры.
    async fn json_wire(&mut self, v: &Value) -> bool {
        let bytes = serde_json::to_vec(v).unwrap_or_default();
        if self.chan.is_none() {
            return self.wire.send(Msg::Text(String::from_utf8(bytes).unwrap_or_default())).await.is_ok();
        }
        self.wire_bin(&bytes).await
    }
}

async fn recv_json(rx: &mut mpsc::Receiver<Msg>) -> Option<Value> {
    match rx.recv().await? {
        Msg::Text(t) => serde_json::from_str(&t).ok(),
        Msg::Bin(_) => None,
    }
}

async fn fail(tx: &mut Tx, code: &str) -> Option<Role> {
    tx.json(&json!({ "t": "error", "code": code })).await;
    None
}

async fn handshake(core: &Arc<Core>, tx: &mut Tx, rx: &mut mpsc::Receiver<Msg>, loopback: bool, via: Via) -> Option<Role> {
    let hello = recv_json(rx).await?;
    if hello["t"] != "hello" {
        return fail(tx, "protocol").await;
    }
    let pc = core.pc_info();
    if hello["role"] == "admin" {
        let token = hello["token"].as_str().unwrap_or("");
        if !loopback || !crypto::ct_eq(token.as_bytes(), core.admin_token.as_bytes()) {
            return fail(tx, "forbidden").await;
        }
        tx.json(&json!({ "t": "welcome", "admin": true, "pc": pc })).await.then_some(())?;
        return Some(Role::Admin);
    }

    let Some(nc) = hello["nonce"].as_str().and_then(unb64_arr::<16>) else { return fail(tx, "protocol").await };
    let ns = crypto::random::<16>();
    let name: String = hello["name"].as_str().unwrap_or("Телефон").trim().chars().take(40).collect();

    if let Some(mode) = hello["pair"].as_str() {
        // ───── сопряжение ─────
        let kind = if mode == "pin" { Kind::Pin } else { Kind::Qr };
        // короткий PIN через чужой сервер можно перебрать оффлайн — только вблизи (сеть, Bluetooth)
        if kind == Kind::Pin && via == Via::Relay {
            return fail(tx, "pin-local-only").await;
        }
        let Some(pub_c) = hello["pub"].as_str().and_then(unb64_arr::<32>) else { return fail(tx, "protocol").await };
        if core.pairing.candidates(kind).is_empty() {
            return fail(tx, "expired").await;
        }
        let keys = PairKeys::generate();
        tx.json(&json!({ "t": "pair-challenge", "pub": b64(&keys.public), "nonce": b64(&ns), "pc": pc })).await.then_some(())?;
        let proof = recv_json(rx).await?;
        let mac = proof["mac"].as_str().and_then(unb64).unwrap_or_default();
        let z = keys.shared(&pub_c);
        let t = crypto::pair_transcript(&pub_c, &keys.public, &nc, &ns);
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
        tx.json(&json!({ "t": "paired", "device": dev.id, "mac": b64(&crypto::pair_mac(&secret, b"s", &t, &z)), "pc": pc, "perms": dev.perms }))
            .await
            .then_some(())?;
        let chan = Channel::new(&dk, &nc, &ns, true);
        return Some(Role::Remote { device: dev.id, name: dev.name, perms: dev.perms, chan, keys: Keys { dk, nc, ns } });
    }

    // ───── вход известного устройства ─────
    let Some(dev) = hello["device"].as_str().and_then(|id| core.store.device(id)) else { return fail(tx, "unknown-device").await };
    let Some(dk) = unb64_arr::<32>(&dev.key) else { return fail(tx, "unknown-device").await };
    tx.json(&json!({ "t": "challenge", "nonce": b64(&ns), "pc": pc })).await.then_some(())?;
    let auth = recv_json(rx).await?;
    let mac = auth["mac"].as_str().and_then(unb64).unwrap_or_default();
    if !crypto::ct_eq(&mac, &crypto::auth_mac(&dk, b"c", &nc, &ns)) {
        return fail(tx, "bad-auth").await;
    }
    tx.json(&json!({ "t": "welcome", "device": dev.id, "mac": b64(&crypto::auth_mac(&dk, b"s", &nc, &ns)), "pc": pc, "perms": dev.perms }))
        .await
        .then_some(())?;
    let chan = Channel::new(&dk, &nc, &ns, true);
    Some(Role::Remote { device: dev.id, name: dev.name, perms: dev.perms, chan, keys: Keys { dk, nc, ns } })
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

/// Файл, который телефон присылает частями внутри сессии.
struct Upload {
    file: tokio::io::BufWriter<tokio::fs::File>,
    tmp: std::path::PathBuf,
    path: std::path::PathBuf,
    name: String,
    size: Option<u64>,
    got: u64,
    from: String,
}

struct Ctx {
    sid: u64,
    out: mpsc::Sender<Out>,
    uploads: std::collections::HashMap<String, Upload>,
    admin: bool,
    device: Option<String>,
    perms: Perms,
    keys: Option<Keys>,
    sub: SubPixel,
    rtt: Arc<AtomicU32>,
    p2p: Arc<AtomicBool>,
    last_rtt_publish: u32,
    rtc_rx: Option<mpsc::Receiver<RtcEvent>>,
}

pub async fn run(core: Arc<Core>, wire: Wire) {
    let Wire { tx: wire_tx, rx: mut wire_rx, via, peer, loopback } = wire;
    let mut tx = Tx { wire: wire_tx, chan: None, rtc: None, rtc_ctl: None, rtc_fast: None, rtc_open: false };
    let role = match tokio::time::timeout(Duration::from_secs(20), handshake(&core, &mut tx, &mut wire_rx, loopback, via)).await {
        Ok(Some(r)) => r,
        _ => return,
    };
    let (admin, device, name, perms, keys) = match role {
        Role::Admin => (true, None, String::from("Дашборд"), Perms::default(), None),
        Role::Remote { device, name, perms, chan, keys } => {
            tracing::info!("подключено «{name}» ({via:?}, {peer})");
            tx.chan = Some(chan);
            (false, Some(device), name, perms, Some(keys))
        }
    };

    let (out_tx, mut out_rx) = mpsc::channel::<Out>(512);
    let rtt = Arc::new(AtomicU32::new(0));
    let p2p = Arc::new(AtomicBool::new(false));
    let out = out_tx.clone();
    let sid = core.register(SessionInfo {
        device: device.clone(),
        name,
        peer: peer.clone(),
        via,
        p2p: p2p.clone(),
        since: crate::util::now_ms(),
        rtt: rtt.clone(),
        tx: out_tx,
    });

    // подписка до снимка: ни одно изменение не потеряется
    let mut hub_rx = core.hub.subscribe();
    let mut ok = send_snapshot(&core, &mut tx, admin, &perms).await;
    let mut ctx =
        Ctx { sid, out, uploads: Default::default(), admin, device, perms, keys, sub: SubPixel::default(), rtt, p2p, last_rtt_publish: 0, rtc_rx: None };

    while ok {
        tokio::select! {
            m = wire_rx.recv() => {
                let Some(m) = m else { break };
                ok = match m {
                    Msg::Bin(b) => {
                        let plain = match &mut tx.chan {
                            Some(c) => match c.open(&b) { Some(p) => p, None => { tracing::warn!("отброшен кадр с неверной подписью от {peer}"); continue } },
                            None => b,
                        };
                        match proto::decode(&plain) {
                            Ok(f) => handle_frame(&core, &mut tx, &mut ctx, f, Path::Wire).await,
                            Err(_) => true,
                        }
                    }
                    Msg::Text(t) if ctx.admin => match serde_json::from_str::<Value>(&t) {
                        Ok(v) => { let reply = core.admin_cmd(&v); tx.json(&reply).await }
                        Err(_) => true,
                    },
                    Msg::Text(_) => true,
                };
            }
            e = async { match ctx.rtc_rx.as_mut() { Some(r) => r.recv().await, None => std::future::pending().await } } => {
                ok = handle_rtc(&core, &mut tx, &mut ctx, e).await;
            }
            u = hub_rx.recv() => match u {
                Ok((k, v)) => if visible(k, ctx.admin, &ctx.perms) {
                    ok = tx.json(&json!({ "t": "state", "k": k, "v": *v })).await;
                },
                Err(broadcast::error::RecvError::Lagged(_)) => ok = send_snapshot(&core, &mut tx, ctx.admin, &ctx.perms).await,
                Err(_) => break,
            },
            o = out_rx.recv() => match o {
                Some(Out::Json(v)) => ok = tx.json(&v).await,
                Some(Out::Bin(b)) => ok = tx.reliable(&b).await,
                Some(Out::Bulk(b)) => ok = tx.wire_bin(&b).await,
                Some(Out::Fast(b)) => ok = tx.fast(&b).await,
                Some(Out::Perms(p)) => {
                    ctx.perms = p;
                    ok = tx.json(&json!({ "t": "perms", "v": ctx.perms })).await && send_snapshot(&core, &mut tx, ctx.admin, &ctx.perms).await;
                }
                Some(Out::Close(code)) => { tx.json(&json!({ "t": "error", "code": code })).await; break }
                None => break,
            },
        }
    }
    if let Some(r) = tx.rtc.take() {
        r.close().await;
    }
    for (_, u) in ctx.uploads.drain() {
        let _ = tokio::fs::remove_file(&u.tmp).await;
    }
    core.motion.forget(sid);
    core.unregister(sid);
    if let Some(d) = ctx.device {
        tracing::info!("устройство {d} отключилось");
    }
}

async fn send_snapshot(core: &Core, tx: &mut Tx, admin: bool, perms: &Perms) -> bool {
    let snap: serde_json::Map<String, Value> =
        core.hub.snapshot().into_iter().filter(|(k, _)| visible(k, admin, perms)).map(|(k, v)| (k.to_string(), (*v).clone())).collect();
    tx.json_wire(&json!({ "t": "snapshot", "v": snap })).await
}

async fn handle_rtc(core: &Arc<Core>, tx: &mut Tx, ctx: &mut Ctx, e: Option<RtcEvent>) -> bool {
    match e {
        Some(RtcEvent::Ice(c)) => tx.json_wire(&json!({ "t": "rtc-ice", "candidate": c })).await,
        Some(RtcEvent::Open(rtc::Kind::Ctl)) => {
            tx.rtc_open = true;
            ctx.p2p.store(true, Ordering::Relaxed);
            core.publish_devices();
            tracing::info!("прямой канал WebRTC открыт");
            true
        }
        Some(RtcEvent::Open(_)) => true,
        Some(RtcEvent::Msg(kind, data)) => {
            let ch = if kind == rtc::Kind::Ctl { tx.rtc_ctl.as_mut() } else { tx.rtc_fast.as_mut() };
            let Some(plain) = ch.and_then(|c| c.open(&data)) else { return true };
            match proto::decode(&plain) {
                Ok(f) => handle_frame(core, tx, ctx, f, if kind == rtc::Kind::Ctl { Path::Ctl } else { Path::Fast }).await,
                Err(_) => true,
            }
        }
        Some(RtcEvent::Closed) | None => {
            // прямой канал пропал — всё продолжает идти основным
            if let Some(r) = tx.rtc.take() {
                r.close().await;
            }
            tx.rtc_open = false;
            ctx.rtc_rx = None;
            ctx.p2p.store(false, Ordering::Relaxed);
            core.publish_devices();
            true
        }
    }
}

async fn handle_frame(core: &Arc<Core>, tx: &mut Tx, ctx: &mut Ctx, f: Frame, path: Path) -> bool {
    let p = &core.platform;
    let deny = |what: &str| json!({ "t": "denied", "what": what });
    match f {
        Frame::Ping(t) => return tx.reply(path, &proto::pong(t)).await,
        Frame::Json(v) if v["t"] == "rtt" => {
            // телефон сообщает измеренную задержку — показываем её в дашборде
            let ms = v["ms"].as_u64().unwrap_or(0).min(10_000) as u32;
            ctx.rtt.store(ms, Ordering::Relaxed);
            if ms.abs_diff(ctx.last_rtt_publish) >= 3 {
                ctx.last_rtt_publish = ms;
                core.publish_devices();
            }
        }
        Frame::Move { .. } | Frame::MoveT { .. } | Frame::Scroll { .. } | Frame::Button { .. } | Frame::Key { .. } | Frame::Text(_) | Frame::Chord(_)
            if !ctx.perms.input =>
        {
            return tx.json(&deny("input")).await;
        }
        // плавный путь: движение воспроизводится в ритме пальца
        Frame::MoveT { dx, dy, t } => core.motion.push(ctx.sid, t, dx, dy),
        Frame::Move { dx, dy } => {
            let (x, y) = ctx.sub.take(dx, dy);
            if x != 0 || y != 0 {
                p.mouse_move(x, y);
            }
        }
        // перед кликом курсор доезжает до места, где его оставил палец
        Frame::Scroll { v, h } => p.scroll(v as i32, h as i32),
        Frame::Button { button, action } => {
            core.motion.flush().await;
            p.mouse_button(button, action)
        }
        Frame::Key { vk, action } => p.key(vk, action),
        Frame::Text(t) => p.text(&t),
        Frame::Chord(vks) => p.chord(&vks),
        Frame::Volume { level, seq } => {
            if !ctx.perms.media {
                return tx.json(&deny("media")).await;
            }
            core.set_volume_from(level as f32 / 10_000.0, seq);
        }
        Frame::File { kind, id, data } => {
            if !ctx.perms.files {
                return tx.json(&deny("files")).await;
            }
            return file_part(core, tx, ctx, kind, id, data).await;
        }
        Frame::Mirror(frame) => {
            if let Some(d) = &ctx.device {
                core.mirror_frame(d, frame);
            }
        }
        Frame::Json(v) => {
            if ctx.admin {
                let reply = core.admin_cmd(&v);
                return tx.json(&reply).await;
            }
            let Ok(cmd) = serde_json::from_value::<RemoteCmd>(v) else { return true };
            match cmd {
                RemoteCmd::RtcOffer { sdp } => return rtc_offer(core, tx, ctx, sdp).await,
                RemoteCmd::FileGet { ticket } => {
                    if !ctx.perms.files {
                        return tx.json(&deny("files")).await;
                    }
                    let Some(crate::files::Ticket::Download { path, .. }) = core.files.take(&ticket) else {
                        return tx.json(&json!({ "t": "error", "msg": "ссылка на файл устарела" })).await;
                    };
                    tokio::spawn(send_file(path, ticket, ctx.out.clone()));
                }
                RemoteCmd::RtcIce { candidate } => {
                    if let Some(r) = &tx.rtc {
                        if let Err(e) = r.add_candidate(candidate).await {
                            tracing::debug!("ICE-кандидат отклонён: {e:#}");
                        }
                    }
                }
                cmd => {
                    for m in remote_cmd(core, cmd, ctx.device.as_deref(), &ctx.perms) {
                        if !tx.json(&m).await {
                            return false;
                        }
                    }
                }
            }
        }
    }
    true
}

/// Часть файла от телефона: первая открывает файл по билету загрузки, «конец» — проверяет размер
/// и переносит в «Загрузки». Используется, когда HTTP до ПК недоступен (ретранслятор, Bluetooth).
async fn file_part(core: &Arc<Core>, tx: &mut Tx, ctx: &mut Ctx, kind: u8, id: String, data: Vec<u8>) -> bool {
    use tokio::io::AsyncWriteExt;
    if !ctx.uploads.contains_key(&id) {
        if kind > 1 {
            return true;
        }
        let Some(crate::files::Ticket::Upload { name, size, from }) = core.files.take(&id) else {
            return tx.json(&json!({ "t": "error", "msg": "билет на файл недействителен" })).await;
        };
        let dir = core.platform.downloads_dir();
        let _ = tokio::fs::create_dir_all(&dir).await;
        let path = crate::files::unique_path(&dir, &name);
        let tmp = path.with_extension("dotlink-part");
        match tokio::fs::File::create(&tmp).await {
            Ok(f) => {
                ctx.uploads.insert(id.clone(), Upload { file: tokio::io::BufWriter::with_capacity(1 << 20, f), tmp, path, name, size, got: 0, from });
            }
            Err(e) => return tx.json(&json!({ "t": "error", "msg": format!("файл: {e}") })).await,
        }
    }
    let up = ctx.uploads.get_mut(&id).expect("только что добавлен");
    up.got += data.len() as u64;
    let res = async {
        if up.got > up.size.unwrap_or(crate::files::MAX_UPLOAD) {
            return Err(std::io::Error::other("файл больше заявленного"));
        }
        up.file.write_all(&data).await?;
        if kind == 1 {
            up.file.flush().await?;
            if up.size.is_some_and(|s| s != up.got) {
                return Err(std::io::Error::other("передача прервана"));
            }
            tokio::fs::rename(&up.tmp, &up.path).await?;
        }
        Ok(())
    }
    .await;
    match (kind, res) {
        (0, Ok(())) => true,
        (1, Ok(())) => {
            let up = ctx.uploads.remove(&id).expect("есть");
            let from = core.store.device(&up.from).map(|d| d.name).unwrap_or(up.from);
            let fname = up.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(up.name);
            core.received(crate::files::Received {
                name: fname.clone(),
                size: up.got,
                from,
                at: crate::util::now_ms(),
                path: up.path.to_string_lossy().into(),
            });
            tx.json(&json!({ "t": "ok", "for": "upload", "id": id, "name": fname })).await
        }
        (_, r) => {
            let up = ctx.uploads.remove(&id).expect("есть");
            let _ = tokio::fs::remove_file(&up.tmp).await;
            match r {
                Err(e) => tx.json(&json!({ "t": "error", "for": "upload", "id": id, "msg": e.to_string() })).await,
                Ok(()) => true, // отменено телефоном
            }
        }
    }
}

/// Файл с ПК частями по основному каналу сессии; очередь ограничена — память не растёт.
async fn send_file(path: std::path::PathBuf, id: String, out: mpsc::Sender<Out>) {
    use tokio::io::AsyncReadExt;
    let Ok(mut f) = tokio::fs::File::open(&path).await else {
        let _ = out.send(Out::Bulk(proto::file_frame(2, &id, &[]))).await;
        return;
    };
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        match f.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if out.send(Out::Bulk(proto::file_frame(0, &id, &buf[..n]))).await.is_err() {
                    return;
                }
            }
            Err(_) => {
                let _ = out.send(Out::Bulk(proto::file_frame(2, &id, &[]))).await;
                return;
            }
        }
    }
    let _ = out.send(Out::Bulk(proto::file_frame(1, &id, &[]))).await;
}

/// Телефон предлагает прямой канал. Ключи WebRTC-каналов выводятся из ключа этой сессии.
async fn rtc_offer(core: &Arc<Core>, tx: &mut Tx, ctx: &mut Ctx, sdp: Value) -> bool {
    let Some(k) = &ctx.keys else { return true };
    if let Some(old) = tx.rtc.take() {
        old.close().await;
    }
    tx.rtc_open = false;
    let (etx, erx) = mpsc::channel(256);
    let ice = core.store.read().settings.ice_servers.clone();
    match Rtc::answer(sdp, &ice, etx).await {
        Ok((rtc, answer)) => {
            tx.rtc = Some(Arc::new(rtc));
            tx.rtc_ctl = Some(Channel::labeled(&k.dk, &k.nc, &k.ns, true, LABEL_RTC_CTL, false));
            tx.rtc_fast = Some(Channel::labeled(&k.dk, &k.nc, &k.ns, true, LABEL_RTC_FAST, true));
            ctx.rtc_rx = Some(erx);
            tx.json_wire(&json!({ "t": "rtc-answer", "sdp": answer })).await
        }
        Err(e) => {
            tracing::warn!("WebRTC: {e:#}");
            tx.json_wire(&json!({ "t": "rtc-failed", "msg": e.to_string() })).await
        }
    }
}

fn remote_cmd(core: &Arc<Core>, cmd: RemoteCmd, device: Option<&str>, perms: &Perms) -> Vec<Value> {
    let p = &core.platform;
    let deny = |what: &str| vec![json!({ "t": "denied", "what": what })];
    let err = |e: anyhow::Error| vec![json!({ "t": "error", "msg": e.to_string() })];
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
                _ => return vec![json!({ "t": "error", "msg": "таймер: от 10 секунд до 24 часов" })],
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
            return vec![json!({ "t": "ok", "for": "clip-set", "msg": "Скопировано в буфер ПК" })];
        }
        RemoteCmd::Upload { name, size } => {
            if !perms.files {
                return deny("files");
            }
            let t =
                core.files.issue(crate::files::Ticket::Upload { name: crate::util::safe_file_name(&name), size, from: device.unwrap_or("ПК").to_string() });
            return vec![json!({ "t": "ticket", "name": name, "url": format!("/api/upload/{t}") })];
        }
        RemoteCmd::ClipFiles => {
            if !perms.files || !perms.clipboard {
                return deny("files");
            }
            return core.clip_file_offers();
        }
        RemoteCmd::OpenUrl { url } => {
            if !perms.clipboard {
                return deny("clipboard");
            }
            if let Err(e) = core.open_url_from_phone(&url) {
                return err(e);
            }
            return vec![json!({ "t": "ok", "for": "open-url", "msg": "Открыто на ПК" })];
        }
        RemoteCmd::Notify { app, title, text } => {
            if let Some(d) = device {
                core.phone_notification(d, &app, &title, &text);
            }
        }
        RemoteCmd::Mirror { on, w, h, codec } => {
            if let Some(d) = device {
                core.mirror_state(d, on, w, h, &codec);
            }
        }
        RemoteCmd::UcExit => core.uc_stop(),
        RemoteCmd::RtcOffer { .. } | RemoteCmd::RtcIce { .. } | RemoteCmd::FileGet { .. } => {}
    }
    vec![]
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
