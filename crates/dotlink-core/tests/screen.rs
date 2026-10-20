//! Экран ПК на телефоне: поток JPEG-кадров с подтверждениями и касания по точке экрана.

use dotlink_core::crypto::{self, Channel, PairKeys};
use dotlink_core::platform::mock::MockPlatform;
use dotlink_core::platform::Platform;
use dotlink_core::util::{b64, unb64, unb64_arr};
use dotlink_core::{start, NoHost, Options};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn text(ws: &mut Ws) -> Value {
    loop {
        if let Message::Text(t) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
            return serde_json::from_str(t.as_str()).unwrap();
        }
    }
}

/// Следующий расшифрованный кадр, подходящий под условие.
async fn until(ws: &mut Ws, ch: &mut Channel, pred: impl Fn(&[u8]) -> bool) -> Vec<u8> {
    for _ in 0..400 {
        if let Message::Binary(b) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
            let p = ch.open(&b).expect("расшифровка");
            if pred(&p) {
                return p;
            }
        }
    }
    panic!("не дождались");
}

fn json_of(p: &[u8]) -> Value {
    if p.first() == Some(&b'{') {
        serde_json::from_slice(p).unwrap_or_default()
    } else {
        Value::Null
    }
}

#[tokio::test]
async fn pc_screen_streams_to_phone_and_taps_land_on_the_pc() {
    let mock = Arc::new(MockPlatform::new());
    let run =
        start(Options { data_dir: None, port: Some(0), bind: "127.0.0.1".parse().unwrap(), platform: mock.clone(), host: Arc::new(NoHost), discovery: false })
            .await
            .unwrap();
    let qr = run.core.hub.get("pairing").unwrap()["url"].as_str().unwrap().to_string();
    let secret = unb64(qr.split("pair=").nth(1).unwrap().split('&').next().unwrap()).unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", run.addr)).await.unwrap();
    let keys = PairKeys::generate();
    let nc = crypto::random::<16>();
    ws.send(Message::Text(json!({"t":"hello","v":1,"role":"remote","pair":"qr","pub":b64(&keys.public),"nonce":b64(&nc),"name":"Pixel"}).to_string().into()))
        .await
        .unwrap();
    let ch = text(&mut ws).await;
    let pub_s = unb64_arr::<32>(ch["pub"].as_str().unwrap()).unwrap();
    let ns = unb64_arr::<16>(ch["nonce"].as_str().unwrap()).unwrap();
    let z = keys.shared(&pub_s);
    let t = crypto::pair_transcript(&keys.public, &pub_s, &nc, &ns);
    ws.send(Message::Text(json!({"t":"pair-proof","mac":b64(&crypto::pair_mac(&secret, b"c", &t, &z))}).to_string().into())).await.unwrap();
    assert_eq!(text(&mut ws).await["t"], "paired");
    let mut chan = Channel::new(&crypto::device_key(&z, &secret, &t), &nc, &ns, false);
    let mut send = |v: Value| Message::Binary(chan.seal(v.to_string().as_bytes()).into());
    let screen_on = send(json!({"t":"screen","on":true,"monitor":1,"max":640,"q":60}));
    let _ = send;
    ws.send(screen_on).await.unwrap();

    // сначала — список мониторов, затем кадры второго монитора 1280×1024, уменьшенные до 640
    let info = json_of(&until(&mut ws, &mut chan, |p| json_of(p)["t"] == "screen-info").await);
    assert_eq!(info["monitors"].as_array().unwrap().len(), 2);
    assert_eq!(info["monitor"], 1);
    let f = until(&mut ws, &mut chan, |p| p.first() == Some(&0x0C)).await;
    assert_eq!(f[1], 1, "монитор");
    let (w, h) = (u16::from_le_bytes([f[2], f[3]]), u16::from_le_bytes([f[4], f[5]]));
    assert_eq!((w, h), (640, 512));
    assert_eq!(&f[6..8], &[0xFF, 0xD8], "JPEG");

    // без подтверждений ПК шлёт не больше двух кадров
    tokio::time::sleep(Duration::from_millis(400)).await;
    let mut extra = 0;
    while let Ok(Some(Ok(Message::Binary(b)))) = tokio::time::timeout(Duration::from_millis(100), ws.next()).await {
        if chan.open(&b).is_some_and(|p| p.first() == Some(&0x0C)) {
            extra += 1;
        }
    }
    assert!(extra <= 1, "кадров без подтверждения: {}", extra + 1);
    // подтверждение — и поток идёт дальше
    ws.send(Message::Binary(chan.seal(br#"{"t":"screen-ack"}"#).into())).await.unwrap();
    ws.send(Message::Binary(chan.seal(br#"{"t":"screen-ack"}"#).into())).await.unwrap();
    until(&mut ws, &mut chan, |p| p.first() == Some(&0x0C)).await;

    // касание в центре второго монитора: курсор туда, затем клик
    let mut tap = vec![0x0D];
    tap.extend_from_slice(&32768u16.to_le_bytes());
    tap.extend_from_slice(&32768u16.to_le_bytes());
    tap.push(3);
    ws.send(Message::Binary(chan.seal(&tap).into())).await.unwrap();
    ws.send(Message::Binary(chan.seal(&[8, 9, 0, 0, 0]).into())).await.unwrap();
    until(&mut ws, &mut chan, |p| p == [8, 9, 0, 0, 0]).await;
    let log = mock.debug_log().unwrap().to_string();
    assert!(log.contains(r#""to":[2559,511]"#), "{log}");
    assert!(log.contains(r#""action":"Click","button":"Left""#));

    // выключение — кадры прекращаются
    ws.send(Message::Binary(chan.seal(br#"{"t":"screen","on":false}"#).into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    while tokio::time::timeout(Duration::from_millis(50), ws.next()).await.is_ok() {}
    ws.send(Message::Binary(chan.seal(br#"{"t":"screen-ack"}"#).into())).await.unwrap();
    let quiet = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            if let Some(Ok(Message::Binary(b))) = ws.next().await {
                if chan.open(&b).is_some_and(|p| p.first() == Some(&0x0C)) {
                    return;
                }
            }
        }
    })
    .await;
    assert!(quiet.is_err(), "после выключения кадров нет");
}
