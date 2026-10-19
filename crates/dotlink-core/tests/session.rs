//! Полный цикл по настоящему WebSocket: сопряжение по QR → зашифрованный ввод → переподключение по ключу.

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
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
            Message::Binary(b) => {
                let p = ch.open(&b).expect("кадр должен расшифровываться");
                if p.first() == Some(&b'{') {
                    return serde_json::from_slice(&p).unwrap();
                }
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            m => panic!("ожидался бинарный кадр, пришло {m:?}"),
        }
    }
}

async fn send_json(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

async fn until(ws: &mut Ws, ch: &mut Channel, pred: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..200 {
        let v = secure(ws, ch).await;
        if pred(&v) {
            return v;
        }
    }
    panic!("не дождались сообщения");
}

#[tokio::test]
async fn pair_control_reconnect_and_revoke() {
    let mock = Arc::new(MockPlatform::new());
    let mut run =
        start(Options { data_dir: None, port: Some(0), bind: "127.0.0.1".parse().unwrap(), platform: mock.clone(), host: Arc::new(NoHost), discovery: false })
            .await
            .unwrap();
    let url = format!("ws://{}/ws", run.addr);
    let pairing = run.core.hub.get("pairing").unwrap();
    let qr = pairing["url"].as_str().unwrap().to_string();
    let hash = qr.split('#').nth(1).unwrap();
    let param = |k: &str| hash.split('&').find_map(|kv| kv.strip_prefix(k).and_then(|v| v.strip_prefix('='))).map(str::to_string);
    assert_eq!(param("v").as_deref(), Some("2"));
    assert!(param("pc").is_some() && param("h").is_some());
    let secret = unb64(&param("pair").unwrap()).unwrap();

    // ── сопряжение по QR ──
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let keys = PairKeys::generate();
    let nc = crypto::random::<16>();
    send_json(&mut ws, json!({"t":"hello","v":1,"role":"remote","pair":"qr","pub":b64(&keys.public),"nonce":b64(&nc),"name":"Pixel 8"})).await;
    let ch = text(&mut ws).await;
    assert_eq!(ch["t"], "pair-challenge");
    let pub_s = unb64_arr::<32>(ch["pub"].as_str().unwrap()).unwrap();
    let ns = unb64_arr::<16>(ch["nonce"].as_str().unwrap()).unwrap();
    let z = keys.shared(&pub_s);
    let t = crypto::pair_transcript(&keys.public, &pub_s, &nc, &ns);
    send_json(&mut ws, json!({"t":"pair-proof","mac":b64(&crypto::pair_mac(&secret, b"c", &t, &z))})).await;
    let paired = text(&mut ws).await;
    assert_eq!(paired["t"], "paired", "{paired}");
    assert_eq!(unb64(paired["mac"].as_str().unwrap()).unwrap(), crypto::pair_mac(&secret, b"s", &t, &z), "ПК доказал знание секрета");
    let device = paired["device"].as_str().unwrap().to_string();
    let dk = crypto::device_key(&z, &secret, &t);
    let mut chan = Channel::new(&dk, &nc, &ns, false);

    let snap = secure(&mut ws, &mut chan).await;
    assert_eq!(snap["t"], "snapshot");
    assert!(snap["v"]["vol"].is_object() && snap["v"]["pc"].is_object());
    assert!(snap["v"].get("devices").is_none(), "телефон не видит служебные ключи");
    assert!(snap["v"].get("pairing").is_none());

    // ── ввод: четверти пикселя копятся, клик, текст, сочетание ──
    for f in [vec![1u8, 2, 0, 0xFE, 0xFF], vec![1, 2, 0, 0xFE, 0xFF], vec![3, 0, 2], vec![6, 2, 0x11, 0, 0x43, 0]] {
        ws.send(Message::Binary(chan.seal(&f).into())).await.unwrap();
    }
    let mut t = vec![5u8];
    t.extend_from_slice("Привет".as_bytes());
    ws.send(Message::Binary(chan.seal(&t).into())).await.unwrap();
    // пинг возвращается тем же кадром
    ws.send(Message::Binary(chan.seal(&[8, 7, 0, 0, 0]).into())).await.unwrap();
    loop {
        if let Message::Binary(b) = ws.next().await.unwrap().unwrap() {
            if chan.open(&b).unwrap() == [8, 7, 0, 0, 0] {
                break;
            }
        }
    }
    let log = mock.debug_log().unwrap().to_string();
    assert!(log.contains(r#""move":[1,-1]"#), "{log}");
    assert!(log.contains(r#""action":"Click","button":"Left""#), "{log}");
    assert!(log.contains(r#""chord":[17,67]"#));
    assert!(log.contains("Привет"));

    // ── громкость с телефона возвращается состоянием с номером ──
    ws.send(Message::Binary(chan.seal(&[7, 0x88, 0x13, 9, 0]).into())).await.unwrap();
    let v = until(&mut ws, &mut chan, |v| v["t"] == "state" && v["k"] == "vol" && v["v"]["level"] == 0.5).await;
    assert_eq!(v["v"]["seq"], 9);

    // ── команды JSON внутри шифрованного канала ──
    ws.send(Message::Binary(chan.seal(br#"{"t":"media","a":"next"}"#).into())).await.unwrap();
    until(&mut ws, &mut chan, |v| v["k"] == "media" && v["v"]["title"] == "Intro").await;
    ws.send(Message::Binary(chan.seal(r#"{"t":"clip-set","text":"с телефона"}"#.as_bytes()).into())).await.unwrap();
    until(&mut ws, &mut chan, |v| v["t"] == "ok" && v["for"] == "clip-set").await;
    let c = until(&mut ws, &mut chan, |v| v["k"] == "clip").await;
    assert_eq!(c["v"]["from"], "phone");
    ws.send(Message::Binary(chan.seal(br#"{"t":"timer","a":"shutdown","sec":600}"#).into())).await.unwrap();
    let tm = until(&mut ws, &mut chan, |v| v["k"] == "timer").await;
    assert_eq!(tm["v"]["action"], "shutdown");

    // повтор старого кадра не исполняется
    let replay = chan.seal(&[3, 1, 2]);
    ws.send(Message::Binary(replay.clone().into())).await.unwrap();
    ws.send(Message::Binary(replay.into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(mock.debug_log().unwrap().to_string().matches(r#""button":"Right""#).count(), 1);
    ws.close(None).await.unwrap();

    // ── QR одноразовый ──
    let (mut ws2, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let k2 = PairKeys::generate();
    send_json(&mut ws2, json!({"t":"hello","role":"remote","pair":"qr","pub":b64(&k2.public),"nonce":b64(&nc)})).await;
    let c2 = text(&mut ws2).await;
    let pub2 = unb64_arr::<32>(c2["pub"].as_str().unwrap()).unwrap();
    let ns2 = unb64_arr::<16>(c2["nonce"].as_str().unwrap()).unwrap();
    let z2 = k2.shared(&pub2);
    let t2 = crypto::pair_transcript(&k2.public, &pub2, &nc, &ns2);
    send_json(&mut ws2, json!({"t":"pair-proof","mac":b64(&crypto::pair_mac(&secret, b"c", &t2, &z2))})).await;
    assert_eq!(text(&mut ws2).await["code"], "bad-secret");

    // ── переподключение по ключу устройства ──
    let (mut ws3, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let nc3 = crypto::random::<16>();
    send_json(&mut ws3, json!({"t":"hello","role":"remote","device":device,"nonce":b64(&nc3)})).await;
    let c3 = text(&mut ws3).await;
    assert_eq!(c3["t"], "challenge");
    let ns3 = unb64_arr::<16>(c3["nonce"].as_str().unwrap()).unwrap();
    send_json(&mut ws3, json!({"t":"auth","mac":b64(&crypto::auth_mac(&dk, b"c", &nc3, &ns3))})).await;
    let w = text(&mut ws3).await;
    assert_eq!(w["t"], "welcome");
    assert_eq!(unb64(w["mac"].as_str().unwrap()).unwrap(), crypto::auth_mac(&dk, b"s", &nc3, &ns3));
    let mut chan3 = Channel::new(&dk, &nc3, &ns3, false);
    assert_eq!(secure(&mut ws3, &mut chan3).await["t"], "snapshot");

    // ── дашборд: только с 127.0.0.1 и с токеном; отзыв устройства закрывает его сессию ──
    let (mut adm, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send_json(&mut adm, json!({"t":"hello","role":"admin","token":"wrong"})).await;
    assert_eq!(text(&mut adm).await["code"], "forbidden");
    let (mut adm, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send_json(&mut adm, json!({"t":"hello","role":"admin","token":run.core.admin_token})).await;
    assert_eq!(text(&mut adm).await["admin"], true);
    let snap = text(&mut adm).await;
    assert_eq!(snap["v"]["devices"][0]["name"], "Pixel 8");
    send_json(&mut adm, json!({"t":"device-perms","id":device,"perms":{"input":false,"media":true,"power":true,"macros":true,"clipboard":true,"files":true}}))
        .await;
    until(&mut ws3, &mut chan3, |v| v["t"] == "perms").await;
    ws3.send(Message::Binary(chan3.seal(&[1, 40, 0, 0, 0]).into())).await.unwrap();
    assert_eq!(until(&mut ws3, &mut chan3, |v| v["t"] == "denied").await["what"], "input");
    send_json(&mut adm, json!({"t":"device-remove","id":device})).await;
    assert_eq!(until(&mut ws3, &mut chan3, |v| v["t"] == "error").await["code"], "revoked");

    let (mut ws4, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send_json(&mut ws4, json!({"t":"hello","role":"remote","device":device,"nonce":b64(&nc3)})).await;
    assert_eq!(text(&mut ws4).await["code"], "unknown-device");
    run.stop();
}

#[tokio::test]
async fn wrong_pin_is_limited() {
    let mut run = start(Options {
        data_dir: None,
        port: Some(0),
        bind: "127.0.0.1".parse().unwrap(),
        platform: Arc::new(MockPlatform::new()),
        host: Arc::new(NoHost),
        discovery: false,
    })
    .await
    .unwrap();
    let url = format!("ws://{}/ws", run.addr);
    let pin = run.core.hub.get("pairing").unwrap()["pin"].as_str().unwrap().to_string();
    let wrong = if pin == "000000" { "111111" } else { "000000" };
    for i in 0..6 {
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let k = PairKeys::generate();
        let nc = crypto::random::<16>();
        send_json(&mut ws, json!({"t":"hello","role":"remote","pair":"pin","pub":b64(&k.public),"nonce":b64(&nc)})).await;
        let c = text(&mut ws).await;
        if c["t"] == "error" {
            // после пяти ошибок старого PIN больше нет — нужен новый с экрана ПК
            assert!(i >= 5);
            break;
        }
        let pub_s = unb64_arr::<32>(c["pub"].as_str().unwrap()).unwrap();
        let ns = unb64_arr::<16>(c["nonce"].as_str().unwrap()).unwrap();
        let t = crypto::pair_transcript(&k.public, &pub_s, &nc, &ns);
        send_json(&mut ws, json!({"t":"pair-proof","mac":b64(&crypto::pair_mac(wrong.as_bytes(), b"c", &t, &k.shared(&pub_s)))})).await;
        assert_eq!(text(&mut ws).await["code"], "bad-pin");
    }
    assert_ne!(run.core.hub.get("pairing").unwrap()["pin"].as_str().unwrap(), pin, "PIN сменился");
    run.stop();
}
