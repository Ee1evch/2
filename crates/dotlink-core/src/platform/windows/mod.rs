//! Windows: SendInput, Core Audio, GSMTC, питание, буфер обмена, брандмауэр.

mod audio;
mod input;
mod media;
mod system;

use super::*;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use ::windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

pub struct WindowsPlatform {
    input: Arc<input::Input>,
    audio: Mutex<Option<std::sync::mpsc::Sender<audio::Cmd>>>,
    media: Mutex<Option<std::sync::mpsc::Sender<MediaAction>>>,
    net: Arc<AtomicU8>,
}

impl Default for WindowsPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowsPlatform {
    pub fn new() -> Self {
        // координаты курсора в физических пикселях на всех мониторах
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        Self { input: Arc::new(input::Input::new()), audio: Mutex::new(None), media: Mutex::new(None), net: Arc::new(AtomicU8::new(0)) }
    }
}

const MEDIA_VK: [(MediaAction, u16); 5] = [(MediaAction::Toggle, 0xB3), (MediaAction::Play, 0xB3), (MediaAction::Pause, 0xB3), (MediaAction::Next, 0xB0), (MediaAction::Prev, 0xB1)];

impl Platform for WindowsPlatform {
    fn name(&self) -> &'static str {
        "windows"
    }
    fn mouse_move(&self, dx: i32, dy: i32) {
        self.input.mouse_move(dx, dy)
    }
    fn mouse_button(&self, button: MouseButton, action: ButtonAction) {
        self.input.button(button, action)
    }
    fn scroll(&self, vertical: i32, horizontal: i32) {
        self.input.scroll(vertical, horizontal)
    }
    fn key(&self, vk: u16, action: KeyAction) {
        self.input.key(vk, action)
    }
    fn chord(&self, vks: &[u16]) {
        self.input.chord(vks)
    }
    fn text(&self, text: &str) {
        self.input.text(text)
    }
    fn set_volume(&self, level: f32) {
        if let Some(tx) = self.audio.lock().as_ref() {
            let _ = tx.send(audio::Cmd::Set(level));
        }
    }
    fn set_mute(&self, muted: bool) {
        if let Some(tx) = self.audio.lock().as_ref() {
            let _ = tx.send(audio::Cmd::Mute(muted));
        }
    }
    fn media(&self, action: MediaAction) {
        if let Some(tx) = self.media.lock().as_ref() {
            let _ = tx.send(action);
        }
    }
    fn power(&self, action: PowerAction) -> anyhow::Result<()> {
        system::power(action)
    }
    fn open(&self, target: &str, args: &str) -> anyhow::Result<()> {
        system::open(target, args)
    }
    fn shell(&self, command: &str) -> anyhow::Result<()> {
        system::shell(command)
    }
    fn set_clipboard(&self, clip: Clip) -> anyhow::Result<()> {
        system::set_clipboard(&clip)
    }
    fn battery(&self) -> Option<Battery> {
        system::battery()
    }
    fn start(&self, tx: Sender<Event>) {
        let (atx, arx) = std::sync::mpsc::channel();
        *self.audio.lock() = Some(atx);
        audio::spawn(tx.clone(), arx);
        let (mtx, mrx) = std::sync::mpsc::channel();
        *self.media.lock() = Some(mtx);
        let input = self.input.clone();
        media::spawn(tx.clone(), mrx, move |a| {
            if let Some((_, vk)) = MEDIA_VK.iter().find(|(m, _)| *m == a) {
                input.key(*vk, KeyAction::Press);
            }
        });
        system::spawn_watchers(tx, self.net.clone());
    }
    fn downloads_dir(&self) -> PathBuf {
        dirs::download_dir().or_else(dirs::home_dir).unwrap_or_else(std::env::temp_dir).join("DotLink")
    }
    fn network_public(&self) -> Option<bool> {
        match self.net.load(Ordering::Relaxed) {
            1 => Some(false),
            2 => Some(true),
            _ => None,
        }
    }
    fn allow_firewall(&self) -> anyhow::Result<()> {
        system::allow_firewall()
    }
}
