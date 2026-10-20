//! Ядро: связывает хранилище, хаб состояния, платформу, сопряжение, файлы и сессии.

use crate::files::{Files, Ticket};
use crate::hub::Hub;
use crate::motion::Motion;
use crate::pairing::Pairing;
use crate::platform::{CaptureEv, Clip, Event, MouseButton, Platform, PowerAction};
use crate::proto::{self, vk};
use crate::store::{Device, Macro, MacroKind, Perms, Settings, Store};
use crate::transport::Via;
use crate::util::{b64url, now_ms};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};

/// Возможности оболочки (окно Tauri): автозапуск и системные уведомления.
pub trait Host: Send + Sync + 'static {
    fn autostart(&self) -> Option<bool> {
        None
    }
    fn set_autostart(&self, _on: bool) -> anyhow::Result<()> {
        Ok(())
    }
    fn notify(&self, _title: &str, _body: &str) {}
}

pub struct NoHost;
impl Host for NoHost {}

/// Сообщение сессии от ядра.
pub enum Out {
    Json(Value),
    /// бинарный кадр с надёжной доставкой
    Bin(Vec<u8>),
    /// крупный кадр — только основным каналом (видео экрана в дашборд)
    Bulk(Vec<u8>),
    /// можно потерять, нельзя задержать (движения курсора на телефоне)
    Fast(Vec<u8>),
    Perms(Perms),
    Close(&'static str),
}

pub struct SessionInfo {
    pub device: Option<String>,
    pub name: String,
    pub peer: String,
    pub via: Via,
    /// поверх канала поднят прямой WebRTC
    pub p2p: Arc<AtomicBool>,
    pub since: u64,
    pub rtt: Arc<AtomicU32>,
    pub tx: mpsc::Sender<Out>,
}

/// Режим «мышь и клавиатура ПК управляют телефоном» (как Universal Control).
#[derive(Default)]
struct Uc {
    device: Option<String>,
}

struct Timer {
    id: u64,
    action: PowerAction,
    ends_at: u64,
    total: u32,
}

pub struct Core {
    pub store: Store,
    pub hub: Hub,
    pub platform: Arc<dyn Platform>,
    pub host: Arc<dyn Host>,
    pub pairing: Pairing,
    pub files: Files,
    pub admin_token: String,
    pub port: AtomicU16,
    pub data_dir: Option<PathBuf>,
    sessions: Mutex<HashMap<u64, SessionInfo>>,
    next_id: AtomicU64,
    timer: Mutex<Option<Timer>>,
    pub vol_seq: AtomicU16,
    clip_echo: Mutex<Option<String>>,
    clip_seq: AtomicU64,
    last_clip: Mutex<Option<Clip>>,
    outbox: Mutex<HashMap<String, (PathBuf, String, u64)>>,
    pub motion: Motion,
    uc: Mutex<Uc>,
    notifs: Mutex<Vec<Value>>,
    /// изменения настроек — ретранслятор и Bluetooth перезапускаются сами
    pub settings_tx: watch::Sender<Settings>,
    /// кэш приложений меню «Пуск» для командной палитры (сканирование диска — редко)
    apps: Mutex<Option<(Instant, Arc<Vec<crate::platform::Launchable>>)>>,
}

impl Core {
    pub fn new(store: Store, platform: Arc<dyn Platform>, host: Arc<dyn Host>, admin_token: String, data_dir: Option<PathBuf>) -> Self {
        let settings = store.read().settings.clone();
        platform.set_edge(&settings.uc_edge);
        Self {
            motion: Motion::start(platform.clone()),
            uc: Mutex::new(Uc::default()),
            notifs: Mutex::new(Vec::new()),
            settings_tx: watch::channel(settings).0,
            store,
            hub: Hub::new(),
            platform,
            host,
            pairing: Pairing::default(),
            files: Files::default(),
            admin_token,
            port: AtomicU16::new(0),
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            timer: Mutex::new(None),
            vol_seq: AtomicU16::new(0),
            clip_echo: Mutex::new(None),
            clip_seq: AtomicU64::new(0),
            last_clip: Mutex::new(None),
            outbox: Mutex::new(HashMap::new()),
            apps: Mutex::new(None),
        }
    }

