//! Передача файлов по сети: одноразовые билеты на загрузку и скачивание (живут 2 минуты).
//! Сам файл идёт отдельным HTTP-запросом — не через канал ввода, чтобы не задерживать мышь.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const TICKET_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Debug)]
pub enum Ticket {
    Upload { name: String, size: Option<u64>, from: String },
    Download { path: PathBuf, name: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct Received {
    pub name: String,
    pub size: u64,
    pub from: String,
    pub at: u64,
    pub path: String,
}

#[derive(Default)]
pub struct Files {
    tickets: Mutex<HashMap<String, (Ticket, Instant)>>,
    pub received: Mutex<Vec<Received>>,
}

impl Files {
    pub fn issue(&self, t: Ticket) -> String {
        let id = crate::util::b64url(&crate::crypto::random::<18>());
        let mut m = self.tickets.lock();
        let now = Instant::now();
        m.retain(|_, (_, at)| now.duration_since(*at) < TICKET_TTL);
        m.insert(id.clone(), (t, now));
        id
    }

    /// Билет одноразовый: забирается при первом использовании.
    pub fn take(&self, id: &str) -> Option<Ticket> {
        let (t, at) = self.tickets.lock().remove(id)?;
        (at.elapsed() < TICKET_TTL).then_some(t)
    }

    pub fn note_received(&self, r: Received) {
        let mut v = self.received.lock();
        v.insert(0, r);
        v.truncate(30);
    }
}

/// Свободное имя в папке: «фото.jpg», «фото (2).jpg», …
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickets_are_one_shot() {
        let f = Files::default();
        let id = f.issue(Ticket::Upload { name: "a".into(), size: Some(1), from: "x".into() });
        assert!(f.take(&id).is_some());
        assert!(f.take(&id).is_none());
        assert!(f.take("nope").is_none());
    }

    #[test]
    fn unique_names() {
        let dir = std::env::temp_dir().join(format!("dotlink-uniq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("фото.jpg"), b"1").unwrap();
        std::fs::write(dir.join("фото (2).jpg"), b"1").unwrap();
        assert_eq!(unique_path(&dir, "фото.jpg").file_name().unwrap(), "фото (3).jpg");
        assert_eq!(unique_path(&dir, "new.txt").file_name().unwrap(), "new.txt");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
