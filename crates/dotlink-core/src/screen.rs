//! Экран ПК на телефоне — удалённый рабочий стол в кармане.
//!
//! Снимок монитора (уже уменьшенный, с курсором) → JPEG → кадр `SCREEN` основным каналом сессии.
//! Темп задаёт сам телефон: в пути не больше двух неподтверждённых кадров, так что в медленной
//! сети частота падает сама, а задержка не копится. Неизменившийся экран не шлётся повторно
//! (раз в две секунды — всё же кадр, чтобы телефон видел, что поток жив).

use crate::core::{Core, Out};
use crate::platform::Monitor;
use crate::proto;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, Notify};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Opts {
    pub monitor: usize,
    pub max_w: u32,
    pub quality: u8,
}

impl Opts {
    pub fn new(monitor: usize, max: Option<u32>, q: Option<u8>) -> Self {
        Self { monitor, max_w: max.unwrap_or(1280).clamp(320, 2560), quality: q.unwrap_or(70).clamp(30, 90) }
    }
}

/// Сколько кадров может быть в пути без подтверждения.
const IN_FLIGHT: u32 = 2;
/// Потолок частоты — больше JPEG-поток всё равно не даёт по Wi-Fi.
const MIN_FRAME: Duration = Duration::from_millis(45);
/// Неизменный экран — кадр не чаще этого.
const IDLE_FRAME: Duration = Duration::from_secs(2);

pub struct Screen {
    opts: watch::Sender<Option<Opts>>,
    inflight: Arc<AtomicU32>,
    wake: Arc<Notify>,
}

impl Screen {
    pub fn start(core: Arc<Core>, out: mpsc::Sender<Out>) -> Self {
        let (opts, rx) = watch::channel(None);
        let inflight = Arc::new(AtomicU32::new(0));
        let wake = Arc::new(Notify::new());
        tokio::spawn(run(core, out, rx, inflight.clone(), wake.clone()));
        Self { opts, inflight, wake }
    }

    pub fn set(&self, o: Option<Opts>) {
        self.inflight.store(0, Ordering::Relaxed);
        self.opts.send_replace(o);
        self.wake.notify_one();
    }

    pub fn current(&self) -> Option<Opts> {
        *self.opts.borrow()
    }

    pub fn ack(&self) {
        let _ = self.inflight.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| Some(v.saturating_sub(1)));
        self.wake.notify_one();
    }
}

/// Дешёвый отпечаток кадра: каждый 61-й байт — изменения курсора и текста он замечает.
fn fingerprint(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for x in b.iter().step_by(61) {
        h ^= *x as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^ b.len() as u64
}

pub fn encode(bgra: &[u8], w: u32, h: u32, quality: u8) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(bgra.len() / 10);
    jpeg_encoder::Encoder::new(&mut out, quality).encode(bgra, w as u16, h as u16, jpeg_encoder::ColorType::Bgra)?;
    Ok(out)
}

/// Монитор по номеру; если его отключили — основной.
pub fn monitor(core: &Core, i: usize) -> Option<(usize, Monitor)> {
    let list = core.platform.monitors();
    list.get(i).copied().map(|m| (i, m)).or_else(|| list.first().copied().map(|m| (0, m)))
}

async fn run(core: Arc<Core>, out: mpsc::Sender<Out>, mut rx: watch::Receiver<Option<Opts>>, inflight: Arc<AtomicU32>, wake: Arc<Notify>) {
    let mut last_print = 0u64;
    let mut last_sent = Instant::now() - IDLE_FRAME;
    loop {
        let Some(opts) = *rx.borrow_and_update() else {
            if rx.changed().await.is_err() {
                return;
            }
            last_print = 0;
            continue;
        };
        // ждём подтверждения: телефон не успевает — не шлём
        if inflight.load(Ordering::Relaxed) >= IN_FLIGHT {
            tokio::select! {
                _ = wake.notified() => {}
                // подтверждение потерялось (переподключение) — не встаём навсегда
                _ = tokio::time::sleep(Duration::from_secs(2)) => inflight.store(0, Ordering::Relaxed),
                r = rx.changed() => if r.is_err() { return },
            }
            continue;
        }
        let started = Instant::now();
        let Some((idx, mon)) = monitor(&core, opts.monitor) else {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        let p = core.platform.clone();
        let shot = tokio::task::spawn_blocking(move || p.screenshot(&mon, opts.max_w)).await.ok().flatten();
        let Some(shot) = shot else {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        };
        let print = fingerprint(&shot.bgra);
        if print == last_print && last_sent.elapsed() < IDLE_FRAME {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(60)) => {}
                r = rx.changed() => if r.is_err() { return },
            }
            continue;
        }
        let (w, h, q) = (shot.w, shot.h, opts.quality);
        let Ok(Ok(jpeg)) = tokio::task::spawn_blocking(move || encode(&shot.bgra, w, h, q)).await else {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        };
        // пока снимали, телефон мог выключить поток или выбрать другой монитор
        if *rx.borrow() != Some(opts) {
            continue;
        }
        if out.send(Out::Bulk(proto::screen_frame(idx as u8, w as u16, h as u16, &jpeg))).await.is_err() {
            return;
        }
        inflight.fetch_add(1, Ordering::Relaxed);
        last_print = print;
        last_sent = Instant::now();
        if let Some(rest) = MIN_FRAME.checked_sub(started.elapsed()) {
            tokio::time::sleep(rest).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_roundtrip_header() {
        let (w, h) = (64u32, 48u32);
        let px: Vec<u8> = (0..w * h).flat_map(|i| [(i % 255) as u8, 40, 200, 255]).collect();
        let j = encode(&px, w, h, 70).unwrap();
        assert_eq!(&j[..2], &[0xFF, 0xD8], "SOI");
        assert_eq!(&j[j.len() - 2..], &[0xFF, 0xD9], "EOI");
        assert!(j.len() < px.len());
    }

    #[test]
    fn options_are_clamped() {
        let o = Opts::new(0, Some(10_000), Some(5));
        assert_eq!((o.max_w, o.quality), (2560, 30));
        assert_eq!(Opts::new(1, None, None), Opts { monitor: 1, max_w: 1280, quality: 70 });
    }

    #[test]
    fn fingerprint_sees_small_changes() {
        let a = vec![10u8; 4 * 320 * 200];
        let mut b = a.clone();
        b[61 * 100] = 11;
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }
}
