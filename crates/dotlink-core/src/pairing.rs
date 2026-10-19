//! Предложение сопряжения: секрет для QR (128 бит) и PIN из 6 цифр.
//! Предыдущее предложение действует ещё минуту — QR мог обновиться, пока телефон подключался.

use parking_lot::Mutex;
use rand::Rng;
use std::time::{Duration, Instant};

pub const TTL: Duration = Duration::from_secs(180);
const GRACE: Duration = Duration::from_secs(60);
const PIN_TRIES: u32 = 5;

#[derive(Clone)]
pub struct Offer {
    pub secret: [u8; 16],
    pub pin: String,
    pub expires: Instant,
    pub expires_ms: u64,
    pin_fails: u32,
}

impl Offer {
    fn new() -> Self {
        let pin = format!("{:06}", rand::rngs::OsRng.gen_range(0..1_000_000));
        Self { secret: crate::crypto::random(), pin, expires: Instant::now() + TTL, expires_ms: crate::util::now_ms() + TTL.as_millis() as u64, pin_fails: 0 }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Qr,
    Pin,
}

#[derive(Default)]
pub struct Pairing {
    cur: Mutex<Option<Offer>>,
    prev: Mutex<Option<Offer>>,
}

impl Pairing {
    /// Текущее предложение (создаётся при необходимости).
    pub fn current(&self) -> Offer {
        let mut cur = self.cur.lock();
        match &*cur {
            Some(o) if o.expires > Instant::now() => o.clone(),
            _ => {
                let o = Offer::new();
                *self.prev.lock() = cur.take();
                *cur = Some(o.clone());
                o
            }
        }
    }

    /// Новое предложение, старое ещё минуту принимается.
    pub fn refresh(&self) -> Offer {
        let o = Offer::new();
        let old = self.cur.lock().replace(o.clone());
        *self.prev.lock() = old.map(|mut p| {
            p.expires = p.expires.min(Instant::now() + GRACE);
            p
        });
        o
    }

    /// Секреты, которыми сейчас можно доказать сопряжение.
    pub fn candidates(&self, kind: Kind) -> Vec<Vec<u8>> {
        let now = Instant::now();
        [self.cur.lock().clone(), self.prev.lock().clone()]
            .into_iter()
            .flatten()
            .filter(|o| o.expires > now && (kind == Kind::Qr || o.pin_fails < PIN_TRIES))
            .map(|o| match kind {
                Kind::Qr => o.secret.to_vec(),
                Kind::Pin => o.pin.into_bytes(),
            })
            .collect()
    }

    /// Неверный PIN: после пяти ошибок PIN меняется.
    pub fn pin_failed(&self) {
        let mut cur = self.cur.lock();
        if let Some(o) = cur.as_mut() {
            o.pin_fails += 1;
            if o.pin_fails >= PIN_TRIES {
                *cur = None;
            }
        }
        drop(cur);
        if let Some(p) = self.prev.lock().as_mut() {
            p.pin_fails = PIN_TRIES;
        }
    }

    /// Предложение использовано — следующее будет новым.
    pub fn consume(&self) {
        *self.cur.lock() = None;
        *self.prev.lock() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grace_and_pin_lockout() {
        let p = Pairing::default();
        let a = p.current();
        assert_eq!(a.pin.len(), 6);
        assert_eq!(p.current().secret, a.secret);
        let b = p.refresh();
        let qr = p.candidates(Kind::Qr);
        assert!(qr.contains(&a.secret.to_vec()) && qr.contains(&b.secret.to_vec()));
        for _ in 0..PIN_TRIES {
            p.pin_failed();
        }
        assert!(p.candidates(Kind::Pin).is_empty());
        assert_ne!(p.current().pin.as_bytes(), b.pin.as_bytes());
        p.consume();
        assert!(p.candidates(Kind::Qr).is_empty());
    }
}
