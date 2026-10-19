//! Мышь и клавиатура ПК на телефоне — как Universal Control между Mac и iPad.
//!
//! Низкоуровневые хуки WH_MOUSE_LL и WH_KEYBOARD_LL в своём потоке с очередью сообщений:
//! - пока захвата нет, хук только смотрит: курсор упёрся в выбранный край рабочего стола и продолжает
//!   давить — `Capture(Edge)`; Ctrl+Alt+→ — `Capture(Toggle)`;
//! - в захвате движения, кнопки, колесо и клавиши не доходят до Windows и уходят телефону, курсор ПК
//!   стоит на месте; Esc или Ctrl+Alt+← — вернуть.
//!
//! События, которые DotLink сам вводит через SendInput (тачпад телефона), хук пропускает: у них флаг
//! «injected». Отпускания клавиш-модификаторов и кнопок, нажатых до захвата, Windows видит всегда —
//! иначе Ctrl или Alt «залипли бы».

use super::super::{CaptureEv, Event, MouseButton};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU8, Ordering};
use std::sync::mpsc::Sender;
use std::time::Duration;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetKeyboardLayout, ToUnicodeEx};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetCursorPos, GetForegroundWindow, GetMessageW, GetSystemMetrics, GetWindowThreadProcessId, SetCursorPos, SetWindowsHookExW, HC_ACTION,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_UP, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_RBUTTONDOWN, WM_RBUTTONUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

const VK_SHIFT: u32 = 0x10;
const VK_CONTROL: u32 = 0x11;
const VK_MENU: u32 = 0x12;
const VK_ESCAPE: u32 = 0x1B;
const VK_LEFT: u32 = 0x25;
const VK_RIGHT: u32 = 0x27;
const MODIFIERS: [u32; 11] = [VK_SHIFT, VK_CONTROL, VK_MENU, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C];

/// Край: 0 нет, 1 слева, 2 справа, 3 сверху, 4 снизу.
pub fn edge_code(edge: &str) -> u8 {
    match edge {
        "left" => 1,
        "right" => 2,
        "top" => 3,
        "bottom" => 4,
        _ => 0,
    }
}

struct Shared {
    tx: Mutex<Option<Sender<Event>>>,
    capturing: AtomicBool,
    edge: AtomicU8,
    anchor: Mutex<POINT>,
    pushes: AtomicU32,
    acc_x: AtomicI32,
    acc_y: AtomicI32,
    /// кнопки, нажатые до захвата: их отпускание должна увидеть Windows
    held: AtomicU8,
    started: AtomicBool,
}

static S: Shared = Shared {
    tx: Mutex::new(None),
    capturing: AtomicBool::new(false),
    edge: AtomicU8::new(0),
    anchor: Mutex::new(POINT { x: 0, y: 0 }),
    pushes: AtomicU32::new(0),
    acc_x: AtomicI32::new(0),
    acc_y: AtomicI32::new(0),
    held: AtomicU8::new(0),
    started: AtomicBool::new(false),
};

fn emit(ev: CaptureEv) {
    if let Some(tx) = S.tx.lock().as_ref() {
        let _ = tx.send(Event::Capture(ev));
    }
}

/// Запустить хуки (один раз за процесс).
pub fn start(tx: Sender<Event>) {
    *S.tx.lock() = Some(tx);
    if S.started.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("dotlink-capture".into())
        .spawn(|| unsafe {
            let module = GetModuleHandleW(None).map(|h| HINSTANCE(h.0)).ok();
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
            let keys = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_proc), module, 0);
            if mouse.is_err() || keys.is_err() {
                tracing::warn!("хуки мыши и клавиатуры не установлены — мышь ПК на телефон недоступна");
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        })
        .ok();
    // движения склеиваются и уходят телефону 125 раз в секунду, а не с частотой опроса мыши (до 8 кГц)
    std::thread::Builder::new()
        .name("dotlink-capture-flush".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(8));
            let (x, y) = (S.acc_x.swap(0, Ordering::Relaxed), S.acc_y.swap(0, Ordering::Relaxed));
            if (x != 0 || y != 0) && S.capturing.load(Ordering::Relaxed) {
                emit(CaptureEv::Move(x, y));
            }
        })
        .ok();
}

pub fn set_edge(edge: &str) {
    S.edge.store(edge_code(edge), Ordering::Relaxed);
}

pub fn set_capture(on: bool) {
    let was = S.capturing.swap(on, Ordering::SeqCst);
    if on && !was {
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        *S.anchor.lock() = p;
        S.acc_x.store(0, Ordering::Relaxed);
        S.acc_y.store(0, Ordering::Relaxed);
        let mut held = 0u8;
        for (i, vk) in [0x01, 0x02, 0x04, 0x05, 0x06].iter().enumerate() {
            if unsafe { GetAsyncKeyState(*vk) } as u16 & 0x8000 != 0 {
                held |= 1 << i;
            }
        }
        S.held.store(held, Ordering::Relaxed);
    } else if !on && was {
        // курсор чуть отходит от края, чтобы сразу не уйти обратно на телефон
        let (vx, vy, vw, vh) = screen();
        let p = *S.anchor.lock();
        let (x, y) = match S.edge.load(Ordering::Relaxed) {
            1 => (vx + 40, p.y),
            2 => (vx + vw - 41, p.y),
            3 => (p.x, vy + 40),
            4 => (p.x, vy + vh - 41),
            _ => (p.x, p.y),
        };
        unsafe {
            let _ = SetCursorPos(x, y);
        }
        S.pushes.store(0, Ordering::Relaxed);
    }
}

