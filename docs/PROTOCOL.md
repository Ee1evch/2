# Протокол DotLink

Один порт TCP **47800**: HTTP (интерфейс, файлы) и WebSocket `/ws`. UDP **47801** — маяк для поиска. mDNS — служба `_dotlink._tcp.local.` с TXT `id`, `name`, `v`.
Реализации: `crates/dotlink-core/src/{proto,crypto,session}.rs` и `web/src/lib/{proto,crypto,link}.ts`.

## Поиск

- **mDNS.** `_dotlink._tcp.local.`, адреса всех интерфейсов, обновляются сами при смене сети.
- **UDP.** Телефон шлёт `DOTLINK?` на 255.255.255.255:47801 и на широковещательные адреса всех интерфейсов. ПК отвечает JSON `{"t":"dotlink","id","name","port","addrs"}`. Выручает, где мультикаст режется.
- **QR.** `http://<ip>:<port>/#pair=<секрет base64url>&pc=<id>&h=<ip1,ip2…>&n=<имя>`. Открывается и системной камерой: страница пульта сама прочитает фрагмент `#` (он не уходит на сервер) и тут же уберёт его из адреса.
- **Проверка адреса.** `GET /api/info` → `{"t":"dotlink","id","name","port",…}`: телефон пробует все известные адреса параллельно и берёт первый ответивший с нужным `id`.

## Вход (текстовые кадры JSON)

**Сопряжение** (`pair`: `qr` | `pin`):

```
C → {"t":"hello","v":1,"role":"remote","pair":"qr","pub":Pc,"nonce":Nc,"name":"Pixel 8"}
S → {"t":"pair-challenge","pub":Ps,"nonce":Ns,"pc":{…}}
C → {"t":"pair-proof","mac":HMAC(K, "c"‖T‖Z)}
S → {"t":"paired","device":id,"mac":HMAC(K, "s"‖T‖Z),"pc":{…},"perms":{…}}
```

`Z = X25519(…)`, `T = "dotlink/pair/v1"‖Pc‖Ps‖Nc‖Ns`, `K = SHA-256("dotlink/pair-key/v1"‖секрет)`, где секрет — 16 байт из QR или 6 цифр PIN.
Ключ устройства: `HKDF-SHA256(salt=T, ikm=Z‖секрет, info="dotlink/device/v1")`, 32 байта. Предложение одноразовое: после успеха QR и PIN меняются.

**Вход известного устройства:**

```
C → {"t":"hello","v":1,"role":"remote","device":id,"nonce":Nc}
S → {"t":"challenge","nonce":Ns,"pc":{…}}
C → {"t":"auth","mac":HMAC(DK, "dotlink/auth/v1"‖"c"‖Nc‖Ns)}
S → {"t":"welcome","device":id,"mac":HMAC(DK, …"s"…),"pc":{…},"perms":{…}}
```

Ошибки: `{"t":"error","code":…}` — `expired`, `bad-pin`, `bad-secret`, `unknown-device`, `bad-auth`, `forbidden`, `revoked`.

**Дашборд**: `{"t":"hello","role":"admin","token":…}` — только с 127.0.0.1, токен случайный на каждый запуск, без шифрования.

## Канал

`HKDF-SHA256(salt=Nc‖Ns, ikm=DK, info="dotlink/session/v1")` → 96 байт: ключ c→s, ключ s→c, префикс nonce c→s (16), префикс s→c (16).
Кадр — бинарное сообщение WebSocket: `счётчик u64 LE ‖ XChaCha20-Poly1305(ключ, префикс‖счётчик, открытый текст)`. Счётчик строго растёт: повтор и старые кадры отбрасываются.

## Открытый текст

Первый байт — опкод; `{` — значит JSON.

| Код | Кадр | Поля |
|---|---|---|
| `0x01` | движение | i16 dx, i16 dy — в четвертях пикселя; доли копятся на ПК |
| `0x02` | прокрутка | i16 v, i16 h — единицы колеса (120 = щелчок), дробные — плавная прокрутка |
| `0x03` | кнопка | u8 (0 Л, 1 П, 2 ср, 3 X1, 4 X2), u8 (0 отпустить, 1 нажать, 2 клик, 3 двойной) |
| `0x04` | клавиша | u16 VK, u8 (0 отпустить, 1 нажать, 2 нажать и отпустить) |
| `0x05` | текст | UTF-8 → Unicode-события, раскладка не важна |
| `0x06` | сочетание | u8 n, n × u16 VK — нажать по порядку, отпустить в обратном (Win+L → LockWorkStation) |
| `0x07` | громкость | u16 0..10000, u16 номер — номер возвращается в состоянии `vol.seq` |
| `0x08` | пинг | u32 метка; ПК возвращает тот же кадр |

**Команды телефона (JSON):** `media {a: toggle|play|pause|next|prev|stop}`, `mute {v}`, `power {a: lock|sleep|hibernate|restart|shutdown|logoff|display-off}`, `timer {a, sec}` / `timer {cancel:true}`, `macro {id}`, `clip-set {text}`, `upload {name, size|null}` → `ticket {url}`, `clip-files` → `file-offer…`, `rtt {ms}`.

**От ПК:** `snapshot {v: {ключ: значение}}`, `state {k, v}`, `perms {v}`, `file-offer {name, size, url}`, `denied {what}`, `ok {for, msg}`, `error {msg|code}`.

**Ключи состояния:** `pc`, `vol {level, muted, seq}`, `media {title, artist, album, app, playing, position, duration}`, `art` (data URL), `sys {cpu, cores, mem_used, mem_total, uptime, battery}`, `win {title, app}`, `clip {seq, kind, text|files, from}`, `timer {action, ends_at, total, now}`, `macros`. Только дашборду: `devices`, `settings`, `pairing`, `net`, `received`.

## Файлы

Байты идут отдельным HTTP-запросом, чтобы не задерживать ввод: `PUT /api/upload/<билет>` (в «Загрузки\DotLink»), `GET /api/download/<билет>`. Билет одноразовый, живёт 2 минуты, выдаётся только по шифрованному каналу.

## QR-поток

Кадр: `'D' ‖ 1 ‖ id u32 ‖ OTI RaptorQ (12) ‖ пакет RaptorQ (4 + символ)` → Base45 → QR, алфавитно-цифровой режим, коррекция L, версия 10/15/20. Полезная нагрузка: `u16 длина ‖ JSON {n, t, s, z} ‖ данные` (deflate-raw, если сжатие выгодно).
