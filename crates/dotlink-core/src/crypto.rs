//! Криптография DotLink.
//!
//! Сопряжение: X25519 между телефоном и ПК + доказательство знания секрета из QR (128 бит) или PIN.
//! Подключение: вызов-ответ HMAC на ключе устройства, ключ по сети не передаётся.
//! Сессия: XChaCha20-Poly1305, свой ключ и префикс nonce на каждое направление, счётчик против повторов.
//! Те же функции повторены в web/src/lib/crypto.ts — совместимость держат общие тестовые векторы.

use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

type HmacSha256 = Hmac<Sha256>;

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

pub fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC принимает любой ключ");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// Сравнение без утечки по времени.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn hkdf<const N: usize>(salt: &[u8], ikm: &[u8], info: &[u8]) -> [u8; N] {
    let mut out = [0u8; N];
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, &mut out).expect("длина HKDF в пределах");
    out
}

// ───────── сопряжение ─────────

pub struct PairKeys {
    secret: StaticSecret,
    pub public: [u8; 32],
}

impl PairKeys {
    pub fn generate() -> Self {
        Self::from_secret(random())
    }
    pub fn from_secret(bytes: [u8; 32]) -> Self {
        let secret = StaticSecret::from(bytes);
        let public = PublicKey::from(&secret).to_bytes();
        Self { secret, public }
    }
    pub fn shared(&self, peer: &[u8; 32]) -> [u8; 32] {
        self.secret.diffie_hellman(&PublicKey::from(*peer)).to_bytes()
    }
}

pub fn pair_transcript(pub_c: &[u8; 32], pub_s: &[u8; 32], nonce_c: &[u8; 16], nonce_s: &[u8; 16]) -> Vec<u8> {
    [b"dotlink/pair/v1".as_slice(), pub_c, pub_s, nonce_c, nonce_s].concat()
}

/// Доказательство знания секрета (QR или PIN), привязанное к обмену X25519.
pub fn pair_mac(secret: &[u8], who: &[u8], transcript: &[u8], shared: &[u8; 32]) -> [u8; 32] {
    let key: [u8; 32] = Sha256::new().chain_update(b"dotlink/pair-key/v1").chain_update(secret).finalize().into();
    hmac(&key, &[who, transcript, shared])
}

/// Долгоживущий ключ устройства после сопряжения.
pub fn device_key(shared: &[u8; 32], secret: &[u8], transcript: &[u8]) -> [u8; 32] {
    hkdf(transcript, &[shared.as_slice(), secret].concat(), b"dotlink/device/v1")
}

// ───────── вход известного устройства ─────────

pub fn auth_mac(device_key: &[u8; 32], who: &[u8], nonce_c: &[u8; 16], nonce_s: &[u8; 16]) -> [u8; 32] {
    hmac(device_key, &[b"dotlink/auth/v1", who, nonce_c, nonce_s])
}

// ───────── защищённый канал ─────────

pub struct Channel {
    tx: XChaCha20Poly1305,
    rx: XChaCha20Poly1305,
    tx_prefix: [u8; 16],
    rx_prefix: [u8; 16],
    tx_ctr: u64,
    rx_ctr: u64,
    /// Окно последних 64 счётчиков — для каналов без гарантии порядка (движения по WebRTC).
    window: Option<u64>,
}

/// Метки ключей: основной канал и два канала WebRTC (надёжный и «как UDP»).
pub const LABEL_MAIN: &[u8] = b"dotlink/session/v1";
pub const LABEL_RTC_CTL: &[u8] = b"dotlink/session/v1/rtc-ctl";
pub const LABEL_RTC_FAST: &[u8] = b"dotlink/session/v1/rtc-fast";

impl Channel {
    /// `server = true` на стороне ПК: он шифрует направлением s→c и читает c→s.
    pub fn new(device_key: &[u8; 32], nonce_c: &[u8; 16], nonce_s: &[u8; 16], server: bool) -> Self {
        Self::labeled(device_key, nonce_c, nonce_s, server, LABEL_MAIN, false)
    }

    /// Отдельные ключи на каждый канал; `lossy` — кадры могут теряться и приходить не по порядку.
    pub fn labeled(device_key: &[u8; 32], nonce_c: &[u8; 16], nonce_s: &[u8; 16], server: bool, label: &[u8], lossy: bool) -> Self {
        let k: [u8; 96] = hkdf(&[nonce_c.as_slice(), nonce_s].concat(), device_key, label);
        let (c2s, s2c) = (&k[0..32], &k[32..64]);
        let (pc2s, ps2c): ([u8; 16], [u8; 16]) = (k[64..80].try_into().unwrap(), k[80..96].try_into().unwrap());
        let (tk, rk, tp, rp) = if server { (s2c, c2s, ps2c, pc2s) } else { (c2s, s2c, pc2s, ps2c) };
        Self {
            tx: XChaCha20Poly1305::new_from_slice(tk).unwrap(),
            rx: XChaCha20Poly1305::new_from_slice(rk).unwrap(),
            tx_prefix: tp,
            rx_prefix: rp,
            tx_ctr: 0,
            rx_ctr: 0,
            window: lossy.then_some(0),
        }
    }

    fn nonce(prefix: &[u8; 16], ctr: u64) -> XNonce {
        let mut n = [0u8; 24];
        n[..16].copy_from_slice(prefix);
        n[16..].copy_from_slice(&ctr.to_le_bytes());
        n.into()
    }