    // ───────── командная палитра ─────────

    /// Список приложений меню «Пуск», кэш на минуту (сканирование диска — дорогое).
    pub fn launch_apps(&self) -> Arc<Vec<crate::platform::Launchable>> {
        {
            let g = self.apps.lock();
            if let Some((at, v)) = g.as_ref() {
                if at.elapsed() < Duration::from_secs(60) {
                    return v.clone();
                }
            }
        }
        let v = Arc::new(self.platform.launchables());
        *self.apps.lock() = Some((Instant::now(), v.clone()));
        v
    }

    /// Ответ палитры: приложения (без путей) и открытые окна.
    pub fn palette(&self) -> Value {
        let list = self.launch_apps();
        let apps: Vec<Value> = list.iter().map(|a| json!({ "id": a.id, "name": a.name, "icon": a.icon })).collect();
        let windows: Vec<Value> = self.platform.windows().into_iter().map(|w| json!({ "id": w.id, "title": w.title, "app": w.app })).collect();
        json!({ "t": "palette", "apps": apps, "windows": windows })
    }

    /// Запустить приложение палитры по id (его `target` телефону не виден).
    pub fn launch(&self, id: &str) -> anyhow::Result<()> {
        let list = self.launch_apps();
        let target = list.iter().find(|a| a.id == id).map(|a| a.target.clone()).ok_or_else(|| anyhow::anyhow!("приложение не найдено"))?;
        self.platform.open(&target, "")
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    pub fn pc_info(&self) -> Value {
        let c = self.store.read();
        json!({ "id": c.pc_id, "name": c.pc_name, "os": std::env::consts::OS, "version": env!("CARGO_PKG_VERSION"), "platform": self.platform.name() })
    }

    // ───────── публикация состояния ─────────

    pub fn publish_all(&self) {
        self.hub.set("pc", self.pc_info());
        self.publish_routes();
        self.hub.set("mirror", Value::Null);
        self.hub.set("uc", json!({ "on": false }));
        self.hub.set("notifs", json!([]));
        self.publish_config();
        self.publish_pairing();
        self.publish_net();
        self.publish_devices();
        self.hub.set("timer", Value::Null);
        self.hub.set("art", Value::Null);
        self.hub.set("received", json!([]));
    }

    pub fn publish_config(&self) {
        let (macros, mut settings) = {
            let c = self.store.read();
            (serde_json::to_value(&c.macros).unwrap(), serde_json::to_value(&c.settings).unwrap())
        };
        if let Some(a) = self.host.autostart() {
            settings["autostart"] = json!(a);
        }
        self.hub.set("macros", macros);
        self.hub.set("settings", settings);
    }

    pub fn publish_pairing(&self) {
        let o = self.pairing.current();
        let port = self.port();
        let addrs = crate::net::addrs();
        let (id, name, relay, room) = {
            let c = self.store.read();
            (c.pc_id.clone(), c.pc_name.clone(), c.settings.relay_url.clone(), c.room())
        };
        let bt = crate::bt::address(self);
        let hosts: Vec<&str> = addrs.iter().take(4).map(|a| a.ip.as_str()).collect();
        let first = hosts.first().copied().unwrap_or("127.0.0.1");
        let enc = |s: &str| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string();
        // QR v2: открывается и системной камерой — страница пульта сама прочитает всё из #.
        // Кроме секрета — все маршруты до ПК: адреса в сети, ретранслятор (для разных сетей), Bluetooth.
        let mut url = format!("http://{first}:{port}/#v=2&pair={}&pc={id}&h={}&p={port}&n={}", b64url(&o.secret), hosts.join(","), enc(&name));
        if !relay.is_empty() {
            url.push_str(&format!("&r={}&rm={room}", enc(&relay)));
        }
        if let Some(addr) = bt {
            url.push_str(&format!("&bt={addr}"));
        }
        self.hub.set("pairing", json!({ "url": url, "pin": o.pin, "expires": o.expires_ms, "hosts": hosts, "port": port }));
    }

    /// Маршруты до ПК для сопряжённых телефонов: если сеть сменится, телефон найдёт ПК другим путём.
    pub fn publish_routes(&self) {
        let c = self.store.read();
        let relay = (!c.settings.relay_url.is_empty()).then(|| json!({ "url": c.settings.relay_url, "room": c.room() }));
        let lan: Vec<String> = crate::net::addrs().into_iter().map(|a| a.ip).collect();
        let bt = crate::bt::address(self);
        self.hub.set("routes", json!({ "lan": lan, "port": self.port(), "relay": relay, "ice": c.settings.ice_servers, "bt": bt }));
    }

    pub fn publish_net(&self) {
        let public = self.platform.network_public();
        self.hub.set("net", json!({ "addrs": crate::net::addrs(), "port": self.port(), "public": public }));
    }

    pub fn publish_devices(&self) {
        let online: HashMap<String, Value> = self
            .sessions
            .lock()
            .values()
            .filter_map(|s| {
                let d = s.device.clone()?;
                Some((d, json!({ "addr": s.peer, "rtt": s.rtt.load(Ordering::Relaxed), "via": s.via, "p2p": s.p2p.load(Ordering::Relaxed) })))
            })
            .collect();
        let devs: Vec<Value> = self
            .store
            .read()
            .devices
            .iter()
            .map(|d| {
                let on = online.get(&d.id);
                json!({ "id": d.id, "name": d.name, "perms": d.perms, "paired_at": d.paired_at, "last_seen": d.last_seen,
                        "online": on.is_some(), "addr": on.map(|o| o["addr"].clone()), "rtt": on.map(|o| o["rtt"].clone()),
                        "via": on.map(|o| o["via"].clone()), "p2p": on.map(|o| o["p2p"].clone()) })
            })
            .collect();
        self.hub.set("devices", Value::Array(devs));
    }

    pub fn handle_event(&self, ev: Event) {
        match ev {
            Event::Volume { level, muted } => {
                let level = (level * 1000.0).round() / 1000.0;
                self.hub.set("vol", json!({ "level": level, "muted": muted, "seq": self.vol_seq.load(Ordering::Relaxed) }));
            }
            Event::Media(m) => match m {
                Some(mut m) => {
                    let art = m.art.take();
                    m.position = m.position.round();
                    self.hub.set("media", serde_json::to_value(&m).unwrap());
                    // None — обложка не менялась, "" — у трека её нет
                    if let Some(a) = art {
                        self.hub.set("art", if a.is_empty() { Value::Null } else { Value::String(a) });
                    }
                }
                None => {
                    self.hub.set("media", Value::Null);
                    self.hub.set("art", Value::Null);
                }
            },
            Event::Window { title, app } => self.hub.set("win", json!({ "title": title, "app": app })),
            Event::Capture(ev) => self.uc_event(ev),
            Event::Clipboard(clip) => {
                let from_phone = matches!(&clip, Clip::Text(t) if self.clip_echo.lock().as_deref() == Some(t.as_str()));
                *self.last_clip.lock() = Some(clip.clone());
                if !self.store.read().settings.clip_sync && !from_phone {
                    return;
                }
                let seq = self.clip_seq.fetch_add(1, Ordering::Relaxed) + 1;
                let v = match clip {
                    Clip::Text(t) => {
                        let text: String = t.chars().take(32 * 1024).collect();
                        json!({ "seq": seq, "kind": "text", "text": text, "from": if from_phone { "phone" } else { "pc" } })
                    }
                    Clip::Files(f) => {
                        json!({ "seq": seq, "kind": "files", "files": f.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string())).collect::<Vec<_>>(), "from": "pc" })
                    }
                };
                self.hub.set("clip", v);
            }
        }
    }

