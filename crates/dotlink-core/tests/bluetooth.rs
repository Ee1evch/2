//! Без Wi-Fi и интернета: телефон по Bluetooth (имитация RFCOMM — поток байтов) сопрягается,
//! управляет ПК и передаёт файл внутри сессии в обе стороны.

use dotlink_core::crypto::{self, Channel, PairKeys};
use dotlink_core::platform::mock::MockPlatform;
use dotlink_core::platform::Platform;
use dotlink_core::proto::file_frame;
use dotlink_core::transport::{encode_frame, Msg};
use dotlink_core::util::{b64, unb64, unb64_arr};
use dotlink_core::{start, NoHost, Options};
use serde_json::{json, Value};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

/// Телефон по «Bluetooth»: кадры как в transport::from_stream.
struct BtPhone {
    tx: Sender<Vec<u8>>,
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
}

impl BtPhone {
    fn send(&self, m: Msg) {
        self.tx.send(encode_frame(&m)).unwrap();
    }
    fn recv(&mut self) -> Msg {
        loop {
            if self.buf.len() >= 5 {
                let len = u32::from_be_bytes(self.buf[1..5].try_into().unwrap()) as usize;
                if self.buf.len() >= 5 + len {
                    let body = self.buf[5..5 + len].to_vec();
                    let kind = self.buf[0];
                    self.buf.drain(..5 + len);
                    return if kind == 0 { Msg::Text(String::from_utf8(body).unwrap()) } else { Msg::Bin(body) };
                }
            }
            let more = self.rx.recv_timeout(Duration::from_secs(5)).expect("ПК молчит");
            self.buf.extend_from_slice(&more);
        }
    }
    fn text(&mut self) -> Value {
        match self.recv() {
            Msg::Text(t) => serde_json::from_str(&t).unwrap(),
            m => panic!("ожидался текст: {m:?}"),
        }
    }
    /// Следующее расшифрованное сообщение, подходящее под условие (JSON или двоичный кадр).
    fn until(&mut self, ch: &mut Channel, pred: impl Fn(&[u8]) -> bool) -> Vec<u8> {
        for _ in 0..500 {
            if let Msg::Bin(b) = self.recv() {
                let p = ch.open(&b).expect("расшифровка");
                if pred(&p) {
                    return p;
                }
            }
        }
        panic!("не дождались");
    }
}

fn json_of(p: &[u8]) -> Value {
    if p.first() == Some(&b'{') {
        serde_json::from_slice(p).unwrap_or_default()
    } else {
        Value::Null
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_over_bluetooth_pairs_controls_and_moves_files() {
    let mock = Arc::new(MockPlatform::new());
    let run =
        start(Options { data_dir: None, port: Some(0), bind: "127.0.0.1".parse().unwrap(), platform: mock.clone(), host: Arc::new(NoHost), discovery: false })
            .await
            .unwrap();
    for _ in 0..100 {
        if run.core.hub.get("bt").is_some_and(|v| v["state"] == "online") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // адрес адаптера — в QR и в маршрутах
    let qr = run.core.hub.get("pairing").unwrap()["url"].as_str().unwrap().to_string();
    assert!(qr.contains("&bt=00:1A:7D:DA:71:13"), "{qr}");
    assert_eq!(run.core.hub.get("routes").unwrap()["bt"], "00:1A:7D:DA:71:13");
    let secret = unb64(qr.split("pair=").nth(1).unwrap().split('&').next().unwrap()).unwrap();

    let (tx, rx) = mock.bt_connect().expect("служба Bluetooth запущена");
    let core = run.core.clone();
    let mock2 = mock.clone();
    tokio::task::spawn_blocking(move || {
        let mut ph = BtPhone { tx, rx, buf: vec![] };
        let keys = PairKeys::generate();
        let nc = crypto::random::<16>();
        ph.send(Msg::Text(json!({"t":"hello","v":1,"role":"remote","pair":"qr","pub":b64(&keys.public),"nonce":b64(&nc),"name":"Pixel без сети"}).to_string()));
        let ch = ph.text();
        assert_eq!(ch["t"], "pair-challenge", "{ch}");
        let pub_s = unb64_arr::<32>(ch["pub"].as_str().unwrap()).unwrap();
        let ns = unb64_arr::<16>(ch["nonce"].as_str().unwrap()).unwrap();
        let z = keys.shared(&pub_s);
        let t = crypto::pair_transcript(&keys.public, &pub_s, &nc, &ns);
        ph.send(Msg::Text(json!({"t":"pair-proof","mac":b64(&crypto::pair_mac(&secret, b"c", &t, &z))}).to_string()));
        assert_eq!(ph.text()["t"], "paired");
        let dk = crypto::device_key(&z, &secret, &t);
        let mut chan = Channel::new(&dk, &nc, &ns, false);
        assert_eq!(json_of(&ph.until(&mut chan, |p| json_of(p)["t"] == "snapshot"))["t"], "snapshot");

        // ввод
        ph.send(Msg::Bin(chan.seal(&[3, 0, 2])));
        ph.send(Msg::Bin(chan.seal(&[8, 5, 0, 0, 0])));
        ph.until(&mut chan, |p| p == [8, 5, 0, 0, 0]);
        assert!(mock2.debug_log().unwrap().to_string().contains(r#""button":"Left""#));

        // файл телефон → ПК внутри сессии (HTTP до ПК по Bluetooth нет)
        let body: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
        ph.send(Msg::Bin(chan.seal(json!({"t":"upload","name":"фото.bin","size":100000}).to_string().as_bytes())));
        let ticket = json_of(&ph.until(&mut chan, |p| json_of(p)["t"] == "ticket"));
        let id = ticket["url"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
        for c in body.chunks(32 * 1024) {
            ph.send(Msg::Bin(chan.seal(&file_frame(0, &id, c))));
        }
        ph.send(Msg::Bin(chan.seal(&file_frame(1, &id, &[]))));
        let ok = json_of(&ph.until(&mut chan, |p| json_of(p)["for"] == "upload"));
        assert_eq!(ok["t"], "ok", "{ok}");
        let saved = std::fs::read(mock2.downloads_dir().join(ok["name"].as_str().unwrap())).unwrap();
        assert_eq!(saved, body);

        // файл ПК → телефон: предложение, затем «дай внутри сессии»
        let src = std::env::temp_dir().join("dotlink-bt-test.bin");
        std::fs::write(&src, &body[..70_000]).unwrap();
        let dev = core.store.read().devices[0].id.clone();
        assert!(core.offer_file(&dev, src, "отчёт.bin".into(), 70_000));
        let offer = json_of(&ph.until(&mut chan, |p| json_of(p)["t"] == "file-offer"));
        let t = offer["url"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
        ph.send(Msg::Bin(chan.seal(json!({"t":"file-get","ticket":t}).to_string().as_bytes())));
        let mut got = Vec::new();
        loop {
            let p = ph.until(&mut chan, |p| p.first() == Some(&0x0B));
            let n = p[2] as usize;
            assert_eq!(&p[3..3 + n], t.as_bytes());
            match p[1] {
                0 => got.extend_from_slice(&p[3 + n..]),
                1 => break,
                k => panic!("файл прерван: {k}"),
            }
        }
        assert_eq!(got, &body[..70_000]);
    })
    .await
    .unwrap();

    let d = run.core.hub.get("devices").unwrap();
    assert_eq!(d[0]["via"], "bt");
}
