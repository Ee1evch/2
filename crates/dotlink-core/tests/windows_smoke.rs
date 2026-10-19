//! Смоук-тест Windows-слоя на настоящей Windows (CI windows-latest): наблюдатели запускаются,
//! события приходят, вызовы ввода и буфера не падают. Звука и экрана у раннера может не быть —
//! такие события печатаются, но не обязательны.
#![cfg(windows)]

use dotlink_core::platform::{Clip, Event, KeyAction};
use std::time::{Duration, Instant};

#[test]
fn windows_platform_smoke() {
    let p = dotlink_core::platform::native();
    assert_eq!(p.name(), "windows");
    let (tx, rx) = std::sync::mpsc::channel();
    p.start(tx);

    // ввод: курсор туда и обратно, Shift — безобидная клавиша
    p.mouse_move(5, 5);
    p.mouse_move(-5, -5);
    p.key(0x10, KeyAction::Press);
    p.scroll(0, 0);
    println!("батарея: {:?}", p.battery());
    println!("общественная сеть: {:?}", p.network_public());
    println!("загрузки: {}", p.downloads_dir().display());

    let marker = format!("dotlink-smoke-{}", std::process::id());
    let clip = p.set_clipboard(Clip::Text(marker.clone()));
    println!("буфер: {clip:?}");

    let t0 = Instant::now();
    let mut seen_clip = false;
    while t0.elapsed() < Duration::from_secs(4) {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Event::Clipboard(Clip::Text(t))) if t == marker => seen_clip = true,
            Ok(e) => println!("событие: {e:?}"),
            Err(_) => {}
        }
    }
    if clip.is_ok() {
        assert!(seen_clip, "наблюдатель буфера не увидел текст, который мы сами положили");
    }
}