    /// Нагрузка ПК раз в секунду.
    pub fn sys_loop(self: Arc<Self>) {
        std::thread::Builder::new()
            .name("dotlink-sys".into())
            .spawn(move || {
                let mut sys = sysinfo::System::new();
                loop {
                    sys.refresh_cpu_usage();
                    sys.refresh_memory();
                    let r2 = |x: f32| ((x / 100.0).clamp(0.0, 1.0) * 100.0).round() / 100.0;
                    let cores: Vec<f32> = sys.cpus().iter().map(|c| r2(c.cpu_usage())).collect();
                    self.hub.set(
                        "sys",
                        json!({
                            "cpu": r2(sys.global_cpu_usage()), "cores": cores,
                            "mem_used": sys.used_memory(), "mem_total": sys.total_memory(),
                            "uptime": sysinfo::System::uptime(), "battery": self.platform.battery(),
                        }),
                    );
                    std::thread::sleep(Duration::from_secs(1));
                }
            })
            .ok();
    }

    // ───────── сессии ─────────

    pub fn register(&self, info: SessionInfo) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let dev = info.device.clone();
        self.sessions.lock().insert(id, info);
        if let Some(d) = dev {
            self.touch_device(&d);
        }
        id
    }

    pub fn unregister(&self, id: u64) {
        let s = self.sessions.lock().remove(&id);
        if let Some(d) = s.and_then(|s| s.device) {
            self.touch_device(&d);
        }
    }

    fn touch_device(&self, id: &str) {
        self.store.update(|c| {
            if let Some(d) = c.devices.iter_mut().find(|d| d.id == id) {
                d.last_seen = now_ms();
            }
        });
        self.publish_devices();
    }

    pub fn send_device(&self, device: &str, out: impl Fn() -> Out) -> bool {
        let mut sent = false;
        for s in self.sessions.lock().values().filter(|s| s.device.as_deref() == Some(device)) {
            sent |= s.tx.try_send(out()).is_ok();
        }
        sent
    }

    fn send_admins(&self, out: impl Fn() -> Out) {
        for s in self.sessions.lock().values().filter(|s| s.device.is_none()) {
            let _ = s.tx.try_send(out());
        }
    }

    pub fn device_online(&self, device: &str) -> bool {
        self.sessions.lock().values().any(|s| s.device.as_deref() == Some(device))
    }

    /// Последний подключившийся телефон — цель по умолчанию для трансляции и мыши ПК.
    pub fn latest_device(&self) -> Option<String> {
        self.sessions.lock().values().filter(|s| s.device.is_some()).max_by_key(|s| s.since).and_then(|s| s.device.clone())
    }

    pub fn add_device(&self, name: &str, key: &[u8; 32]) -> Device {
        let d = Device {
            id: b64url(&crate::crypto::random::<9>()),
            name: name.into(),
            key: crate::util::b64(key),
            perms: Perms::default(),
            paired_at: now_ms(),
            last_seen: now_ms(),
        };
        self.store.update(|c| c.devices.push(d.clone()));
        self.publish_devices();
        if self.store.read().settings.notify {
            self.host.notify("DotLink", &format!("Подключено новое устройство: {name}"));
        }
        d
    }

    // ───────── действия ─────────

    // ───────── экран телефона на ПК ─────────

    /// Кадр видео с телефона → всем открытым дашбордам (крупные кадры — основным каналом).
    pub fn mirror_frame(&self, device: &str, frame: Vec<u8>) {
        let on = matches!(self.hub.get("mirror").as_deref(), Some(v) if v["device"] == device);
        if on {
            self.send_admins(|| Out::Bulk(frame.clone()));
        }
    }

    pub fn mirror_state(&self, device: &str, on: bool, w: u32, h: u32, codec: &str) {
        let name = self.store.device(device).map(|d| d.name).unwrap_or_default();
        self.hub.set("mirror", if on { json!({ "device": device, "name": name, "w": w, "h": h, "codec": codec }) } else { Value::Null });
    }

    // ───────── уведомления и ссылки ─────────

    pub fn phone_notification(&self, device: &str, app: &str, title: &str, text: &str) {
        let name = self.store.device(device).map(|d| d.name).unwrap_or_else(|| "Телефон".into());
        let cut = |s: &str, n: usize| s.chars().take(n).collect::<String>();
        let n = json!({ "device": name, "app": cut(app, 60), "title": cut(title, 120), "text": cut(text, 400), "at": now_ms() });
        let list = {
            let mut l = self.notifs.lock();
            l.insert(0, n);
            l.truncate(30);
            Value::Array(l.clone())
        };
        self.hub.set("notifs", list);
        if self.store.read().settings.phone_notifications {
            let head = if title.is_empty() { app.to_string() } else { format!("{app} · {title}") };
            self.host.notify(&cut(&head, 80), &cut(text, 200));
        }
    }

    /// Ссылка с телефона открывается на ПК — только безопасные схемы.
    pub fn open_url_from_phone(&self, url: &str) -> anyhow::Result<()> {
        let u = url.trim();
        let lower = u.to_ascii_lowercase();
        if !["http://", "https://", "mailto:", "tel:"].iter().any(|p| lower.starts_with(p)) || u.len() > 4096 || u.chars().any(char::is_control) {
            anyhow::bail!("открываются только ссылки http(s), mailto и tel");
        }
        self.platform.open(u, "")
    }

    // ───────── мышь и клавиатура ПК на телефоне ─────────

    pub fn uc_start(&self, device: Option<String>) -> anyhow::Result<()> {
        let Some(d) = device.or_else(|| self.latest_device()) else { anyhow::bail!("нет подключённого телефона") };
        if !self.device_online(&d) {
            anyhow::bail!("телефон не в сети");
        }
        self.uc.lock().device = Some(d.clone());
        self.platform.capture(true);
        self.send_device(&d, || Out::Json(json!({ "t": "uc", "on": true, "edge": self.store.read().settings.uc_edge })));
        let name = self.store.device(&d).map(|x| x.name).unwrap_or_default();
        self.hub.set("uc", json!({ "on": true, "device": d, "name": name }));
        Ok(())
    }

    pub fn uc_stop(&self) {
        let prev = self.uc.lock().device.take();
        self.platform.capture(false);
        if let Some(d) = prev {
            self.send_device(&d, || Out::Json(json!({ "t": "uc", "on": false })));
        }
        self.hub.set("uc", json!({ "on": false }));
    }

    fn uc_event(&self, ev: CaptureEv) {
        let target = self.uc.lock().device.clone();
        match (ev, target) {
            (CaptureEv::Edge | CaptureEv::Toggle, None) => {
                if let Err(e) = self.uc_start(None) {
                    tracing::debug!("мышь на телефон: {e}");
                    self.platform.capture(false);
                }
            }
            (CaptureEv::Toggle | CaptureEv::Exit, Some(_)) => self.uc_stop(),
            (CaptureEv::Edge, Some(_)) => {}
            (_, None) => {}
            (CaptureEv::Move(dx, dy), Some(d)) => {
                let c = |v: i32| v.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                if !self.send_device(&d, || Out::Fast(proto::uc_move(c(dx), c(dy)))) && !self.device_online(&d) {
                    self.uc_stop();
                }
            }
            (CaptureEv::Button(b, down), Some(d)) => {
                let b = match b {
                    MouseButton::Left => 0,
                    MouseButton::Right => 1,
                    MouseButton::Middle => 2,
                    MouseButton::X1 => 3,
                    MouseButton::X2 => 4,
                };
                self.send_device(&d, || Out::Bin(proto::uc_button(b, down)));
            }
            (CaptureEv::Scroll(v, h), Some(d)) => {
                let c = |x: i32| x.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                self.send_device(&d, || Out::Bin(proto::uc_scroll(c(v), c(h))));
            }
            (CaptureEv::Key { vk, down }, Some(d)) => {
                self.send_device(&d, || Out::Json(json!({ "t": "uc-key", "vk": vk, "down": down })));
            }
            (CaptureEv::Text(t), Some(d)) => {
                self.send_device(&d, || Out::Json(json!({ "t": "uc-text", "text": t })));
            }
        }
    }

    /// Команда телефону от дашборда: жесты, кнопки «Назад/Домой», текст, трансляция.
    fn to_phone(&self, v: &Value, msg: Value) -> Result<(), String> {
        let d = v["device"].as_str().map(String::from).or_else(|| self.latest_device()).ok_or("нет подключённого телефона")?;
        if self.send_device(&d, || Out::Json(msg.clone())) {
            Ok(())
        } else {
            Err("телефон не в сети".into())
        }
    }

    pub fn set_volume_from(&self, level: f32, seq: u16) {
        self.vol_seq.store(seq, Ordering::Relaxed);
        self.platform.set_volume(level);
    }

    pub fn set_clipboard_text(&self, text: String) -> anyhow::Result<()> {
        *self.clip_echo.lock() = Some(text.clone());
        self.platform.set_clipboard(Clip::Text(text))
    }

    pub fn set_timer(self: &Arc<Self>, action: PowerAction, sec: u32) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let ends_at = now_ms() + sec as u64 * 1000;
        *self.timer.lock() = Some(Timer { id, action, ends_at, total: sec });
        self.publish_timer();
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(sec as u64)).await;
            let fire = matches!(&*me.timer.lock(), Some(t) if t.id == id);
            if fire {
                *me.timer.lock() = None;
                me.publish_timer();
                if let Err(e) = me.platform.power(action) {
                    tracing::warn!("таймер: {e:#}");
                }
            }
        });
    }

    pub fn cancel_timer(&self) {
        *self.timer.lock() = None;
        self.publish_timer();
    }

    fn publish_timer(&self) {
        let v = match &*self.timer.lock() {
            Some(t) => json!({ "action": t.action, "ends_at": t.ends_at, "total": t.total, "now": now_ms() }),
            None => Value::Null,
        };
        self.hub.set("timer", v);
    }

    pub fn run_macro(self: &Arc<Self>, id: &str) -> anyhow::Result<()> {
        let m = self.store.read().macros.iter().find(|m| m.id == id).cloned().ok_or_else(|| anyhow::anyhow!("макрос не найден"))?;
        let p = self.platform.clone();
        // шаги с паузами — не в потоке сессии
        std::thread::spawn(move || {
            if let Err(e) = run_macro_steps(&*p, &m) {
                tracing::warn!("макрос {}: {e:#}", m.name);
            }
        });
        Ok(())
    }

    /// Предложить файл телефону: он получит ссылку для скачивания.
    pub fn offer_file(&self, device: &str, path: PathBuf, name: String, size: u64) -> bool {
        let t = self.files.issue(Ticket::Download { path, name: name.clone() });
        self.send_device(device, || Out::Json(json!({ "t": "file-offer", "name": name, "size": size, "url": format!("/api/download/{t}") })))
    }

    /// Файлы из буфера ПК → предложения на скачивание этому сеансу.
    pub fn clip_file_offers(&self) -> Vec<Value> {
        let Some(Clip::Files(files)) = self.last_clip.lock().clone() else { return vec![] };
        files
            .into_iter()
            .filter(|p| p.is_file())
            .take(20)
            .map(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let t = self.files.issue(Ticket::Download { path: p, name: name.clone() });
                json!({ "t": "file-offer", "name": name, "size": size, "url": format!("/api/download/{t}") })
            })
            .collect()
    }

    pub fn add_outbox(&self, path: PathBuf, name: String, size: u64) -> String {
        let id = b64url(&crate::crypto::random::<9>());
        self.outbox.lock().insert(id.clone(), (path, name, size));
        id
    }

    pub fn received(&self, r: crate::files::Received) {
        if self.store.read().settings.notify {
            self.host.notify("DotLink", &format!("Принят файл «{}» от {}", r.name, r.from));
        }
        self.files.note_received(r);
        self.hub.set("received", serde_json::to_value(&*self.files.received.lock()).unwrap());
    }

    pub fn session_rtt(&self) {
        self.publish_devices();
    }

    // ───────── команды дашборда ─────────

    pub fn admin_cmd(self: &Arc<Self>, v: &Value) -> Value {
        let t = v["t"].as_str().unwrap_or("");
        let ok = |m: &str| json!({ "t": "ok", "for": t, "msg": m });
        let err = |m: String| json!({ "t": "error", "for": t, "msg": m });
        match t {
            "pair-refresh" => {
                self.pairing.refresh();
                self.publish_pairing();
                ok("")
            }
            "device-perms" => {
                let (Some(id), Ok(perms)) = (v["id"].as_str(), serde_json::from_value::<Perms>(v["perms"].clone())) else {
                    return err("неверные права".into());
                };
                self.store.update(|c| c.devices.iter_mut().filter(|d| d.id == id).for_each(|d| d.perms = perms.clone()));
                self.send_device(id, || Out::Perms(perms.clone()));
                self.publish_devices();
                ok("Права обновлены")
            }
            "device-rename" => {
                let (Some(id), Some(name)) = (v["id"].as_str(), v["name"].as_str()) else { return err("нет имени".into()) };
                let name: String = name.trim().chars().take(40).collect();
                self.store.update(|c| c.devices.iter_mut().filter(|d| d.id == id).for_each(|d| d.name = name.clone()));
                self.publish_devices();
                ok("")
            }
            "device-remove" => {
                let Some(id) = v["id"].as_str() else { return err("нет устройства".into()) };
                self.store.update(|c| c.devices.retain(|d| d.id != id));
                self.send_device(id, || Out::Close("revoked"));
                self.publish_devices();
                ok("Устройство отключено")
            }
            "macros-save" => match serde_json::from_value::<Vec<Macro>>(v["macros"].clone()) {
                Ok(mut ms) => {
                    ms.retain(|m| !m.name.trim().is_empty());
                    for m in ms.iter_mut().filter(|m| m.id.is_empty()) {
                        m.id = b64url(&crate::crypto::random::<6>());
                    }
                    self.store.update(|c| c.macros = ms);
                    self.publish_config();
                    ok("Макросы сохранены")
                }
                Err(e) => err(format!("макросы: {e}")),
            },
            "macro-run" => match self.run_macro(v["id"].as_str().unwrap_or("")) {
                Ok(()) => ok(""),
                Err(e) => err(e.to_string()),
            },
            "settings-save" => match serde_json::from_value::<Settings>(v["settings"].clone()) {
                Ok(s) => {
                    let auto = s.autostart;
                    self.platform.set_edge(&s.uc_edge);
                    self.settings_tx.send_replace(s.clone());
                    self.store.update(|c| c.settings = s);
                    let r = self.host.set_autostart(auto);
                    self.publish_config();
                    self.publish_routes();
                    self.publish_pairing();
                    match r {
                        Ok(()) => ok("Настройки сохранены"),
                        Err(e) => err(format!("автозапуск: {e}")),
                    }
                }
                Err(e) => err(format!("настройки: {e}")),
            },
            "pc-rename" => {
                let name: String = v["name"].as_str().unwrap_or("").trim().chars().take(40).collect();
                if name.is_empty() {
                    return err("пустое имя".into());
                }
                self.store.update(|c| c.pc_name = name);
                self.hub.set("pc", self.pc_info());
                self.publish_pairing();
                ok("")
            }
            "firewall-fix" => match self.platform.allow_firewall() {
                Ok(()) => {
                    self.publish_net();
                    ok("Правило брандмауэра добавлено")
                }
                Err(e) => err(format!("брандмауэр: {e}")),
            },
            "offer-file" => {
                let (Some(dev), Some(fid)) = (v["device"].as_str(), v["file"].as_str()) else { return err("нет файла".into()) };
                let Some((path, name, size)) = self.outbox.lock().get(fid).cloned() else { return err("файл не найден".into()) };
                if self.offer_file(dev, path, name, size) {
                    ok("Файл отправлен на телефон")
                } else {
                    err("телефон не в сети".into())
                }
            }
            "open-folder" => match self.platform.open(&self.platform.downloads_dir().to_string_lossy(), "") {
                Ok(()) => ok(""),
                Err(e) => err(e.to_string()),
            },
            "save-qr-file" => {
                // файл, принятый дашбордом по QR с телефона, уже лежит в outbox — переносим в «Загрузки»
                let Some(fid) = v["file"].as_str() else { return err("нет файла".into()) };
                let Some((path, name, size)) = self.outbox.lock().remove(fid) else { return err("файл не найден".into()) };
                let dir = self.platform.downloads_dir();
                let _ = std::fs::create_dir_all(&dir);
                let dst = crate::files::unique_path(&dir, &name);
                match std::fs::rename(&path, &dst).or_else(|_| std::fs::copy(&path, &dst).map(|_| ())) {
                    Ok(()) => {
                        self.received(crate::files::Received { name, size, from: "QR".into(), at: now_ms(), path: dst.to_string_lossy().into() });
                        ok("Файл сохранён")
                    }
                    Err(e) => err(e.to_string()),
                }
            }
            "timer-cancel" => {
                self.cancel_timer();
                ok("")
            }
            "mirror-start" | "mirror-stop" | "mirror-key" => {
                let msg = json!({ "t": "mirror-req", "on": t != "mirror-stop", "key": t == "mirror-key", "bitrate": v["bitrate"], "max": v["max"] });
                match self.to_phone(v, msg) {
                    Ok(()) => ok(if t == "mirror-start" { "Запрос отправлен — подтвердите трансляцию на телефоне" } else { "" }),
                    Err(e) => err(e),
                }
            }
            // жест или кнопка на экране телефона: tap, long, swipe, scroll, back, home, recents, notifications, text, key
            "phone-ctl" => match self.to_phone(v, json!({ "t": "ctl", "a": v["a"], "x": v["x"], "y": v["y"], "x2": v["x2"], "y2": v["y2"], "ms": v["ms"], "path": v["path"], "text": v["text"], "key": v["key"] })) {
                Ok(()) => json!({ "t": "ok", "for": t }),
                Err(e) => err(e),
            },
            "phone-open-url" => {
                let url = v["url"].as_str().unwrap_or("").trim().to_string();
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return err("нужна ссылка http(s)".into());
                }
                match self.to_phone(v, json!({ "t": "open-url", "url": url })) {
                    Ok(()) => ok("Открыто на телефоне"),
                    Err(e) => err(e),
                }
            }
            "phone-text" => match self.to_phone(v, json!({ "t": "clip-push", "text": v["text"] })) {
                Ok(()) => ok("Текст на телефоне"),
                Err(e) => err(e),
            },
            "uc-start" => match self.uc_start(v["device"].as_str().map(String::from)) {
                Ok(()) => ok("Мышь и клавиатура ПК — на телефоне. Вернуться: Esc или Ctrl+Alt+←"),
                Err(e) => err(e.to_string()),
            },
            "uc-stop" => {
                self.uc_stop();
                ok("")
            }
            "notifs-clear" => {
                self.notifs.lock().clear();
                self.hub.set("notifs", json!([]));
                ok("")
            }
            _ => err(format!("неизвестная команда {t}")),
        }
    }
}

