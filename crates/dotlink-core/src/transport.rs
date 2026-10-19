//! Каналы связи. Сессия не знает, как пришли байты: WebSocket в локальной сети, труба через
//! ретранслятор в интернете или Bluetooth RFCOMM — всё сводится к `Wire`: очередь входящих и
//! исходящих сообщений (текст до входа, бинарные кадры после).

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub enum Msg {
    Text(String),
    Bin(Vec<u8>),
}

/// Каким путём подключено устройство — видно в дашборде и на телефоне.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Lan,
    Relay,
    Bt,
}

pub struct Wire {
    pub tx: mpsc::Sender<Msg>,
    pub rx: mpsc::Receiver<Msg>,
    pub via: Via,
    /// адрес собеседника для журнала и списка устройств
    pub peer: String,
    /// подключение с этого же ПК (только так входит дашборд)
    pub loopback: bool,
}

const QUEUE: usize = 256;
/// Предел кадра для потоковых каналов (Bluetooth).
pub const MAX_FRAME: usize = 4 << 20;

/// WebSocket сервера axum (локальная сеть).
pub fn from_axum(ws: axum::extract::ws::WebSocket, via: Via, peer: String, loopback: bool) -> Wire {
    use axum::extract::ws::Message as M;
    let (mut sink, mut stream) = ws.split();
    let (in_tx, in_rx) = mpsc::channel(QUEUE);
    let (out_tx, mut out_rx) = mpsc::channel::<Msg>(QUEUE);
    tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            let r = match m {
                Msg::Text(t) => sink.send(M::Text(t.into())).await,
                Msg::Bin(b) => sink.send(M::Binary(b.into())).await,
            };
            if r.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    tokio::spawn(async move {
        while let Some(Ok(m)) = stream.next().await {
            let m = match m {
                M::Text(t) => Msg::Text(t.to_string()),
                M::Binary(b) => Msg::Bin(b.to_vec()),
                M::Close(_) => break,
                _ => continue,
            };
            if in_tx.send(m).await.is_err() {
                break;
            }
        }
    });
    Wire { tx: out_tx, rx: in_rx, via, peer, loopback }
}

/// WebSocket-клиент tungstenite (труба через ретранслятор).
pub fn from_tungstenite<S>(ws: tokio_tungstenite::WebSocketStream<S>, via: Via, peer: String) -> Wire
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use tokio_tungstenite::tungstenite::Message as M;
    let (mut sink, mut stream) = ws.split();
    let (in_tx, in_rx) = mpsc::channel(QUEUE);
    let (out_tx, mut out_rx) = mpsc::channel::<Msg>(QUEUE);
    tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            let r = match m {
                Msg::Text(t) => sink.send(M::Text(t.into())).await,
                Msg::Bin(b) => sink.send(M::Binary(b.into())).await,
            };
            if r.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    tokio::spawn(async move {
        while let Some(Ok(m)) = stream.next().await {
            let m = match m {
                M::Text(t) => Msg::Text(t.to_string()),
                M::Binary(b) => Msg::Bin(b.to_vec()),
                M::Close(_) => break,
                _ => continue,
            };
            if in_tx.send(m).await.is_err() {
                break;
            }
        }
    });
    Wire { tx: out_tx, rx: in_rx, via, peer, loopback: false }
}

/// Поток байтов (Bluetooth RFCOMM): кадр = 1 байт типа (0 текст, 1 данные) + u32 длина (BE) + тело.
pub fn from_stream<R, W>(mut r: R, mut w: W, via: Via, peer: String) -> Wire
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (in_tx, in_rx) = mpsc::channel(QUEUE);
    let (out_tx, mut out_rx) = mpsc::channel::<Msg>(QUEUE);
    tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if w.write_all(&encode_frame(&m)).await.is_err() || w.flush().await.is_err() {
                break;
            }
        }
        let _ = w.shutdown().await;
    });
    tokio::spawn(async move {
        loop {
            let mut head = [0u8; 5];
            if r.read_exact(&mut head).await.is_err() {
                break;
            }
            let len = u32::from_be_bytes(head[1..5].try_into().unwrap()) as usize;
            if len > MAX_FRAME {
                break;
            }
            let mut body = vec![0u8; len];
            if r.read_exact(&mut body).await.is_err() {
                break;
            }
            let m = match head[0] {
                0 => match String::from_utf8(body) {
                    Ok(t) => Msg::Text(t),
                    Err(_) => break,
                },
                _ => Msg::Bin(body),
            };
            if in_tx.send(m).await.is_err() {
                break;
            }
        }
    });
    Wire { tx: out_tx, rx: in_rx, via, peer, loopback: false }
}

pub fn encode_frame(m: &Msg) -> Vec<u8> {
    let (kind, body): (u8, &[u8]) = match m {
        Msg::Text(t) => (0, t.as_bytes()),
        Msg::Bin(b) => (1, b),
    };
    let mut out = Vec::with_capacity(5 + body.len());
    out.push(kind);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stream_framing_roundtrip() {
        let (a, b) = tokio::io::duplex(1 << 16);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let wa = from_stream(ar, aw, Via::Bt, "a".into());
        let mut wb = from_stream(br, bw, Via::Bt, "b".into());
        wa.tx.send(Msg::Text("привет".into())).await.unwrap();
        wa.tx.send(Msg::Bin(vec![1, 2, 3])).await.unwrap();
        assert!(matches!(wb.rx.recv().await.unwrap(), Msg::Text(t) if t == "привет"));
        assert!(matches!(wb.rx.recv().await.unwrap(), Msg::Bin(b) if b == [1, 2, 3]));
    }
}
