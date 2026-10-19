//! Текущий трек и управление плеером через системные медиаэлементы Windows (GSMTC):
//! работает со Spotify, браузерами, «Медиаплеером» и всем, что показывает плашку громкости Windows.

use crate::platform::{Event, MediaAction, MediaInfo};
use base64::Engine;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

fn app_name(aumid: &str) -> String {
    // «Spotify.exe», «Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic», «308046B0AF4A39CB»
    let s = aumid.rsplit('!').next().unwrap_or(aumid);
    let s = s.rsplit('\\').next().unwrap_or(s);
    let s = s.trim_end_matches(".exe").trim_end_matches(".EXE");
    let s = s.rsplit('.').next().unwrap_or(s);
    match s.to_ascii_lowercase().as_str() {
        "msedge" => "Edge".into(),
        "chrome" => "Chrome".into(),
        "firefox" => "Firefox".into(),
        "zunemusic" => "Медиаплеер".into(),
        _ => s.to_string(),
    }
}

/// 100-нс интервалы с 1601 года → секунды Unix.
fn filetime_secs(t: i64) -> f64 {
    t as f64 / 1e7 - 11_644_473_600.0
}

fn read(mgr: &Manager, want_art: bool) -> windows::core::Result<Option<(MediaInfo, Option<String>)>> {
    let Ok(s) = mgr.GetCurrentSession() else { return Ok(None) };
    let props = s.TryGetMediaPropertiesAsync()?.get()?;
    let pb = s.GetPlaybackInfo()?;
    let playing = pb.PlaybackStatus()? == Status::Playing;
    let tl = s.GetTimelineProperties()?;
    let mut position = tl.Position()?.Duration as f64 / 1e7;
    let duration = (tl.EndTime()?.Duration - tl.StartTime()?.Duration) as f64 / 1e7;
    // плееры обновляют позицию редко — досчитываем от момента обновления
    if playing {
        if let Ok(upd) = tl.LastUpdatedTime() {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
            let dt = now - filetime_secs(upd.UniversalTime);
            if (0.0..86_400.0).contains(&dt) {
                position += dt;
            }
        }
    }
    if duration > 0.0 {
        position = position.min(duration);
    }
    let info = MediaInfo {
        title: props.Title()?.to_string(),
        artist: props.Artist()?.to_string(),
        album: props.AlbumTitle().map(|a| a.to_string()).unwrap_or_default(),
        app: app_name(&s.SourceAppUserModelId().map(|a| a.to_string()).unwrap_or_default()),
        playing,
        position: position.max(0.0),
        duration: duration.max(0.0),
        art: None,
    };
    let art = if want_art { thumbnail(&props).ok().flatten() } else { None };
    Ok(Some((info, art)))
}

fn thumbnail(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> windows::core::Result<Option<String>> {
    let Ok(r) = props.Thumbnail() else { return Ok(None) };
    let stream = r.OpenReadAsync()?.get()?;
    let size = stream.Size()?;
    if size == 0 || size > 600_000 {
        return Ok(None);
    }
    let ctype = stream.ContentType().map(|c| c.to_string()).unwrap_or_else(|_| "image/png".into());
    let reader = DataReader::CreateDataReader(&stream)?;
    reader.LoadAsync(size as u32)?.get()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf)?;
    let ctype = if ctype.starts_with("image/") { ctype } else { "image/png".into() };
    Ok(Some(format!("data:{ctype};base64,{}", base64::engine::general_purpose::STANDARD.encode(&buf))))
}

fn act(s: &Session, a: MediaAction) -> windows::core::Result<bool> {
    let op = match a {
        MediaAction::Toggle => s.TryTogglePlayPauseAsync()?,
        MediaAction::Play => s.TryPlayAsync()?,
        MediaAction::Pause => s.TryPauseAsync()?,
        MediaAction::Next => s.TrySkipNextAsync()?,
        MediaAction::Prev => s.TrySkipPreviousAsync()?,
        MediaAction::Stop => s.TryStopAsync()?,
    };
    op.get()
}

/// `fallback` — медиаклавиши, если сеанса GSMTC нет (старые плееры).
pub fn spawn(events: Sender<Event>, rx: Receiver<MediaAction>, fallback: impl Fn(MediaAction) + Send + 'static) {
    std::thread::Builder::new()
        .name("dotlink-media".into())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let mgr = Manager::RequestAsync().and_then(|op| op.get()).ok();
            let mut last: Option<MediaInfo> = None;
            let mut last_key = String::new();
            loop {
                let wait = match rx.recv_timeout(Duration::from_millis(700)) {
                    Ok(a) => {
                        let done = mgr.as_ref().and_then(|m| m.GetCurrentSession().ok()).map(|s| act(&s, a).unwrap_or(false)).unwrap_or(false);
                        if !done {
                            fallback(a);
                        }
                        true
                    }
                    Err(RecvTimeoutError::Timeout) => false,
                    Err(RecvTimeoutError::Disconnected) => return,
                };
                if wait {
                    std::thread::sleep(Duration::from_millis(120)); // плееру нужно мгновение, чтобы сменить трек
                }
                let Some(mgr) = &mgr else { continue };
                match read(mgr, true) {
                    Ok(Some((info, art))) => {
                        let key = format!("{}\u{1}{}", info.title, info.artist);
                        let new_track = key != last_key;
                        if new_track || last.as_ref() != Some(&info) {
                            let mut out = info.clone();
                            // обложку отправляем только при смене трека — она бывает большой
                            out.art = if new_track { art.or(Some(String::new())) } else { None };
                            let _ = events.send(Event::Media(Some(out)));
                            last = Some(info);
                            last_key = key;
                        }
                    }
                    Ok(None) => {
                        if last.take().is_some() {
                            last_key.clear();
                            let _ = events.send(Event::Media(None));
                        }
                    }
                    Err(_) => {}
                }
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_names() {
        assert_eq!(super::app_name("Spotify.exe"), "Spotify");
        assert_eq!(super::app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Медиаплеер");
        assert_eq!(super::app_name("MSEdge"), "Edge");
    }
}