/// Шаги макроса «Клавиши»: `ctrl+shift+esc`, `wait 300`, `text: привет`, `open notepad` — через «;» или с новой строки.
pub fn run_macro_steps(p: &dyn Platform, m: &Macro) -> anyhow::Result<()> {
    match m.kind {
        MacroKind::App => p.open(m.value.trim(), ""),
        MacroKind::Url => p.open(m.value.trim(), ""),
        MacroKind::Shell => p.shell(&m.value),
        MacroKind::Text => {
            p.text(&m.value);
            Ok(())
        }
        MacroKind::Keys => {
            for step in m.value.split(['\n', ';']).map(str::trim).filter(|s| !s.is_empty()) {
                let low = step.to_lowercase();
                if let Some(ms) = low.strip_prefix("wait").map(|s| s.trim().trim_end_matches("ms").trim()) {
                    std::thread::sleep(Duration::from_millis(ms.parse::<u64>().unwrap_or(200).min(10_000)));
                    continue;
                }
                if low.starts_with("text:") {
                    p.text(step[5..].trim_start());
                } else if low.starts_with("open ") {
                    p.open(step[5..].trim(), "")?;
                } else {
                    let vks: Option<Vec<u16>> = step.split('+').map(vk::by_name).collect();
                    let vks = vks.ok_or_else(|| anyhow::anyhow!("непонятный шаг «{step}»"))?;
                    p.chord(&vks);
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::mock::MockPlatform;

    #[test]
    fn macro_steps() {
        let p = MockPlatform::new();
        let m =
            Macro { id: "x".into(), name: "x".into(), icon: "bolt".into(), kind: MacroKind::Keys, value: "win+r; wait 10\ntext: notepad, hi\nenter".into() };
        run_macro_steps(&p, &m).unwrap();
        let log = p.debug_log().unwrap().to_string();
        assert!(log.contains(r#""chord":[91,82]"#), "{log}");
        assert!(log.contains("notepad, hi"));
        assert!(log.contains(r#""chord":[13]"#));
        let bad = Macro { value: "ctrl+nope".into(), ..m };
        assert!(run_macro_steps(&p, &bad).is_err());
    }
}
