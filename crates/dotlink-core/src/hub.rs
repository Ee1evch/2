//! Хаб состояния: последнее значение по каждому ключу + рассылка изменений всем сессиям.
//! Телефон получает снимок при подключении и дальше только изменения.

use parking_lot::RwLock;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::broadcast;

pub type Update = (&'static str, Arc<Value>);

/// Ключи, которые видит только дашборд на ПК.
pub const ADMIN_ONLY: &[&str] = &["devices", "settings", "pairing", "net", "received", "outbox", "mirror", "notifs", "relay", "bt"];

pub struct Hub {
    map: RwLock<BTreeMap<&'static str, Arc<Value>>>,
    tx: broadcast::Sender<Update>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        Self { map: RwLock::new(BTreeMap::new()), tx: broadcast::channel(512).0 }
    }

    /// Обновить ключ; одинаковое значение не рассылается.
    pub fn set(&self, key: &'static str, val: Value) {
        let mut m = self.map.write();
        if m.get(key).is_some_and(|v| **v == val) {
            return;
        }
        let v = Arc::new(val);
        m.insert(key, v.clone());
        let _ = self.tx.send((key, v));
    }

    pub fn get(&self, key: &str) -> Option<Arc<Value>> {
        self.map.read().get(key).cloned()
    }

    pub fn snapshot(&self) -> Vec<Update> {
        self.map.read().iter().map(|(k, v)| (*k, v.clone())).collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Update> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dedups_and_broadcasts() {
        let h = Hub::new();
        let mut rx = h.subscribe();
        h.set("vol", json!({"level": 0.5}));
        h.set("vol", json!({"level": 0.5}));
        h.set("vol", json!({"level": 0.6}));
        assert_eq!(rx.try_recv().unwrap().1["level"], 0.5);
        assert_eq!(rx.try_recv().unwrap().1["level"], 0.6);
        assert!(rx.try_recv().is_err());
        assert_eq!(h.snapshot().len(), 1);
    }
}
