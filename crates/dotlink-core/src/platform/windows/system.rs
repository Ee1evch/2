//! Питание, активное окно, буфер обмена, батарея, запуск программ, сеть и брандмауэр.

use crate::platform::{Battery, Clip, Event, PowerAction};
use anyhow::{bail, Context};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HGLOBAL, HWND, LPARAM, LUID, POINT, WPARAM};
use windows::Win32::Networking::NetworkListManager::{INetworkListManager, NetworkListManager, NLM_ENUM_NETWORK_CONNECTED, NLM_NETWORK_CATEGORY_PUBLIC};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED, SE_SHUTDOWN_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
    TOKEN_QUERY,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};
use windows::Win32::System::Power::{GetSystemPowerStatus, SetSuspendState, SYSTEM_POWER_STATUS};
use windows::Win32::System::Shutdown::{
    ExitWindowsEx, LockWorkStation, EWX_FORCEIFHUNG, EWX_LOGOFF, EWX_POWEROFF, EWX_REBOOT, SHTDN_REASON_FLAG_PLANNED, SHTDN_REASON_MAJOR_OTHER,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{DragQueryFileW, ShellExecuteW, DROPFILES, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, PostMessageW, HWND_BROADCAST, SC_MONITORPOWER, SW_HIDE, SW_SHOWNORMAL, WM_SYSCOMMAND,
};

fn enable_shutdown_privilege() -> anyhow::Result<()> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token)?;
        let mut luid = LUID::default();
        let r = LookupPrivilegeValueW(PCWSTR::null(), SE_SHUTDOWN_NAME, &mut luid).and_then(|_| {
            let tp = TOKEN_PRIVILEGES { PrivilegeCount: 1, Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }] };
            AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None)
        });
        let _ = CloseHandle(token);
        r?;
    }
    Ok(())
}

pub fn power(a: PowerAction) -> anyhow::Result<()> {
    unsafe {
        match a {
            PowerAction::Lock => LockWorkStation().context("блокировка")?,
            PowerAction::DisplayOff => PostMessageW(Some(HWND_BROADCAST), WM_SYSCOMMAND, WPARAM(SC_MONITORPOWER as usize), LPARAM(2)).context("экран")?,
            PowerAction::Sleep | PowerAction::Hibernate => {
                enable_shutdown_privilege()?;
                if !SetSuspendState(a == PowerAction::Hibernate, false, false) {
                    bail!("Windows не перевела ПК в {}", if a == PowerAction::Sleep { "сон" } else { "гибернацию" });
                }
            }
            PowerAction::Restart | PowerAction::Shutdown | PowerAction::Logoff => {
                enable_shutdown_privilege()?;
                let flags = match a {
                    PowerAction::Restart => EWX_REBOOT,
                    PowerAction::Shutdown => EWX_POWEROFF,
                    _ => EWX_LOGOFF,
                };
                ExitWindowsEx(flags | EWX_FORCEIFHUNG, SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_FLAG_PLANNED).context("завершение работы")?;
            }
        }
    }
    Ok(())
}

pub fn battery() -> Option<Battery> {
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
    // 128 — батареи нет, 255 — неизвестно
    if s.BatteryFlag == 128 || s.BatteryFlag == 255 || s.BatteryLifePercent > 100 {
        return None;
    }
    Some(Battery { percent: s.BatteryLifePercent, charging: s.ACLineStatus == 1 })
}

pub fn open(target: &str, args: &str) -> anyhow::Result<()> {
    let t = HSTRING::from(target);
    let a = HSTRING::from(args);
    let r = unsafe {
        ShellExecuteW(None, &HSTRING::from("open"), &t, if args.is_empty() { PCWSTR::null() } else { PCWSTR(a.as_ptr()) }, PCWSTR::null(), SW_SHOWNORMAL)
    };
    if r.0 as isize <= 32 {
        bail!("не удалось открыть «{target}» (код {})", r.0 as isize);
    }
    Ok(())
}

pub fn shell(cmd: &str) -> anyhow::Result<()> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .context("PowerShell")?;
    Ok(())
}

// ───────── активное окно ─────────

fn foreground() -> Option<(String, String)> {
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut app = String::new();
        if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut path = [0u16; 1024];
            let mut len = path.len() as u32;
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut len).is_ok() {
                let p = String::from_utf16_lossy(&path[..len as usize]);
                app = std::path::Path::new(&p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            }
            let _ = CloseHandle(h);
        }
        Some((title, app))
    }
}

// ───────── буфер обмена ─────────

