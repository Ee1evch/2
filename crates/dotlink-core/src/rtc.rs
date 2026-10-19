//! WebRTC: прямой канал телефон ↔ ПК — в одной сети и через NAT в разных сетях (STUN; TURN — по желанию).
//! Сигналинг (SDP и ICE-кандидаты) идёт внутри уже установленной зашифрованной сессии,
//! поэтому подменить его по дороге — в том числе ретранслятору — нельзя.
//! Каналы: «ctl» — надёжный и упорядоченный (команды, состояние), «fast» — без повторов и порядка,
//! как UDP: потерянное движение не задерживает следующие.

use crate::store::IceServer;
use bytes::BytesMut;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionIceEvent,
    RTCPeerConnectionState, RTCSessionDescription,
};

/// Сообщения DataChannel в webrtc-rs — до 16 КБ; крупнее (обложки, видео) идут основным каналом.
pub const MAX_DC_MESSAGE: usize = 16_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Ctl,
    Fast,
}

#[derive(Debug)]
pub enum RtcEvent {
    Open(Kind),
    Msg(Kind, Vec<u8>),
    Ice(Value),
    Closed,
}

type Slot = Arc<Mutex<Option<Arc<dyn DataChannel>>>>;

pub struct Rtc {
    pc: Arc<dyn PeerConnection>,
    ctl: Slot,
    fast: Slot,
}

#[derive(Clone)]
struct Handler {
    events: mpsc::Sender<RtcEvent>,
    ctl: Slot,
    fast: Slot,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(init) = event.candidate.to_json() {
            if let Ok(v) = serde_json::to_value(init) {
                let _ = self.events.send(RtcEvent::Ice(v)).await;
            }
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
            let _ = self.events.send(RtcEvent::Closed).await;
        }
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let kind = match dc.label().await.as_deref() {
            Ok("ctl") => Kind::Ctl,
            Ok("fast") => Kind::Fast,
            _ => return,
        };
        let slot = if kind == Kind::Ctl { self.ctl.clone() } else { self.fast.clone() };
        let events = self.events.clone();
        tokio::spawn(async move {
            while let Some(e) = dc.poll().await {
                match e {
                    DataChannelEvent::OnOpen => {
                        *slot.lock().await = Some(dc.clone());
                        let _ = events.send(RtcEvent::Open(kind)).await;
                    }
                    DataChannelEvent::OnMessage(m) => {
                        if events.send(RtcEvent::Msg(kind, m.data.to_vec())).await.is_err() {
                            break;
                        }
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
            *slot.lock().await = None;
            let _ = events.send(RtcEvent::Closed).await;
        });
    }
}

impl Rtc {
    /// Ответ на предложение телефона. Кандидаты ПК уходят по одному через `RtcEvent::Ice` (trickle).
    pub async fn answer(offer: Value, ice: &[IceServer], events: mpsc::Sender<RtcEvent>) -> anyhow::Result<(Self, Value)> {
        let offer: RTCSessionDescription = serde_json::from_value(offer)?;
        let ice_servers = ice.iter().map(|s| RTCIceServer { urls: s.urls.clone(), username: s.username.clone(), credential: s.credential.clone() }).collect();
        let config = RTCConfigurationBuilder::new().with_ice_servers(ice_servers).build();
        let handler = Handler { events, ctl: Arc::default(), fast: Arc::default() };
        let (ctl, fast) = (handler.ctl.clone(), handler.fast.clone());
        let pc = PeerConnectionBuilder::new().with_configuration(config).with_handler(Arc::new(handler)).with_udp_addrs(vec!["0.0.0.0:0"]).build().await?;
        let pc: Arc<dyn PeerConnection> = Arc::new(pc);
        pc.set_remote_description(offer).await?;
        let answer = pc.create_answer(None).await?;
        pc.set_local_description(answer.clone()).await?;
        let local = pc.local_description().await.unwrap_or(answer);
        Ok((Self { pc, ctl, fast }, serde_json::to_value(local)?))
    }

    pub async fn add_candidate(&self, c: Value) -> anyhow::Result<()> {
        let init: RTCIceCandidateInit = serde_json::from_value(c)?;
        if init.candidate.is_empty() {
            return Ok(()); // «конец кандидатов»
        }
        self.pc.add_ice_candidate(init).await?;
        Ok(())
    }

    /// Отправить, если канал открыт и кадр помещается; иначе `false` — пусть идёт основным путём.
    pub async fn send(&self, kind: Kind, data: &[u8]) -> bool {
        if data.len() > MAX_DC_MESSAGE {
            return false;
        }
        let slot = if kind == Kind::Ctl { &self.ctl } else { &self.fast };
        let dc = slot.lock().await.clone();
        let Some(dc) = dc else { return false };
        let buf = BytesMut::from(data);
        match kind {
            Kind::Ctl => dc.send(buf).await.is_ok(),
            // для движений лучше потерять кадр, чем копить очередь
            Kind::Fast => dc.try_send(buf).await.is_ok(),
        }
    }

    pub async fn ready(&self) -> bool {
        self.ctl.lock().await.is_some()
    }

    pub async fn close(&self) {
        let _ = self.pc.close().await;
    }
}
