//! Настройки, сопряжённые устройства и макросы. Хранятся в `config.json` в папке данных
//! (%APPDATA%\DotLink на Windows), запись атомарная: временный файл + переименование.

use parking_lot::{RwLock, RwLockReadGuard};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Perms {
    pub input: bool,
    pub media: bool,
    pub power: bool,
    pub macros: bool,
    pub clipboard: bool,
    pub files: bool,
}

impl Default for Perms {
    fn default() -> Self {
        Self { input: true, media: true, power: true, macros: true, clipboard: true, files: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// ключ устройства, base64
    pub key: String,
    #[serde(default)]
    pub perms: Perms,
    pub paired_at: u64,
    #[serde(default)]
    pub last_seen: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MacroKind {
    /// сочетания и шаги: `ctrl+shift+esc`, `wait 300`, `text: привет`, `open notepad` — через «;» или с новой строки
    Keys,
    /// программа или файл (ShellExecute)
    App,
    Url,
    /// команда PowerShell
    Shell,
    /// напечатать текст
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Macro {
    pub id: String,
    pub name: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    pub kind: MacroKind,
    pub value: String,
}

fn default_icon() -> String {
    "bolt".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub autostart: bool,
    /// отправлять телефону содержимое буфера ПК при копировании
    pub clip_sync: bool,
    /// уведомлять на ПК о подключении устройств и принятых файлах
    pub notify: bool,
    pub port: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self { autostart: true, clip_sync: true, notify: true, port: 47800 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub pc_id: String,
    pub pc_name: String,
    pub devices: Vec<Device>,
    pub macros: Vec<Macro>,
    pub settings: Settings,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            pc_id: crate::util::b64url(&crate::crypto::random::<9>()),
            pc_name: crate::util::hostname(),
            devices: vec![],
            macros: default_macros(),
            settings: Settings::default(),
        }
    }
}

pub fn default_macros() -> Vec<Macro> {
    let m = |id: &str, name: &str, icon: &str, kind, value: &str| Macro { id: id.into(), name: name.into(), icon: icon.into(), kind, value: value.into() };
    vec![
        m("taskmgr", "Диспетчер задач", "cpu", MacroKind::Keys, "ctrl+shift+esc"),
        m("explorer", "Проводник", "files", MacroKind::Keys, "win+e"),
        m("desktop", "Рабочий стол", "desktop", MacroKind::Keys, "win+d"),
        m("tasks", "Все окна", "apps", MacroKind::Keys, "win+tab"),
        m("snip", "Скриншот", "scan", MacroKind::Keys, "win+shift+s"),
        m("terminal", "Терминал", "terminal", MacroKind::App, "wt.exe"),
    ]
}

pub struct Store {
    path: Option<PathBuf>,
    cfg: RwLock<Config>,
}

impl Store {
    /// `dir = None` — только в памяти (тесты).
    pub fn open(dir: Option<&Path>) -> anyhow::Result<Self> {
        let path = dir.map(|d| d.join("config.json"));
        let cfg = match &path {
            Some(p) if p.exists() => match std::fs::read(p).ok().and_then(|b| serde_json::from_slice::<Config>(&b).ok()) {
                Some(c) => c,
                None => {
                    // повреждённый файл не теряем: откладываем в сторону и начинаем заново
                    let _ = std::fs::rename(p, p.with_extension("json.broken"));
                    Config::default()
                }
            },
            _ => Config::default(),
        };
        let s = Self { path, cfg: RwLock::new(cfg) };
        s.save()?;
        Ok(s)
    }

    pub fn read(&self) -> RwLockReadGuard<'_, Config> {
        self.cfg.read()
    }

    pub fn update<R>(&self, f: impl FnOnce(&mut Config) -> R) -> R {
        let r = f(&mut self.cfg.write());
        if let Err(e) = self.save() {
            tracing::warn!("не удалось сохранить настройки: {e:#}");
        }
        r
    }

    fn save(&self) -> anyhow::Result<()> {
        let Some(p) = &self.path else { return Ok(()) };
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d)?;
        }
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&*self.cfg.read())?)?;
        std::fs::rename(&tmp, p)?;
        Ok(())
    }

    pub fn device(&self, id: &str) -> Option<Device> {
        self.read().devices.iter().find(|d| d.id == id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_recovers_from_garbage() {
        let dir = std::env::temp_dir().join(format!("dotlink-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::open(Some(&dir)).unwrap();
        let id = s.read().pc_id.clone();
        s.update(|c| c.settings.clip_sync = false);
        drop(s);
        let s = Store::open(Some(&dir)).unwrap();
        assert_eq!(s.read().pc_id, id);
        assert!(!s.read().settings.clip_sync);
        drop(s);
        std::fs::write(dir.join("config.json"), b"{oops").unwrap();
        let s = Store::open(Some(&dir)).unwrap();
        assert_ne!(s.read().pc_id, id);
        assert!(dir.join("config.json.broken").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
