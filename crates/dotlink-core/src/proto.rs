//! Протокол DotLink поверх WebSocket.
//!
//! Частые события (мышь, скролл, клавиши) — бинарные кадры: 1 байт опкода + несколько байт.
//! Редкие команды и состояние — JSON; бинарный кадр, начинающийся с `{`, — это JSON.
//! После входа все кадры телефона шифруются (см. `crypto::Channel`), у дашборда на 127.0.0.1 — нет.

use serde::Deserialize;

pub const VERSION: u32 = 1;

pub mod op {
    /// i16 dx, i16 dy — в четвертях пикселя
    pub const MOVE: u8 = 0x01;
    /// i16 v, i16 h — в единицах колеса (120 = щелчок); дробные значения дают плавную прокрутку
    pub const SCROLL: u8 = 0x02;
    /// u8 кнопка (0 л, 1 п, 2 ср, 3 X1, 4 X2), u8 действие (0 отпустить, 1 нажать, 2 клик, 3 двойной клик)
    pub const BUTTON: u8 = 0x03;
    /// u16 VK, u8 действие (0 отпустить, 1 нажать, 2 нажать и отпустить)
    pub const KEY: u8 = 0x04;
    /// UTF-8 текст — печатается как Unicode, независимо от раскладки
    pub const TEXT: u8 = 0x05;
    /// u8 n, n × u16 VK — сочетание: нажать по порядку, отпустить в обратном
    pub const CHORD: u8 = 0x06;
    /// u16 громкость 0..10000, u16 номер
    pub const VOLUME: u8 = 0x07;
    /// u32 метка времени клиента; сервер отвечает тем же кадром
    pub const PING: u8 = 0x08;
    /// i16 dx, i16 dy (четверти пикселя), u32 время касания на телефоне в мс —
    /// ПК воспроизводит движение в том же ритме, без рывков от пачек пакетов Wi-Fi
    pub const MOVE_T: u8 = 0x09;
    /// кадр видео экрана телефона: u8 флаги (1 ключевой, 2 конфигурация), u32 время в мс, u16 w, u16 h, данные H.264/VP8
    pub const MIRROR: u8 = 0x0A;
    /// часть файла внутри сессии (через ретранслятор или Bluetooth, где нет прямого HTTP):
    /// u8 вид (0 данные, 1 конец, 2 отмена), u8 длина билета, билет, данные
    pub const FILE: u8 = 0x0B;

