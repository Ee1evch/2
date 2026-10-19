//! Мышь и клавиатура через SendInput.
//! Курсор двигается абсолютными координатами виртуального рабочего стола: на движение не накладывается
//! «повышенная точность указателя» Windows — ускорение одно, телефонное, и оно предсказуемо.

use crate::platform::{ButtonAction, KeyAction, MouseButton};
use parking_lot::Mutex;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::POINT;
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

fn send(inputs: &[INPUT]) {
    if !inputs.is_empty() {
        unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as _, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn kbd(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

fn is_extended(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2C | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90 | 0xA3 | 0xA5 | 0xAD..=0xB7)
}

fn key_input(vk: u16, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut f = KEYBD_EVENT_FLAGS(0);
    if is_extended(vk) {
        f |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        f |= KEYEVENTF_KEYUP;
    }
    kbd(vk, scan, f)
}

/// Позиция, куда мы последними отправили курсор. SendInput асинхронен: если сразу спросить
/// GetCursorPos, можно получить старую точку и потерять движение — поэтому при частых событиях
/// считаем от своей точки, а после паузы сверяемся с настоящей (вдруг двигали обычной мышью).
pub struct Input {
    last: Mutex<Option<(i32, i32, Instant)>>,
}

impl Input {
    pub fn new() -> Self {
        Self { last: Mutex::new(None) }
    }

    pub fn mouse_move(&self, dx: i32, dy: i32) {
        let mut last = self.last.lock();
        let (cx, cy) = match *last {
            Some((x, y, t)) if t.elapsed() < Duration::from_millis(60) => (x, y),
            _ => {
                let mut p = POINT::default();
                if unsafe { GetCursorPos(&mut p) }.is_err() {
                    return;
                }
                (p.x, p.y)
            }
        };
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
                GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
            )
        };
        let x = (cx + dx).clamp(vx, vx + vw - 1);
        let y = (cy + dy).clamp(vy, vy + vh - 1);
        // пиксель → 0..65535 с округлением вверх: Windows переводит обратно отбрасыванием дробной части
        let nx = (((x - vx) as i64 * 65536 + vw as i64 - 1) / vw as i64).min(65535) as i32;
        let ny = (((y - vy) as i64 * 65536 + vh as i64 - 1) / vh as i64).min(65535) as i32;
        send(&[mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0)]);
        *last = Some((x, y, Instant::now()));
    }

    pub fn button(&self, b: MouseButton, a: ButtonAction) {
        let (down, up, data) = match b {
            MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0),
            MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0),
            MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
            MouseButton::X1 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 1),
            MouseButton::X2 => (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 2),
        };
        let d = mouse(down, 0, 0, data);
        let u = mouse(up, 0, 0, data);
        match a {
            ButtonAction::Down => send(&[d]),
            ButtonAction::Up => send(&[u]),
            ButtonAction::Click => send(&[d, u]),
            ButtonAction::DoubleClick => send(&[d, u, d, u]),
        }
    }

    pub fn scroll(&self, v: i32, h: i32) {
        let mut ins = Vec::with_capacity(2);
        if v != 0 {
            ins.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, v));
        }
        if h != 0 {
            ins.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, h));
        }
        send(&ins);
    }

    pub fn key(&self, vk: u16, a: KeyAction) {
        match a {
            KeyAction::Down => send(&[key_input(vk, false)]),
            KeyAction::Up => send(&[key_input(vk, true)]),
            KeyAction::Press => send(&[key_input(vk, false), key_input(vk, true)]),
        }
    }

    /// Сочетание одним вызовом SendInput — Windows видит его атомарно.
    /// Win+L блокируется только через LockWorkStation: его SendInput не может нажать.
    pub fn chord(&self, vks: &[u16]) {
        if vks.contains(&0x5B) && vks.contains(&0x4C) && vks.len() == 2 {
            unsafe {
                let _ = LockWorkStation();
            }
            return;
        }
        let mut ins: Vec<INPUT> = vks.iter().map(|&k| key_input(k, false)).collect();
        ins.extend(vks.iter().rev().map(|&k| key_input(k, true)));
        send(&ins);
    }

    /// Текст печатается Unicode-событиями: кириллица и эмодзи — при любой раскладке.
    pub fn text(&self, s: &str) {
        let mut ins = Vec::with_capacity(s.len() * 2);
        for c in s.encode_utf16() {
            match c {
                0x0D => continue,
                0x0A => ins.extend([key_input(0x0D, false), key_input(0x0D, true)]),
                0x09 => ins.extend([key_input(0x09, false), key_input(0x09, true)]),
                _ => ins.extend([kbd(0, c, KEYEVENTF_UNICODE), kbd(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]),
            }
            if ins.len() >= 400 {
                send(&ins);
                ins.clear();
            }
        }
        send(&ins);
    }
}