struct ClipboardGuard;
impl ClipboardGuard {
    fn open() -> anyhow::Result<Self> {
        for _ in 0..10 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(Self);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        bail!("буфер обмена занят другой программой")
    }
}
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn read_clipboard() -> Option<Clip> {
    let _g = ClipboardGuard::open().ok()?;
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() {
            let h = GetClipboardData(CF_HDROP.0 as u32).ok()?;
            let drop = HDROP(h.0);
            let n = DragQueryFileW(drop, u32::MAX, None);
            let mut files = Vec::new();
            for i in 0..n.min(100) {
                let mut buf = [0u16; 1024];
                let len = DragQueryFileW(drop, i, Some(&mut buf));
                files.push(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])));
            }
            return Some(Clip::Files(files));
        }
        if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_ok() {
            let h = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
            let g = HGLOBAL(h.0);
            let p = GlobalLock(g) as *const u16;
            if p.is_null() {
                return None;
            }
            let max = GlobalSize(g) / 2;
            let mut len = 0;
            while len < max && *p.add(len) != 0 {
                len += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
            let _ = GlobalUnlock(g);
            return Some(Clip::Text(s));
        }
    }
    None
}

fn put_global(format: u32, bytes: &[u8]) -> anyhow::Result<()> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() {
            bail!("GlobalLock");
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(h);
        SetClipboardData(format, Some(HANDLE(h.0)))?;
    }
    Ok(())
}

pub fn set_clipboard(clip: &Clip) -> anyhow::Result<()> {
    let _g = ClipboardGuard::open()?;
    unsafe { EmptyClipboard()? };
    match clip {
        Clip::Text(t) => {
            let w: Vec<u16> = t.encode_utf16().chain(std::iter::once(0)).collect();
            put_global(CF_UNICODETEXT.0 as u32, unsafe { std::slice::from_raw_parts(w.as_ptr() as *const u8, w.len() * 2) })
        }
        Clip::Files(files) => {
            let header = DROPFILES { pFiles: std::mem::size_of::<DROPFILES>() as u32, pt: POINT::default(), fNC: false.into(), fWide: true.into() };
            let mut bytes = unsafe { std::slice::from_raw_parts(&header as *const DROPFILES as *const u8, std::mem::size_of::<DROPFILES>()) }.to_vec();
            for f in files {
                for u in f.to_string_lossy().encode_utf16().chain(std::iter::once(0)) {
                    bytes.extend_from_slice(&u.to_le_bytes());
                }
            }
            bytes.extend_from_slice(&[0, 0]);
            put_global(CF_HDROP.0 as u32, &bytes)
        }
    }
}

// ───────── сеть ─────────

/// 0 — неизвестно, 1 — частная, 2 — общественная
fn network_category() -> u8 {
    unsafe {
        let Ok(nlm) = CoCreateInstance::<_, INetworkListManager>(&NetworkListManager, None, CLSCTX_ALL) else { return 0 };
        let Ok(en) = nlm.GetNetworks(NLM_ENUM_NETWORK_CONNECTED) else { return 0 };
        let mut public = false;
        let mut any = false;
        loop {
            let mut item = [None];
            let mut fetched = 0u32;
            if en.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            if let Some(n) = item[0].take() {
                any = true;
                if n.GetCategory().map(|c| c == NLM_NETWORK_CATEGORY_PUBLIC).unwrap_or(false) {
                    public = true;
                }
            }
        }
        match (any, public) {
            (false, _) => 0,
            (true, true) => 2,
            (true, false) => 1,
        }
    }
}

pub fn allow_firewall() -> anyhow::Result<()> {
    let exe = std::env::current_exe()?;
    let args = format!("advfirewall firewall add rule name=\"DotLink\" dir=in action=allow program=\"{}\" enable=yes profile=any", exe.display());
    let r = unsafe { ShellExecuteW(None, &HSTRING::from("runas"), &HSTRING::from("netsh.exe"), &HSTRING::from(args), PCWSTR::null(), SW_HIDE) };
    if r.0 as isize <= 32 {
        bail!("нужны права администратора");
    }
    Ok(())
}

/// Наблюдатели: окно (250 мс), буфер (300 мс), категория сети (10 с).
pub fn spawn_watchers(tx: Sender<Event>, net: Arc<AtomicU8>) {
    let t = tx.clone();
    std::thread::Builder::new()
        .name("dotlink-window".into())
        .spawn(move || {
            let mut last = None;
            loop {
                let cur = foreground();
                if cur.is_some() && cur != last {
                    let (title, app) = cur.clone().unwrap();
                    if t.send(Event::Window { title, app }).is_err() {
                        return;
                    }
                    last = cur;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        })
        .ok();
    std::thread::Builder::new()
        .name("dotlink-clipboard".into())
        .spawn(move || {
            let mut seq = unsafe { GetClipboardSequenceNumber() };
            loop {
                std::thread::sleep(Duration::from_millis(300));
                let s = unsafe { GetClipboardSequenceNumber() };
                if s != seq {
                    seq = s;
                    if let Some(c) = read_clipboard() {
                        if tx.send(Event::Clipboard(c)).is_err() {
                            return;
                        }
                    }
                }
            }
        })
        .ok();
    std::thread::Builder::new()
        .name("dotlink-network".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            loop {
                net.store(network_category(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_secs(10));
            }
        })
        .ok();
}
