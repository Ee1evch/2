//! Связь из разных сетей: настоящий ретранслятор (dotlink-relay) между телефоном и ядром.
//! Телефон сопрягается по QR через ретранслятор и управляет ПК; PIN через ретранслятор не принимается.

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
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
            Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            Message::Ping(_) | Message::Pong(_) => continue,
            m => panic!("ожидался текст, пришло {m:?}"),
        }
    }
}

async fn secure(ws: &mut Ws, ch: &mut Channel) -> Value {
    loop {
        if let Message::Binary(b) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
            let p = ch.open(&b).expect("кадр должен расшифровываться");
            if p.first() == Some(&b'{') {
                return serde_json::from_slice(&p).unwrap();
            }
        }
    }
}

async fn wait(mut f: impl FnMut() -> bool) {
    for _ in 0..100 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("не дождались");
}

#[tokio::test]
async fn phone_reaches_pc_through_relay() {
    let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_addr = relay.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(relay, dotlink_relay::router(dotlink_relay::Limits::default())).await });

    let mock = Arc::new(MockPlatform::new());
    let run =
        start(Options { data_dir: None, port: Some(0), bind: "127.0.0.1".parse().unwrap(), platform: mock.clone(), host: Arc::new(NoHost), discovery: false })
            .await
            .unwrap();
    let mut settings = run.core.store.read().settings.clone();
    settings.relay_url = format!("ws://{relay_addr}");
    let r = run.core.admin_cmd(&json!({ "t": "settings-save", "settings": settings }));
    assert_eq!(r["t"], "ok", "{r}");
    wait(|| run.core.hub.get("relay").is_some_and(|v| v["state"] == "online")).await;

    // в QR — адрес ретранслятора и комната
    let qr = run.core.hub.get("pairing").unwrap()["url"].as_str().unwrap().to_string();
    let hash = qr.split('#').nth(1).unwrap();
    let param = |k: &str| {
        hash.split('&')
            .find_map(|kv| kv.strip_prefix(k).and_then(|v| v.strip_prefix('=')))
            .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
    };
    let room = param("rm").expect("комната в QR");
    assert_eq!(room, run.core.store.read().room());
    assert_eq!(param("r").unwrap(), format!("ws://{relay_addr}"));
    let secret = unb64(&param("pair").unwrap()).unwrap();
    let phone_url = format!("ws://{relay_addr}/v1/phone/{room}");

    // чужая комната — ретранслятор отвечает 404 ещё до WebSocket
    assert!(tokio_tungstenite::connect_async(format!("ws://{relay_addr}/v1/phone/nope")).await.is_err());
    // ПК без секрета комнату не откроет
    assert!(tokio_tungstenite::connect_async(format!("ws://{relay_addr}/v1/pc/{room}?secret=x")).await.is_err());

    // PIN через ретранслятор отвергается
    let (mut ws, _) = tokio_tungstenite::connect_async(&phone_url).await.unwrap();
    let k = PairKeys::generate();
    ws.send(Message::Text(json!({"t":"hello","v":1,"role":"remote","pair":"pin","pub":b64(&k.public),"nonce":b64(&[0u8; 16]),"name":"x"}).to_string().into()))
        .await
        .unwrap();
    assert_eq!(text(&mut ws).await["code"], "pin-local-only");
    drop(ws);

    // сопряжение по QR через ретранслятор
    let (mut ws, _) = tokio_tungstenite::connect_async(&phone_url).await.unwrap();
    let keys = PairKeys::generate();
    let nc = crypto::random::<16>();
    ws.send(Message::Text(
        json!({"t":"hello","v":1,"role":"remote","pair":"qr","pub":b64(&keys.public),"nonce":b64(&nc),"name":"Pixel в LTE"}).to_string().into(),
    ))
    .await
    .unwrap();
    let ch = text(&mut ws).await;
    assert_eq!(ch["t"], "pair-challenge", "{ch}");
    let pub_s = unb64_arr::<32>(ch["pub"].as_str().unwrap()).unwrap();
    let ns = unb64_arr::<16>(ch["nonce"].as_str().unwrap()).unwrap();
    let z = keys.shared(&pub_s);
    let t = crypto::pair_transcript(&keys.public, &pub_s, &nc, &ns);
    ws.send(Message::Text(json!({"t":"pair-proof","mac":b64(&crypto::pair_mac(&secret, b"c", &t, &z))}).to_string().into())).await.unwrap();
    let paired = text(&mut ws).await;
    assert_eq!(paired["t"], "paired", "{paired}");
    let dk = crypto::device_key(&z, &secret, &t);
    let mut chan = Channel::new(&dk, &nc, &ns, false);
    let snap = secure(&mut ws, &mut chan).await;
    assert_eq!(snap["t"], "snapshot");
    // маршруты для будущих подключений: ретранслятор и STUN
    assert_eq!(snap["v"]["routes"]["relay"]["room"], room);
    assert!(snap["v"]["routes"]["ice"].as_array().is_some_and(|a| !a.is_empty()));

    // управление через ретранслятор
    ws.send(Message::Binary(chan.seal(&[3, 0, 2]).into())).await.unwrap();
    ws.send(Message::Binary(chan.seal(&[8, 1, 0, 0, 0]).into())).await.unwrap();
    loop {
        if let Message::Binary(b) = ws.next().await.unwrap().unwrap() {
            if chan.open(&b).unwrap() == [8, 1, 0, 0, 0] {
                break;
            }
        }
    }
    assert!(mock.debug_log().unwrap().to_string().contains(r#""action":"Click","button":"Left""#));

    // в дашборде устройство видно как подключённое через интернет
    wait(|| run.core.hub.get("devices").is_some_and(|d| d[0]["via"] == "relay")).await;
}