fn screen() -> (i32, i32, i32, i32) {
    unsafe {
        (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN))
    }
}

fn button_of(msg: u32, data: u32) -> Option<(MouseButton, bool, u8)> {
    Some(match msg {
        WM_LBUTTONDOWN => (MouseButton::Left, true, 0),
        WM_LBUTTONUP => (MouseButton::Left, false, 0),
        WM_RBUTTONDOWN => (MouseButton::Right, true, 1),
        WM_RBUTTONUP => (MouseButton::Right, false, 1),
        WM_MBUTTONDOWN => (MouseButton::Middle, true, 2),
        WM_MBUTTONUP => (MouseButton::Middle, false, 2),
        WM_XBUTTONDOWN | WM_XBUTTONUP => {
            let x2 = (data >> 16) & 0xFFFF == 2;
            (if x2 { MouseButton::X2 } else { MouseButton::X1 }, msg == WM_XBUTTONDOWN, if x2 { 4 } else { 3 })
        }
        _ => return None,
    })
}

/// true — событие поглощено (не дойдёт до Windows).
fn on_mouse(msg: u32, m: &MSLLHOOKSTRUCT) -> bool {
    if S.capturing.load(Ordering::Relaxed) {
        match msg {
            WM_MOUSEMOVE => {
                let a = *S.anchor.lock();
                S.acc_x.fetch_add(m.pt.x - a.x, Ordering::Relaxed);
                S.acc_y.fetch_add(m.pt.y - a.y, Ordering::Relaxed);
            }
            WM_MOUSEWHEEL => emit(CaptureEv::Scroll((m.mouseData >> 16) as u16 as i16 as i32, 0)),
            WM_MOUSEHWHEEL => emit(CaptureEv::Scroll(0, (m.mouseData >> 16) as u16 as i16 as i32)),
            _ => {
                if let Some((b, down, bit)) = button_of(msg, m.mouseData) {
                    let held = S.held.load(Ordering::Relaxed);
                    if !down && held & (1 << bit) != 0 {
                        S.held.fetch_and(!(1 << bit), Ordering::Relaxed);
                        return false;
                    }
                    emit(CaptureEv::Button(b, down));
                }
            }
        }
        return true;
    }
    if msg == WM_MOUSEMOVE {
        let edge = S.edge.load(Ordering::Relaxed);
        if edge == 0 {
            return false;
        }
        let (vx, vy, vw, vh) = screen();
        let at = match edge {
            1 => m.pt.x <= vx,
            2 => m.pt.x >= vx + vw - 1,
            3 => m.pt.y <= vy,
            _ => m.pt.y >= vy + vh - 1,
        };
        if !at {
            S.pushes.store(0, Ordering::Relaxed);
        } else if S.pushes.fetch_add(1, Ordering::Relaxed) + 1 == 6 {
            // несколько движений подряд в упор — намеренно, а не случайно задели край
            emit(CaptureEv::Edge);
        }
    }
    false
}

fn down(vk: i32) -> bool {
    unsafe { GetAsyncKeyState(vk) as u16 & 0x8000 != 0 }
}

/// Символ нажатой клавиши в раскладке активного окна — без изменения состояния мёртвых клавиш.
fn chars(vk: u32, scan: u32) -> String {
    let mut state = [0u8; 256];
    for k in [VK_SHIFT, 0xA0, 0xA1, VK_CONTROL, VK_MENU, 0x14] {
        let d = down(k as i32);
        let toggled = k == 0x14 && unsafe { GetAsyncKeyState(0x14) } & 1 != 0;
        state[k as usize] = if d { 0x80 } else { 0 } | if toggled { 1 } else { 0 };
    }
    let mut buf = [0u16; 8];
    let n = unsafe {
        let tid = GetWindowThreadProcessId(GetForegroundWindow(), None);
        ToUnicodeEx(vk, scan, &state, &mut buf, 0x4, Some(GetKeyboardLayout(tid)))
    };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize]).chars().filter(|c| !c.is_control()).collect()
}

fn on_key(k: &KBDLLHOOKSTRUCT) -> bool {
    let up = k.flags.contains(LLKHF_UP);
    let vk = k.vkCode;
    let ctrl_alt = down(VK_CONTROL as i32) && down(VK_MENU as i32);
    let capturing = S.capturing.load(Ordering::Relaxed);
    if !up && ctrl_alt && vk == VK_RIGHT && !capturing {
        emit(CaptureEv::Toggle);
        return true;
    }
    if !capturing {
        return false;
    }
    if !up && (vk == VK_ESCAPE || (ctrl_alt && vk == VK_LEFT)) {
        emit(CaptureEv::Exit);
        return true;
    }
    // отпускание модификаторов видит и Windows — их нажатие могло случиться до захвата
    if up && MODIFIERS.contains(&vk) {
        emit(CaptureEv::Key { vk: vk as u16, down: false });
        return false;
    }
    emit(CaptureEv::Key { vk: vk as u16, down: !up });
    if !up && !down(VK_CONTROL as i32) && !down(VK_MENU as i32) {
        let t = chars(vk, k.scanCode);
        if !t.is_empty() {
            emit(CaptureEv::Text(t));
        }
    }
    true
}

unsafe extern "system" fn mouse_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let m = unsafe { &*(l.0 as *const MSLLHOOKSTRUCT) };
        if m.flags & LLMHF_INJECTED == 0 && on_mouse(w.0 as u32, m) {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}

unsafe extern "system" fn key_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = unsafe { &*(l.0 as *const KBDLLHOOKSTRUCT) };
        if !k.flags.contains(LLKHF_INJECTED) && on_key(k) {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}
