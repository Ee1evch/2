//! Фонтанный код для QR-потока: файл превращается в бесконечную последовательность пакетов,
//! из которых для сборки хватает любых K + 2 (K — число исходных символов). Порядок и пропуски не важны.
//!
//! Снаружи (из JS) модуль виден через простой C-ABI без wasm-bindgen: память выделяется `fx_alloc`,
//! кодер и декодер живут в куче, наружу отдаётся указатель.

use raptorq::{Decoder, Encoder, EncodingPacket, ObjectTransmissionInformation, SourceBlockEncoder};

/// Кодер: заранее подготовленные исходные пакеты и блоковые кодеры для ремонтных.
pub struct FountainEncoder {
    oti: [u8; 12],
    blocks: Vec<(Vec<EncodingPacket>, SourceBlockEncoder)>,
}

impl FountainEncoder {
    /// `symbol` — размер символа в байтах (полезная нагрузка одного пакета).
    pub fn new(data: &[u8], symbol: u16) -> Self {
        let enc = Encoder::with_defaults(data, symbol);
        let oti = enc.get_config().serialize();
        let blocks = enc.get_block_encoders().iter().map(|b| (b.source_packets(), b.clone())).collect();
        Self { oti, blocks }
    }

    pub fn oti(&self) -> [u8; 12] {
        self.oti
    }

    /// Сколько всего исходных символов во всех блоках (K).
    pub fn source_count(&self) -> u32 {
        self.blocks.iter().map(|(s, _)| s.len() as u32).sum()
    }

    /// Пакет с номером `index`: блоки чередуются, сначала идут исходные символы, затем ремонтные — бесконечно.
    pub fn packet(&self, index: u32) -> Vec<u8> {
        let z = self.blocks.len() as u32;
        let (src, enc) = &self.blocks[(index % z) as usize];
        let j = index / z;
        if (j as usize) < src.len() {
            src[j as usize].serialize()
        } else {
            let start = j - src.len() as u32;
            enc.repair_packets(start, 1).remove(0).serialize()
        }
    }
}

pub struct FountainDecoder {
    dec: Decoder,
    out: Option<Vec<u8>>,
}

impl FountainDecoder {
    pub fn new(oti: &[u8; 12]) -> Self {
        Self { dec: Decoder::new(ObjectTransmissionInformation::deserialize(oti)), out: None }
    }

    /// Добавить пакет; `true`, когда файл собран.
    pub fn push(&mut self, packet: &[u8]) -> bool {
        if self.out.is_some() {
            return true;
        }
        if packet.len() < 5 {
            return false;
        }
        if let Some(data) = self.dec.decode(EncodingPacket::deserialize(packet)) {
            self.out = Some(data);
        }
        self.out.is_some()
    }

    pub fn result(&self) -> Option<&[u8]> {
        self.out.as_deref()
    }
}

// ───────── C-ABI для WebAssembly ─────────

#[no_mangle]
pub extern "C" fn fx_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` и `n` должны быть получены из `fx_alloc`.
#[no_mangle]
pub unsafe extern "C" fn fx_free(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n.max(1)));
}

/// # Safety
/// `data` указывает на `len` байт.
#[no_mangle]
pub unsafe extern "C" fn enc_new(data: *const u8, len: usize, symbol: u32) -> *mut FountainEncoder {
    let bytes = std::slice::from_raw_parts(data, len);
    Box::into_raw(Box::new(FountainEncoder::new(bytes, symbol as u16)))
}

/// # Safety
/// `e` — живой кодер, `out` — 12 байт.
#[no_mangle]
pub unsafe extern "C" fn enc_oti(e: *const FountainEncoder, out: *mut u8) {
    std::ptr::copy_nonoverlapping((*e).oti.as_ptr(), out, 12);
}

/// # Safety
/// `e` — живой кодер.
#[no_mangle]
pub unsafe extern "C" fn enc_source_count(e: *const FountainEncoder) -> u32 {
    (*e).source_count()
}

/// Пишет пакет в `out` и возвращает его длину (0 — не поместился).
/// # Safety
/// `e` — живой кодер, `out` — `cap` байт.
#[no_mangle]
pub unsafe extern "C" fn enc_packet(e: *const FountainEncoder, index: u32, out: *mut u8, cap: usize) -> usize {
    let p = (*e).packet(index);
    if p.len() > cap {
        return 0;
    }
    std::ptr::copy_nonoverlapping(p.as_ptr(), out, p.len());
    p.len()
}

/// # Safety
/// `e` из `enc_new`, освобождается один раз.
#[no_mangle]
pub unsafe extern "C" fn enc_drop(e: *mut FountainEncoder) {
    drop(Box::from_raw(e));
}

/// # Safety
/// `oti` — 12 байт.
#[no_mangle]
pub unsafe extern "C" fn dec_new(oti: *const u8) -> *mut FountainDecoder {
    let mut o = [0u8; 12];
    std::ptr::copy_nonoverlapping(oti, o.as_mut_ptr(), 12);
    Box::into_raw(Box::new(FountainDecoder::new(&o)))
}

/// 1 — собран, 0 — ещё нет.
/// # Safety
/// `d` — живой декодер, `p` — `len` байт.
#[no_mangle]
pub unsafe extern "C" fn dec_push(d: *mut FountainDecoder, p: *const u8, len: usize) -> i32 {
    (*d).push(std::slice::from_raw_parts(p, len)) as i32
}

/// # Safety
/// `d` — живой декодер.
#[no_mangle]
pub unsafe extern "C" fn dec_len(d: *const FountainDecoder) -> usize {
    (*d).result().map_or(0, |r| r.len())
}

/// # Safety
/// `d` — собранный декодер, `out` — `dec_len` байт.
#[no_mangle]
pub unsafe extern "C" fn dec_copy(d: *const FountainDecoder, out: *mut u8) {
    if let Some(r) = (*d).result() {
        std::ptr::copy_nonoverlapping(r.as_ptr(), out, r.len());
    }
}

/// # Safety
/// `d` из `dec_new`, освобождается один раз.
#[no_mangle]
pub unsafe extern "C" fn dec_drop(d: *mut FountainDecoder) {
    drop(Box::from_raw(d));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 31 % 251) as u8 ^ (i >> 7) as u8).collect()
    }

    #[test]
    fn decodes_with_heavy_loss_and_any_order() {
        let file = data(200_000);
        let enc = FountainEncoder::new(&file, 480);
        let k = enc.source_count();
        let mut dec = FountainDecoder::new(&enc.oti());
        // теряем 40% пакетов, в том числе почти все исходные
        let mut used = 0;
        let mut i = 0u32;
        while !dec.push(&enc.packet(i)) {
            used += 1;
            i += 1;
            while i % 5 < 2 {
                i += 1;
            }
            assert!(used < k * 2, "не собралось за {} пакетов при K={}", used, k);
        }
        assert_eq!(dec.result().unwrap(), &file[..]);
        assert!(used <= k + 4, "накладные расходы: {} пакетов при K={}", used, k);
    }

    #[test]
    fn small_files_and_repair_only() {
        for n in [1usize, 17, 479, 480, 481, 5_000] {
            let file = data(n);
            let enc = FountainEncoder::new(&file, 300);
            let k = enc.source_count();
            let mut dec = FountainDecoder::new(&enc.oti());
            // только ремонтные пакеты — исходных приёмник не видел вовсе
            let mut i = k * 3;
            while !dec.push(&enc.packet(i)) {
                i += 1;
                assert!(i < k * 3 + k + 10);
            }
            assert_eq!(dec.result().unwrap(), &file[..]);
        }
    }
}
