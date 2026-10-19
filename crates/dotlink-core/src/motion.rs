//! Плавный курсор.
//!
//! Wi-Fi доставляет пакеты пачками (энергосбережение радио, повторные передачи): если применять каждое
//! движение сразу, курсор то стоит, то прыгает. Поэтому каждое движение несёт время касания на телефоне.
//! ПК сопоставляет часы телефона со своими (по самым быстрым пакетам), держит маленький адаптивный буфер
//! (в хорошей сети 5–10 мс, при пачках Wi-Fi — до 70 мс, по фактическому разбросу задержек) и двигает курсор с частотой 240 Гц, равномерно
//! распределяя каждый отрезок пути по его длительности — как сыграл палец, так и сыграет курсор.

use crate::platform::Platform;
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Шаг отрисовки: 240 Гц.
pub const TICK: Duration = Duration::from_micros(4166);
const MIN_DELAY: f64 = 4.0;
/// Потолок буфера: энергосберегающий Wi-Fi держит пакеты до ~100 мс; хорошая сеть даёт 5–10 мс.
const MAX_DELAY: f64 = 80.0;
/// Как быстро оценка часов «отпускает» (мс за мс) — подстройка под смену маршрута.
const OFFSET_DRIFT: f64 = 0.002;
/// Как быстро забывается пик разброса задержек.
const JITTER_DECAY: f64 = 0.01;

#[derive(Debug, Clone, Copy)]
struct Seg {
    start: f64,
    end: f64,
    dx: f64,
    dy: f64,
    done: f64,
}

/// Чистая логика без потоков и часов — время передаётся снаружи (мс).
#[derive(Default)]
pub struct MotionCore {
    last_t: Option<(u32, f64)>,
    offset: Option<f64>,
    offset_at: f64,
    jitter: f64,
    jitter_at: f64,
    last_end: f64,
    /// типичный интервал между касаниями (EMA) — отрезок играется за это время
    seg_ms: f64,
    queue: VecDeque<Seg>,
    acc_x: f64,
    acc_y: f64,
}

impl MotionCore {
    /// Текущий буфер, мс: разброс задержек + длительность отрезка (чтобы весь отрезок
    /// успевал прийти до начала своего проигрывания) + небольшой запас.
    pub fn delay(&self) -> f64 {
        (self.jitter + self.seg_ms.max(4.0) + 2.0).clamp(MIN_DELAY, MAX_DELAY)
    }

    pub fn idle(&self) -> bool {
        self.queue.is_empty()
    }

    /// Движение `dx`, `dy` в четвертях пикселя, `t` — время касания на телефоне (мс, по кругу u32).
    pub fn push(&mut self, now: f64, t: u32, dx: i16, dy: i16) {
        // время телефона без переполнений
        let (tt, gap) = match self.last_t {
            Some((pt, ptt)) => {
                let d = t.wrapping_sub(pt) as i32 as f64;
                (ptt + d, Some(d))
            }
            None => (t as f64, None),
        };
        self.last_t = Some((t, tt));

        // смещение часов: минимум (самый быстрый пакет), медленно отпускаемый вверх
        let sample = now - tt;
        let off = match self.offset {
            Some(o) => (o + OFFSET_DRIFT * (now - self.offset_at)).min(sample),
            None => sample,
        };
        self.offset = Some(off);
        self.offset_at = now;

        // разброс: пик с медленным спадом
        let j = (sample - off).max(0.0);
        self.jitter = j.max(self.jitter - JITTER_DECAY * (now - self.jitter_at)).max(0.0);
        self.jitter_at = now;

        // длительность отрезка — интервал между касаниями; после паузы — новый штрих
        let dur = match gap {
            Some(g) if (0.0..100.0).contains(&g) => g.clamp(1.0, 40.0),
            _ => 8.0,
        };
        self.seg_ms = if self.seg_ms == 0.0 { dur.min(20.0) } else { self.seg_ms * 0.9 + dur.min(20.0) * 0.1 };
        let target_end = tt + off + self.delay();
        let start = (target_end - dur).max(self.last_end);
        let end = target_end.max(start + 1.0);
        self.last_end = end;
        self.queue.push_back(Seg { start, end, dx: dx as f64, dy: dy as f64, done: 0.0 });
    }

