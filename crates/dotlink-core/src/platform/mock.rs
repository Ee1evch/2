//! Имитация ПК: записывает действия в журнал и правдоподобно меняет состояние.
//! Нужна для тестов, разработки на Linux/macOS и демонстрации интерфейса без Windows.

use super::*;
use parking_lot::Mutex;
use std::time::{Duration, Instant};

pub struct MockPlatform {
    log: Mutex<Vec<(u128, serde_json::Value)>>,
    t0: Instant,
    state: Arc<Mutex<MockState>>,
    tx: Mutex<Option<Sender<Event>>>,
    dir: PathBuf,
}

struct MockState {
    volume: f32,
    muted: bool,
    media: MediaInfo,
    clipboard: Option<Clip>,
}

impl Default for MockPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl MockPlatform {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join("dotlink-mock-downloads");
        Self {
            log: Mutex::new(Vec::new()),
            t0: Instant::now(),
            state: Arc::new(Mutex::new(MockState {
                volume: 0.42,
                muted: false,
                media: MediaInfo {
                    title: "Midnight City".into(),
                    artist: "M83".into(),
                    album: "Hurry Up, We're Dreaming".into(),
                    app: "Spotify".into(),
                    playing: true,
                    position: 12.0,
                    duration: 243.0,
                    art: None,
                },
                clipboard: None,
            })),
            tx: Mutex::new(None),
            dir,
        }
    }

    fn rec(&self, v: serde_json::Value) {
        let mut l = self.log.lock();
        if l.len() > 5000 {
            l.drain(..1000);
        }
        l.push((self.t0.elapsed().as_micros(), v));
    }

    fn emit(&self, e: Event) {
        if let Some(tx) = self.tx.lock().as_ref() {
            let _ = tx.send(e);
        }
    }
}

impl Platform for MockPlatform {
    fn name(&self) -> &'static str {
        "mock"
    }
    fn mouse_move(&self, dx: i32, dy: i32) {
        self.rec(serde_json::json!({"move": [dx, dy]}));
    }
    fn mouse_button(&self, button: MouseButton, action: ButtonAction) {
        self.rec(serde_json::json!({"button": format!("{:?}", button), "action": format!("{:?}", action)}));
    }
    fn scroll(&self, vertical: i32, horizontal: i32) {
        self.rec(serde_json::json!({"scroll": [vertical, horizontal]}));
    }
    fn key(&self, vk: u16, action: KeyAction) {
        self.rec(serde_json::json!({"key": vk, "action": format!("{:?}", action)}));
    }
    fn chord(&self, vks: &[u16]) {
        self.rec(serde_json::json!({"chord": vks}));
    }
    fn text(&self, text: &str) {
        self.rec(serde_json::json!({"text": text}));
    }
    fn set_volume(&self, level: f32) {
        self.rec(serde_json::json!({"volume": level}));
        let muted = {
            let mut s = self.state.lock();
            s.volume = level.clamp(0.0, 1.0);
            s.muted
        };
        self.emit(Event::Volume { level: level.clamp(0.0, 1.0), muted });
    }
    fn set_mute(&self, muted: bool) {
        self.rec(serde_json::json!({"mute": muted}));
        let level = {
            let mut s = self.state.lock();
            s.muted = muted;
            s.volume
        };
        self.emit(Event::Volume { level, muted });
    }
    fn media(&self, action: MediaAction) {
        self.rec(serde_json::json!({"media": action}));
        let m = {
            let mut s = self.state.lock();
            match action {
                MediaAction::Toggle => s.media.playing = !s.media.playing,
                MediaAction::Play => s.media.playing = true,
                MediaAction::Pause | MediaAction::Stop => s.media.playing = false,
                MediaAction::Next | MediaAction::Prev => {
                    const TRACKS: [(&str, &str, f64); 3] = [("Midnight City", "M83", 243.0), ("Intro", "The xx", 128.0), ("Nightcall", "Kavinsky", 258.0)];
                    let i = TRACKS.iter().position(|t| t.0 == s.media.title).unwrap_or(0);
                    let j = if action == MediaAction::Next { (i + 1) % 3 } else { (i + 2) % 3 };
                    s.media.title = TRACKS[j].0.into();
                    s.media.artist = TRACKS[j].1.into();
                    s.media.duration = TRACKS[j].2;
                    s.media.position = 0.0;
                    s.media.playing = true;
                }
            }
            s.media.clone()
        };
        self.emit(Event::Media(Some(m)));
    }
    fn power(&self, action: PowerAction) -> anyhow::Result<()> {
        self.rec(serde_json::json!({"power": action}));
        Ok(())
    }
    fn open(&self, target: &str, args: &str) -> anyhow::Result<()> {
        self.rec(serde_json::json!({"open": target, "args": args}));
        Ok(())
    }
    fn shell(&self, command: &str) -> anyhow::Result<()> {
        self.rec(serde_json::json!({"shell": command}));
        Ok(())
    }
    fn set_clipboard(&self, clip: Clip) -> anyhow::Result<()> {
        self.rec(match &clip {
            Clip::Text(t) => serde_json::json!({"clipboard": t}),
            Clip::Files(f) => serde_json::json!({"clipboard_files": f}),
        });
        self.state.lock().clipboard = Some(clip.clone());
        self.emit(Event::Clipboard(clip));
        Ok(())
    }
    fn battery(&self) -> Option<Battery> {
        Some(Battery { percent: 76, charging: true })
    }

    fn start(&self, tx: Sender<Event>) {
        {
            let s = self.state.lock();
            let _ = tx.send(Event::Volume { level: s.volume, muted: s.muted });
            let _ = tx.send(Event::Media(Some(s.media.clone())));
        }
        let _ = tx.send(Event::Window { title: "DotLink — README.md".into(), app: "Code".into() });
        *self.tx.lock() = Some(tx.clone());
        // трек идёт, окна изредка меняются
        let state = self.state.clone();
        std::thread::Builder::new()
            .name("mock-pc".into())
            .spawn(move || {
                let windows = [("DotLink — README.md", "Code"), ("YouTube — Chrome", "chrome"), ("Проводник", "explorer")];
                for tick in 0u64.. {
                    std::thread::sleep(Duration::from_secs(1));
                    let m = {
                        let mut s = state.lock();
                        if s.media.playing {
                            s.media.position = (s.media.position + 1.0) % s.media.duration;
                        }
                        s.media.clone()
                    };
                    if tx.send(Event::Media(Some(m))).is_err() {
                        break;
                    }
                    if tick % 20 == 19 {
                        let (t, a) = windows[(tick / 20 % 3) as usize];
                        let _ = tx.send(Event::Window { title: t.into(), app: a.into() });
                    }
                }
            })
            .ok();
    }

    fn capture(&self, on: bool) {
        self.rec(serde_json::json!({ "capture": on }));
    }

    fn downloads_dir(&self) -> PathBuf {
        self.dir.clone()
    }

    fn debug_log(&self) -> Option<serde_json::Value> {
        let l = self.log.lock();
        Some(serde_json::Value::Array(l.iter().map(|(t, v)| serde_json::json!({"t": t, "e": v})).collect()))
    }
}
