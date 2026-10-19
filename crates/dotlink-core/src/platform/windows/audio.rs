//! Громкость через Core Audio. Изменения на ПК приходят колбэком IAudioEndpointVolumeCallback —
//! телефон узнаёт о них мгновенно, без опроса. Смена устройства вывода проверяется раз в секунду.

use crate::platform::Event;
use parking_lot::Mutex;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use windows::core::{implement, Result, GUID};
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl};
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

pub enum Cmd {
    Set(f32),
    Mute(bool),
}

#[implement(IAudioEndpointVolumeCallback)]
struct Callback {
    tx: Mutex<Sender<Event>>,
}

impl IAudioEndpointVolumeCallback_Impl for Callback_Impl {
    fn OnNotify(&self, pnotify: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> Result<()> {
        if let Some(d) = unsafe { pnotify.as_ref() } {
            let _ = self.tx.lock().send(Event::Volume { level: d.fMasterVolume, muted: d.bMuted.as_bool() });
        }
        Ok(())
    }
}

fn default_id(en: &IMMDeviceEnumerator) -> Option<String> {
    unsafe {
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let p = dev.GetId().ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as _));
        s
    }
}

pub fn spawn(events: Sender<Event>, rx: Receiver<Cmd>) {
    std::thread::Builder::new()
        .name("dotlink-audio".into())
        .spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return };
            loop {
                let id = default_id(&en);
                let ep: Option<IAudioEndpointVolume> = en.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|d| d.Activate(CLSCTX_ALL, None).ok());
                let cb: IAudioEndpointVolumeCallback = Callback { tx: Mutex::new(events.clone()) }.into();
                if let Some(ep) = &ep {
                    let _ = ep.RegisterControlChangeNotify(&cb);
                    let level = ep.GetMasterVolumeLevelScalar().unwrap_or(0.0);
                    let muted = ep.GetMute().map(|b| b.as_bool()).unwrap_or(false);
                    let _ = events.send(Event::Volume { level, muted });
                }
                loop {
                    match rx.recv_timeout(Duration::from_secs(1)) {
                        Ok(cmd) => {
                            if let Some(ep) = &ep {
                                let ctx: *const GUID = std::ptr::null();
                                let _ = match cmd {
                                    Cmd::Set(v) => ep.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0), ctx),
                                    Cmd::Mute(m) => ep.SetMute(m, ctx),
                                };
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            if default_id(&en) != id {
                                break; // сменились колонки/наушники — подписываемся заново
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                if let Some(ep) = &ep {
                    let _ = ep.UnregisterControlChangeNotify(&cb);
                }
            }
        })
        .ok();
}
