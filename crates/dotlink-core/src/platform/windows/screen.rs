//! Снимок экрана ПК для телефона: GDI StretchBlt сразу в уменьшенный DIB (масштаб делает видеокарта
//! драйвером GDI), сверху — текущий курсор. Около 5–15 мс на кадр 1280 px — хватает на 15–20 к/с.

use crate::platform::{Monitor, Shot};
use windows::core::BOOL;
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetMonitorInfoW, ReleaseDC, SelectObject, SetBrushOrgEx,
    SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HDC, HGDIOBJ, HMONITOR, MONITORINFO, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, HICON, ICONINFO, MONITORINFOF_PRIMARY,
};

unsafe extern "system" fn each(hmon: HMONITOR, _: HDC, _: *mut RECT, l: LPARAM) -> BOOL {
    let v = unsafe { &mut *(l.0 as *mut Vec<Monitor>) };
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if unsafe { GetMonitorInfoW(hmon, &mut mi) }.as_bool() {
        let r = mi.rcMonitor;
        v.push(Monitor {
            x: r.left,
            y: r.top,
            w: (r.right - r.left).max(1) as u32,
            h: (r.bottom - r.top).max(1) as u32,
            primary: mi.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    BOOL(1)
}

/// Мониторы, основной — первым, остальные слева направо.
pub fn monitors() -> Vec<Monitor> {
    let mut v: Vec<Monitor> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut v as *mut _ as isize));
    }
    v.sort_by_key(|m| (!m.primary, m.x, m.y));
    v
}

pub fn shot(m: &Monitor, max_w: u32) -> Option<Shot> {
    let w = (max_w.min(m.w).max(16)) & !1;
    let h = ((m.h as u64 * w as u64 / m.w as u64) as u32).max(16) & !1;
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // строки сверху вниз
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let Ok(dib) = CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) else {
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return None;
        };
        let old = SelectObject(mem, HGDIOBJ(dib.0));
        SetStretchBltMode(mem, HALFTONE);
        let _ = SetBrushOrgEx(mem, 0, 0, None);
        let ok = StretchBlt(mem, 0, 0, w as i32, h as i32, Some(screen), m.x, m.y, m.w as i32, m.h as i32, SRCCOPY | CAPTUREBLT).as_bool();
        if ok {
            draw_cursor(mem, m, w);
        }
        let out = if ok && !bits.is_null() {
            let mut px = std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize).to_vec();
            // GDI не заполняет альфу
            for a in px.iter_mut().skip(3).step_by(4) {
                *a = 255;
            }
            Some(Shot { w, h, bgra: px })
        } else {
            None
        };
        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(dib.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        out
    }
}

/// Курсор поверх снимка — в масштабе кадра (иначе на уменьшенном экране его не найти).
unsafe fn draw_cursor(mem: HDC, m: &Monitor, w: u32) {
    let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    if unsafe { GetCursorInfo(&mut ci) }.is_err() || ci.flags.0 & CURSOR_SHOWING.0 == 0 {
        return;
    }
    let p = ci.ptScreenPos;
    if p.x < m.x || p.y < m.y || p.x >= m.x + m.w as i32 || p.y >= m.y + m.h as i32 {
        return;
    }
    let icon = HICON(ci.hCursor.0);
    let mut ii = ICONINFO::default();
    let (hx, hy) = if unsafe { GetIconInfo(icon, &mut ii) }.is_ok() {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
        (ii.xHotspot as i32, ii.yHotspot as i32)
    } else {
        (0, 0)
    };
    let k = w as f32 / m.w as f32;
    // на сильно уменьшенном кадре курсор не мельче 14 px
    let size = (32.0 * k).max(14.0) as i32;
    let s = size as f32 / 32.0;
    let x = ((p.x - m.x) as f32 * k - hx as f32 * s) as i32;
    let y = ((p.y - m.y) as f32 * k - hy as f32 * s) as i32;
    unsafe {
        let _ = DrawIconEx(mem, x, y, icon, size, size, 0, None, DI_NORMAL);
    }
}
