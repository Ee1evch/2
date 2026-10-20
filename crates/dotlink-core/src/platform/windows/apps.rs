//! Командная палитра на Windows: приложения из меню «Пуск», открытые окна, переход к окну
//! и действия над активным окном.

use crate::platform::{Launchable, WindowInfo};
use std::path::{Path, PathBuf};
use windows::core::BOOL;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, PostMessageW, SetForegroundWindow, ShowWindow, GWL_EXSTYLE, GW_OWNER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WS_EX_TOOLWINDOW,
};

// ───────── меню «Пуск» ─────────

/// Ярлыки, которые не нужны в палитре.
fn junk(name: &str) -> bool {
    let n = name.to_lowercase();
    ["uninstall", "удал", "readme", "help", "справк", "documentation", "license", "release notes", "website", "сайт"].iter().any(|w| n.contains(w))
}

fn scan(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth < 4 {
                scan(&p, depth + 1, out);
            }
        } else if matches!(p.extension().and_then(|x| x.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("lnk" | "url" | "appref-ms")) {
            out.push(p);
        }
    }
}

/// Короткий устойчивый id ярлыка (FNV-1a от пути) — путь телефону не виден.
fn short_id(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub fn launchables() -> Vec<Launchable> {
    let mut files = Vec::new();
    for var in ["ProgramData", "APPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            scan(&PathBuf::from(base).join(r"Microsoft\Windows\Start Menu\Programs"), 0, &mut files);
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Launchable> = files
        .into_iter()
        .filter_map(|p| {
            let name = p.file_stem()?.to_string_lossy().trim().to_string();
            if name.is_empty() || junk(&name) || !seen.insert(name.to_lowercase()) {
                return None;
            }
            let target = p.to_string_lossy().to_string();
            Some(Launchable { id: short_id(&target), name, icon: None, target })
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

// ───────── окна ─────────

fn app_of(hwnd: HWND) -> String {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut path = [0u16; 1024];
        let mut len = path.len() as u32;
        let app = if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut len).is_ok() {
            let p = String::from_utf16_lossy(&path[..len as usize]);
            Path::new(&p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
        } else {
            String::new()
        };
        let _ = CloseHandle(h);
        app
    }
}

/// Окно, которое человек видит на панели задач: видимое, с заголовком, без владельца,
/// не инструментальное и не «спрятанное» DWM (окна приложений UWP в фоне).
fn listed(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
            return false;
        }
        if GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.0.is_null()) {
            return false;
        }
        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        let mut cloaked = 0u32;
        let ok = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok();
        !(ok && cloaked != 0)
    }
}

unsafe extern "system" fn collect(hwnd: HWND, l: LPARAM) -> BOOL {
    let v = unsafe { &mut *(l.0 as *mut Vec<HWND>) };
    if listed(hwnd) {
        v.push(hwnd);
    }
    BOOL(1)
}

pub fn windows() -> Vec<WindowInfo> {
    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut hwnds as *mut _ as isize));
    }
    hwnds
        .into_iter()
        .take(40)
        .map(|h| {
            let mut buf = [0u16; 512];
            let n = unsafe { GetWindowTextW(h, &mut buf) };
            WindowInfo { id: h.0 as usize as u64, title: String::from_utf16_lossy(&buf[..n.max(0) as usize]), app: app_of(h) }
        })
        .filter(|w| !w.title.is_empty())
        .collect()
}

/// Перевести окно на передний план. Windows разрешает это только «активному» процессу,
/// поэтому ненадолго присоединяемся к потоку текущего активного окна.
pub fn focus(id: u64) {
    let hwnd = HWND(id as usize as *mut _);
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return;
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let fg = GetForegroundWindow();
        let fg_tid = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        let attached = fg_tid != 0 && fg_tid != me && AttachThreadInput(me, fg_tid, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(me, fg_tid, false);
        }
    }
}

/// Свернуть, развернуть, восстановить или закрыть активное окно. `false` — действие не про окно
/// (его выполняет сочетание клавиш).
pub fn act(action: &str) -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return true;
        }
        match action {
            "minimize" => {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            }
            "maximize" => {
                let _ = ShowWindow(hwnd, if windows::Win32::UI::WindowsAndMessaging::IsZoomed(hwnd).as_bool() { SW_RESTORE } else { SW_MAXIMIZE });
            }
            "restore" => {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            "close" => {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
            _ => return false,
        }
    }
    true
}