    /// Сколько пикселей сдвинуть к моменту `now`.
    pub fn tick(&mut self, now: f64) -> (i32, i32) {
        while let Some(s) = self.queue.front_mut() {
            if now <= s.start {
                break;
            }
            let f = ((now - s.start) / (s.end - s.start)).clamp(0.0, 1.0);
            self.acc_x += (f - s.done) * s.dx;
            self.acc_y += (f - s.done) * s.dy;
            s.done = f;
            if f >= 1.0 {
                self.queue.pop_front();
            } else {
                break;
            }
        }
        self.take()
    }

    /// Применить всё сразу — перед кликом курсор должен стоять там, куда его довёл палец.
    pub fn flush(&mut self) -> (i32, i32) {
        for s in self.queue.drain(..) {
            self.acc_x += (1.0 - s.done) * s.dx;
            self.acc_y += (1.0 - s.done) * s.dy;
        }
        self.take()
    }

    fn take(&mut self) -> (i32, i32) {
        let (px, py) = ((self.acc_x / 4.0).trunc(), (self.acc_y / 4.0).trunc());
        self.acc_x -= px * 4.0;
        self.acc_y -= py * 4.0;
        (px as i32, py as i32)
    }
}

enum Msg {
    Move { src: u64, t: u32, dx: i16, dy: i16 },
    Flush(tokio::sync::oneshot::Sender<()>),
    Forget(u64),
}

/// Поток отрисовки курсора. Один на ПК: у курсора одна позиция, телефонов может быть несколько.
#[derive(Clone)]
pub struct Motion {
    tx: Sender<Msg>,
}

impl Motion {
    pub fn start(platform: Arc<dyn Platform>) -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new().name("dotlink-motion".into()).spawn(move || run(platform, rx)).expect("поток курсора");
        Self { tx }
    }

    pub fn push(&self, src: u64, t: u32, dx: i16, dy: i16) {
        let _ = self.tx.send(Msg::Move { src, t, dx, dy });
    }

    /// Дождаться, пока курсор дойдёт до конца уже присланного пути (не дольше 50 мс).
    pub async fn flush(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self.tx.send(Msg::Flush(tx)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_millis(50), rx).await;
        }
    }

    pub fn forget(&self, src: u64) {
        let _ = self.tx.send(Msg::Forget(src));
    }
}