    // ПК → телефон: мышь ПК управляет телефоном (как Universal Control)
    /// i16 dx, i16 dy — в пикселях ПК
    pub const UC_MOVE: u8 = 0x20;
    /// u8 кнопка, u8 действие (0 отпустить, 1 нажать)
    pub const UC_BUTTON: u8 = 0x21;
    /// i16 v, i16 h — единицы колеса
    pub const UC_SCROLL: u8 = 0x22;
    pub const JSON: u8 = b'{';
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonAction {
    Up,
    Down,
    Click,
    DoubleClick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Up,
    Down,
    Press,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Move {
        dx: i16,
        dy: i16,
    },
    Scroll {
        v: i16,
        h: i16,
    },
    Button {
        button: MouseButton,
        action: ButtonAction,
    },
    Key {
        vk: u16,
        action: KeyAction,
    },
    Text(String),
    Chord(Vec<u16>),
    Volume {
        level: u16,
        seq: u16,
    },
    Ping(u32),
    MoveT {
        dx: i16,
        dy: i16,
        t: u32,
    },
    /// весь кадр как есть — ядро пересылает его дашборду
    Mirror(Vec<u8>),
    File {
        kind: u8,
        id: String,
        data: Vec<u8>,
    },
    Json(serde_json::Value),
}

#[derive(Debug, PartialEq, Eq)]
pub struct BadFrame;

fn i16_at(b: &[u8], i: usize) -> Result<i16, BadFrame> {
    b.get(i..i + 2).map(|s| i16::from_le_bytes([s[0], s[1]])).ok_or(BadFrame)
}
fn u16_at(b: &[u8], i: usize) -> Result<u16, BadFrame> {
    b.get(i..i + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or(BadFrame)
}

pub fn decode(b: &[u8]) -> Result<Frame, BadFrame> {
    let (&op, _) = b.split_first().ok_or(BadFrame)?;
    Ok(match op {
        op::MOVE => Frame::Move { dx: i16_at(b, 1)?, dy: i16_at(b, 3)? },
        op::SCROLL => Frame::Scroll { v: i16_at(b, 1)?, h: i16_at(b, 3)? },
        op::BUTTON => {
            let button = match *b.get(1).ok_or(BadFrame)? {
                0 => MouseButton::Left,
                1 => MouseButton::Right,
                2 => MouseButton::Middle,
                3 => MouseButton::X1,
                4 => MouseButton::X2,
                _ => return Err(BadFrame),
            };
            let action = match *b.get(2).ok_or(BadFrame)? {
                0 => ButtonAction::Up,
                1 => ButtonAction::Down,
                2 => ButtonAction::Click,
                3 => ButtonAction::DoubleClick,
                _ => return Err(BadFrame),
            };
            Frame::Button { button, action }
        }
        op::KEY => {
            let action = match *b.get(3).ok_or(BadFrame)? {
                0 => KeyAction::Up,
                1 => KeyAction::Down,
                2 => KeyAction::Press,
                _ => return Err(BadFrame),
            };
            Frame::Key { vk: u16_at(b, 1)?, action }
        }
        op::TEXT => Frame::Text(String::from_utf8(b[1..].to_vec()).map_err(|_| BadFrame)?),
        op::CHORD => {
            let n = *b.get(1).ok_or(BadFrame)? as usize;
            if n == 0 || n > 6 {
                return Err(BadFrame);
            }
            Frame::Chord((0..n).map(|i| u16_at(b, 2 + i * 2)).collect::<Result<_, _>>()?)
        }
        op::VOLUME => Frame::Volume { level: u16_at(b, 1)?.min(10_000), seq: u16_at(b, 3)? },
        op::PING => Frame::Ping(u32::from_le_bytes(b.get(1..5).ok_or(BadFrame)?.try_into().unwrap())),
        op::MOVE_T => Frame::MoveT { dx: i16_at(b, 1)?, dy: i16_at(b, 3)?, t: u32::from_le_bytes(b.get(5..9).ok_or(BadFrame)?.try_into().unwrap()) },
        op::MIRROR if b.len() > 10 => Frame::Mirror(b.to_vec()),
        op::FILE => {
            let n = *b.get(2).ok_or(BadFrame)? as usize;
            let id = std::str::from_utf8(b.get(3..3 + n).ok_or(BadFrame)?).map_err(|_| BadFrame)?.to_string();
            Frame::File { kind: b[1], id, data: b[3 + n..].to_vec() }
        }
        op::JSON => Frame::Json(serde_json::from_slice(b).map_err(|_| BadFrame)?),
        _ => return Err(BadFrame),
    })
}

pub fn uc_move(dx: i16, dy: i16) -> Vec<u8> {
    let mut v = vec![op::UC_MOVE];
    v.extend_from_slice(&dx.to_le_bytes());
    v.extend_from_slice(&dy.to_le_bytes());
    v
}

pub fn uc_button(button: u8, down: bool) -> Vec<u8> {
    vec![op::UC_BUTTON, button, down as u8]
}

pub fn uc_scroll(v: i16, h: i16) -> Vec<u8> {
    let mut b = vec![op::UC_SCROLL];
    b.extend_from_slice(&v.to_le_bytes());
    b.extend_from_slice(&h.to_le_bytes());
    b
}

pub fn file_frame(kind: u8, id: &str, data: &[u8]) -> Vec<u8> {
    let id = &id.as_bytes()[..id.len().min(255)];
    let mut v = Vec::with_capacity(3 + id.len() + data.len());
    v.extend_from_slice(&[op::FILE, kind, id.len() as u8]);
    v.extend_from_slice(id);
    v.extend_from_slice(data);
    v
}

pub fn pong(t: u32) -> Vec<u8> {
    let mut v = vec![op::PING];
    v.extend_from_slice(&t.to_le_bytes());
    v
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaAction {
    Toggle,
    Play,
    Pause,
    Next,
    Prev,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PowerAction {
    Lock,
    Sleep,
    Hibernate,
    Restart,
    Shutdown,
    Logoff,
    DisplayOff,
}

/// Команды телефона (JSON).
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum RemoteCmd {
    Media {
        a: MediaAction,
    },
    Mute {
        v: bool,
    },
    Power {
        a: PowerAction,
    },
    Timer {
        a: Option<PowerAction>,
        sec: Option<u32>,
        #[serde(default)]
        cancel: bool,
    },
    Macro {
        id: String,
    },
    ClipSet {
        text: String,
    },
    /// `size: None` — размер неизвестен (файл из «Поделиться» Android)
    Upload {
        name: String,
        size: Option<u64>,
    },
    ClipFiles,
    /// открыть ссылку на ПК (Handoff с телефона)
    OpenUrl {
        url: String,
    },
    /// уведомление с телефона — показать на ПК
    Notify {
        app: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        text: String,
    },
    /// трансляция экрана началась или закончилась
    Mirror {
        on: bool,
        #[serde(default)]
        w: u32,
        #[serde(default)]
        h: u32,
        #[serde(default)]
        codec: String,
    },
    /// курсор ПК ушёл с края экрана телефона — вернуть управление ПК
    UcExit,
    /// скачать предложенный файл внутри сессии (когда HTTP до ПК недоступен)
    FileGet {
        ticket: String,
    },
    /// WebRTC: предложение и кандидаты — внутри уже зашифрованной сессии
    RtcOffer {
        sdp: serde_json::Value,
    },
    RtcIce {
        candidate: serde_json::Value,
    },
}

/// Виртуальные коды клавиш Windows — общее пространство имён протокола.
pub mod vk {
    pub const BACK: u16 = 0x08;
    pub const TAB: u16 = 0x09;
    pub const RETURN: u16 = 0x0D;
    pub const SHIFT: u16 = 0x10;
    pub const CONTROL: u16 = 0x11;
    pub const MENU: u16 = 0x12;
    pub const ESCAPE: u16 = 0x1B;
    pub const SPACE: u16 = 0x20;
    pub const LWIN: u16 = 0x5B;
    pub const DELETE: u16 = 0x2E;

    /// Имя клавиши из макросов (`ctrl`, `win`, `f5`, `a`…) → VK.
    pub fn by_name(name: &str) -> Option<u16> {
        let n = name.trim().to_ascii_lowercase();
        let code = match n.as_str() {
            "ctrl" | "control" => CONTROL,
            "shift" => SHIFT,
            "alt" => MENU,
            "win" | "meta" | "super" => LWIN,
            "enter" | "return" => RETURN,
            "esc" | "escape" => ESCAPE,
            "tab" => TAB,
            "space" => SPACE,
            "backspace" | "bksp" => BACK,
            "delete" | "del" => DELETE,
            "insert" | "ins" => 0x2D,
            "home" => 0x24,
            "end" => 0x23,
            "pgup" | "pageup" => 0x21,
            "pgdn" | "pagedown" => 0x22,
            "left" => 0x25,
            "up" => 0x26,
            "right" => 0x27,
            "down" => 0x28,
            "prtsc" | "printscreen" => 0x2C,
            "caps" | "capslock" => 0x14,
            "menu" | "apps" => 0x5D,
            "volup" => 0xAF,
            "voldown" => 0xAE,
            "volmute" => 0xAD,
            "next" => 0xB0,
            "prev" => 0xB1,
            "stop" => 0xB2,
            "playpause" => 0xB3,
            _ => {
                let b = n.as_bytes();
                if b.len() == 1 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) {
                    return Some(b[0].to_ascii_uppercase() as u16);
                }
                if let Some(f) = n.strip_prefix('f').and_then(|d| d.parse::<u16>().ok()) {
                    if (1..=24).contains(&f) {
                        return Some(0x6F + f);
                    }
                }
                return None;
            }
        };
        Some(code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_binary_frames() {
        assert_eq!(decode(&[1, 0xFE, 0xFF, 8, 0]).unwrap(), Frame::Move { dx: -2, dy: 8 });
        assert_eq!(decode(&[2, 120, 0, 0x88, 0xFF]).unwrap(), Frame::Scroll { v: 120, h: -120 });
        assert_eq!(decode(&[3, 1, 2]).unwrap(), Frame::Button { button: MouseButton::Right, action: ButtonAction::Click });
        assert_eq!(decode(&[4, 0x5B, 0, 1]).unwrap(), Frame::Key { vk: 0x5B, action: KeyAction::Down });
        assert_eq!(decode(&[6, 2, 0x11, 0, 0x43, 0]).unwrap(), Frame::Chord(vec![0x11, 0x43]));
        assert_eq!(decode(&[7, 0x10, 0x27, 5, 0]).unwrap(), Frame::Volume { level: 10_000, seq: 5 });
        assert_eq!(decode(&[8, 1, 0, 0, 0]).unwrap(), Frame::Ping(1));
        let mut t = vec![5];
        t.extend_from_slice("Привет".as_bytes());
        assert_eq!(decode(&t).unwrap(), Frame::Text("Привет".into()));
        assert!(matches!(decode(br#"{"t":"media","a":"next"}"#).unwrap(), Frame::Json(_)));
        assert_eq!(decode(&[9, 4, 0, 0xFC, 0xFF, 0x10, 0, 0, 0]).unwrap(), Frame::MoveT { dx: 4, dy: -4, t: 16 });
        assert!(matches!(decode(&[0x0A, 1, 0, 0, 0, 0, 0x80, 2, 0x38, 4, 0xAA]).unwrap(), Frame::Mirror(_)));
        assert!(decode(&[0x0A, 1]).is_err());
        assert_eq!(decode(&file_frame(0, "abc", &[1, 2])).unwrap(), Frame::File { kind: 0, id: "abc".into(), data: vec![1, 2] });
        assert!(decode(&[0x0B, 0, 9, b'a']).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode(&[]).is_err());
        assert!(decode(&[1, 0]).is_err());
        assert!(decode(&[3, 9, 0]).is_err());
        assert!(decode(&[6, 0]).is_err());
        assert!(decode(&[6, 7, 0, 0]).is_err());
        assert!(decode(&[0x42]).is_err());
        assert!(decode(&[5, 0xFF, 0xFE]).is_err());
    }

    #[test]
    fn key_names() {
        assert_eq!(vk::by_name("Ctrl"), Some(0x11));
        assert_eq!(vk::by_name("f5"), Some(0x74));
        assert_eq!(vk::by_name("a"), Some(0x41));
        assert_eq!(vk::by_name("7"), Some(0x37));
        assert_eq!(vk::by_name("nope"), None);
    }

    #[test]
    fn remote_cmds() {
        let c: RemoteCmd = serde_json::from_str(r#"{"t":"timer","a":"shutdown","sec":60}"#).unwrap();
        assert!(matches!(c, RemoteCmd::Timer { a: Some(PowerAction::Shutdown), sec: Some(60), cancel: false }));
        let c: RemoteCmd = serde_json::from_str(r#"{"t":"power","a":"display-off"}"#).unwrap();
        assert!(matches!(c, RemoteCmd::Power { a: PowerAction::DisplayOff }));
    }
}
