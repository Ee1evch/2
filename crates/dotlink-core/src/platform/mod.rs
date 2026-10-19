//! Управление ПК. Ядро говорит с ОС только через `Platform`:
//! на Windows — нативные вызовы (`windows`), в тестах и на Linux — имитация (`mock`).

use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::Arc;

pub use crate::proto::{ButtonAction, KeyAction, MediaAction, MouseButton, PowerAction};
use serde::Serialize;

pub mod mock;
#[cfg(windows)]
pub mod windows;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct MediaInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub app: String,
    pub playing: bool,
    /// секунды
    pub position: f64,
    pub duration: f64,
    /// обложка как data URL (JPEG/PNG), если есть
    #[serde(skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Clip {
    Text(String),
    Files(Vec<PathBuf>),
}

/// События ОС → ядро.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Volume { level: f32, muted: bool },
    Media(Option<MediaInfo>),
    Window { title: String, app: String },
    Clipboard(Clip),
}

pub trait Platform: Send + Sync + 'static {
    fn name(&self) -> &'static str;

    // ввод — горячий путь, должен возвращаться за микросекунды
    fn mouse_move(&self, dx: i32, dy: i32);
    fn mouse_button(&self, button: MouseButton, action: ButtonAction);
    fn scroll(&self, vertical: i32, horizontal: i32);
    fn key(&self, vk: u16, action: KeyAction);
    fn chord(&self, vks: &[u16]);
    fn text(&self, text: &str);

    // медленные операции уходят в рабочие потоки и не блокируют ввод
    fn set_volume(&self, level: f32);
    fn set_mute(&self, muted: bool);
    fn media(&self, action: MediaAction);
    fn power(&self, action: PowerAction) -> anyhow::Result<()>;
    fn open(&self, target: &str, args: &str) -> anyhow::Result<()>;
    fn shell(&self, command: &str) -> anyhow::Result<()>;
    fn set_clipboard(&self, clip: Clip) -> anyhow::Result<()>;
    fn battery(&self) -> Option<Battery>;

    /// Запускает наблюдателей (громкость, медиа, окно, буфер), события идут в `tx`.
    fn start(&self, tx: Sender<Event>);

    fn downloads_dir(&self) -> PathBuf;
    /// `Some(true)`, если Windows считает текущую сеть общественной (брандмауэр закроет порт).
    fn network_public(&self) -> Option<bool> {
        None
    }
    /// Разрешить DotLink в брандмауэре (с запросом прав администратора).
    fn allow_firewall(&self) -> anyhow::Result<()> {
        Ok(())
    }
    /// Журнал имитации — для e2e-тестов; у настоящей платформы его нет.
    fn debug_log(&self) -> Option<serde_json::Value> {
        None
    }
}

pub fn native() -> Arc<dyn Platform> {
    #[cfg(windows)]
    {
        Arc::new(windows::WindowsPlatform::new())
    }
    #[cfg(not(windows))]
    {
        Arc::new(mock::MockPlatform::new())
    }
}