fn run(platform: Arc<dyn Platform>, rx: Receiver<Msg>) {
    let t0 = Instant::now();
    let ms = || t0.elapsed().as_secs_f64() * 1000.0;
    let mut cores: HashMap<u64, MotionCore> = HashMap::new();
    let mut fine_timer = false;
    let mut next = Instant::now();
    loop {
        let busy = cores.values().any(|c| !c.idle());
        // точный таймер Windows включаем только пока курсор едет
        if busy != fine_timer {
            platform.fine_timer(busy);
            fine_timer = busy;
        }
        let msg = if busy {
            let wait = next.saturating_duration_since(Instant::now());
            match rx.recv_timeout(wait) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match rx.recv() {
                Ok(m) => {
                    next = Instant::now();
                    Some(m)
                }
                Err(_) => return,
            }
        };
        match msg {
            Some(Msg::Move { src, t, dx, dy }) => cores.entry(src).or_default().push(ms(), t, dx, dy),
            Some(Msg::Flush(ack)) => {
                let (mut x, mut y) = (0, 0);
                for c in cores.values_mut() {
                    let (a, b) = c.flush();
                    x += a;
                    y += b;
                }
                if x != 0 || y != 0 {
                    platform.mouse_move(x, y);
                }
                let _ = ack.send(());
            }
            Some(Msg::Forget(src)) => {
                if let Some(mut c) = cores.remove(&src) {
                    let (x, y) = c.flush();
                    if x != 0 || y != 0 {
                        platform.mouse_move(x, y);
                    }
                }
            }
            None => {}
        }
        if Instant::now() >= next {
            next += TICK;
            if next < Instant::now() {
                next = Instant::now() + TICK;
            }
            let now = ms();
            let (mut x, mut y) = (0, 0);
            for c in cores.values_mut() {
                let (a, b) = c.tick(now);
                x += a;
                y += b;
            }
            if x != 0 || y != 0 {
                platform.mouse_move(x, y);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Палец ведёт ровно ~1 px/мс (120 Гц касаний по 8 px), а сеть доставляет
    /// пакеты пачками по 6 штук раз в 50 мс. Курсор должен двигаться равномерно, без пауз и прыжков.
    #[test]
    fn bursts_become_smooth_motion() {
        let mut m = MotionCore::default();
        let step = 1000.0 / 120.0;
        let mut out = Vec::new();
        let mut sent = 0usize;
        let mut now = 0.0;
        let phone = |i: usize| (i as f64 * step) as u32;
        while now < 1000.0 {
            // пачка: все касания до текущего момента, приходят разом каждые 50 мс
            if (now as u64).is_multiple_of(50) {
                while (sent as f64) * step <= now - 2.0 {
                    m.push(now, phone(sent), 32, 0); // 32 четверти = 8 px
                    sent += 1;
                }
            }
            out.push(m.tick(now).0);
            now += 1.0;
        }
        let total: i32 = out.iter().sum();
        assert!(total > 800, "курсор прошёл {total} px");
        // в установившемся режиме (после буфера) курсор двигается почти каждый тик 4 мс
        let steady: Vec<i32> = out[300..900].chunks(4).map(|c| c.iter().sum()).collect();
        let stalls = steady.iter().filter(|&&v| v == 0).count();
        let max = *steady.iter().max().unwrap();
        let min = *steady.iter().min().unwrap();
        assert!(min >= 2, "провал до {min} px за 4 мс");
        assert!(stalls <= steady.len() / 20, "пауз: {stalls} из {}", steady.len());
        // ровно ~3.8 px за 4 мс; без сглаживания было бы 0 px, а затем ~190 px одним прыжком
        assert!(max <= 6, "прыжок на {max} px за 4 мс");
        assert!(m.delay() <= MAX_DELAY);
    }

    /// В ровной сети буфер остаётся маленьким — задержка не растёт зря.
    #[test]
    fn steady_network_keeps_small_delay() {
        let mut m = MotionCore::default();
        for i in 0..200u32 {
            let t = i * 8;
            m.push(t as f64 + 3.0 + (i % 3) as f64, t, 4, 0);
            m.tick(t as f64 + 4.0);
        }
        assert!(m.delay() < 16.0, "буфер {} мс", m.delay());
    }

    #[test]
    fn flush_applies_everything_and_keeps_subpixels() {
        let mut m = MotionCore::default();
        m.push(0.0, 1000, 10, -6);
        m.push(1.0, 1008, 10, -6);
        assert_eq!(m.flush(), (5, -3));
        assert!(m.idle());
        m.push(2.0, 1016, 2, 0);
        m.push(3.0, 1024, 2, 0);
        assert_eq!(m.flush(), (1, 0));
    }

    #[test]
    fn phone_clock_wraps() {
        let mut m = MotionCore::default();
        m.push(0.0, u32::MAX - 4, 4, 0);
        m.push(8.0, 3, 4, 0);
        let mut x = 0;
        for t in 0..200 {
            x += m.tick(t as f64).0;
        }
        assert_eq!(x, 2);
    }
}