    /// Кадр: 8 байт счётчика (LE) + шифртекст с тегом.
    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        self.tx_ctr += 1;
        let ct = self.tx.encrypt(&Self::nonce(&self.tx_prefix, self.tx_ctr), plain).expect("шифрование не падает");
        let mut out = Vec::with_capacity(8 + ct.len());
        out.extend_from_slice(&self.tx_ctr.to_le_bytes());
        out.extend_from_slice(&ct);
        out
    }

    /// Расшифровать; повтор и слишком старые кадры отвергаются.
    pub fn open(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if frame.len() < 8 + 16 {
            return None;
        }
        let ctr = u64::from_le_bytes(frame[..8].try_into().unwrap());
        match self.window {
            None if ctr <= self.rx_ctr => return None,
            Some(w) if ctr <= self.rx_ctr && (self.rx_ctr - ctr >= 64 || w & (1 << (self.rx_ctr - ctr)) != 0) => return None,
            _ => {}
        }
        let pt = self.rx.decrypt(&Self::nonce(&self.rx_prefix, ctr), &frame[8..]).ok()?;
        if let Some(w) = self.window.as_mut() {
            if ctr > self.rx_ctr {
                let shift = ctr - self.rx_ctr;
                *w = if shift >= 64 { 0 } else { *w << shift };
                *w |= 1;
            } else {
                *w |= 1 << (self.rx_ctr - ctr);
            }
        }
        self.rx_ctr = self.rx_ctr.max(ctr);
        Some(pt)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    /// Общие векторы с web/test/crypto.test.ts.
    #[test]
    fn vectors() {
        let c = PairKeys::from_secret([1; 32]);
        let s = PairKeys::from_secret([2; 32]);
        let (nc, ns) = ([3u8; 16], [4u8; 16]);
        let z = c.shared(&s.public);
        assert_eq!(z, s.shared(&c.public));
        let t = pair_transcript(&c.public, &s.public, &nc, &ns);
        let mac = pair_mac(b"123456", b"c", &t, &z);
        let dk = device_key(&z, b"123456", &t);
        let auth = auth_mac(&dk, b"c", &nc, &ns);
        let mut ch = Channel::new(&dk, &nc, &ns, false);
        let frame = ch.seal(&[1, 2, 0, 3, 0]);
        assert_eq!(hex(&c.public), "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209");
        assert_eq!(hex(&z), VEC_Z);
        assert_eq!(hex(&mac), VEC_MAC);
        assert_eq!(hex(&dk), VEC_DK);
        assert_eq!(hex(&auth), VEC_AUTH);
        assert_eq!(hex(&frame), VEC_FRAME);
    }

    const VEC_Z: &str = "2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953";
    const VEC_MAC: &str = "e3494d46008963da74b41d9f576c2d3aab2b17c698015fdfa9196cd209718471";
    const VEC_DK: &str = "14bf51f0058e34ced8e9811ee1194801fc34c9d79111a6dbb6139d0621ded049";
    const VEC_AUTH: &str = "b0244b6bac8fcd2e61ed69003987799e2f7f37a6a084fa52ee4502295cc95e21";
    const VEC_FRAME: &str = "0100000000000000e318bcf24df085aa8e046f583b812bd470eda7ab5d";

    #[test]
    fn channel_roundtrip_and_replay() {
        let dk = random::<32>();
        let (nc, ns) = (random::<16>(), random::<16>());
        let mut c = Channel::new(&dk, &nc, &ns, false);
        let mut s = Channel::new(&dk, &nc, &ns, true);
        let f1 = c.seal(b"move");
        let f2 = c.seal(b"click");
        assert_eq!(s.open(&f1).unwrap(), b"move");
        assert_eq!(s.open(&f2).unwrap(), b"click");
        assert!(s.open(&f1).is_none(), "повтор отвергается");
        let back = s.seal(b"state");
        assert_eq!(c.open(&back).unwrap(), b"state");
        let mut bad = c.seal(b"x");
        let n = bad.len();
        bad[n - 1] ^= 1;
        assert!(s.open(&bad).is_none(), "подделка отвергается");
    }

    #[test]
    fn lossy_channel_accepts_reordering_but_not_replays() {
        let dk = random::<32>();
        let (nc, ns) = (random::<16>(), random::<16>());
        let mut c = Channel::labeled(&dk, &nc, &ns, false, LABEL_RTC_FAST, true);
        let mut s = Channel::labeled(&dk, &nc, &ns, true, LABEL_RTC_FAST, true);
        let f: Vec<_> = (0..5).map(|i| c.seal(&[i])).collect();
        assert_eq!(s.open(&f[2]).unwrap(), [2]);
        assert_eq!(s.open(&f[0]).unwrap(), [0], "пришёл позже — принят");
        assert!(s.open(&f[2]).is_none(), "повтор отвергнут");
        assert_eq!(s.open(&f[4]).unwrap(), [4]);
        assert_eq!(s.open(&f[3]).unwrap(), [3]);
        assert!(s.open(&f[0]).is_none());
        for i in 0..70 {
            c.seal(&[i]);
        }
        let late = c.seal(&[1]);
        let newest = c.seal(&[2]);
        assert!(s.open(&newest).is_some());
        assert!(s.open(&late).is_some(), "в пределах окна");
        // ключи разных каналов не подходят друг к другу
        let mut main = Channel::new(&dk, &nc, &ns, true);
        assert!(main.open(&c.seal(&[9])).is_none());
    }

    #[test]
    fn wrong_pin_gives_wrong_proof() {
        let c = PairKeys::generate();
        let s = PairKeys::generate();
        let t = pair_transcript(&c.public, &s.public, &[0; 16], &[1; 16]);
        let z = c.shared(&s.public);
        assert!(!ct_eq(&pair_mac(b"111111", b"c", &t, &z), &pair_mac(b"111112", b"c", &t, &z)));
    }
}
