# Протокол DotLink

Один порт TCP **47800**: HTTP (интерфейс, файлы) и WebSocket `/ws`. UDP **47801** — маяк для поиска. mDNS — служба `_dotlink._tcp.local.` с TXT `id`, `name`, `v`.
Реализации: `crates/dotlink-core/src/{proto,crypto,session,transport,rtc,relay,bt}.rs` и `web/src/lib/{proto,crypto,link,pipe,rtc}.ts`.

## Пути

Сессия одинакова на любом пути; путь — только способ доставить сообщения «текст» (до входа) и «данные» (после).

| Путь | Как | Когда |
|---|---|---|
| Wi-Fi | WebSocket `ws://<ip>:47800/ws` | телефон и ПК в одной сети (Wi-Fi, хотспот, USB-модем) |
| Ретранслятор | WebSocket `wss://<relay>/v1/phone/<комната>` ↔ `…/v1/pc/<комната>/<sid>` | разные сети; см. docs/RELAY.md |
| Bluetooth | RFCOMM, служба `6c1f2d3e-9a4b-4f5c-8d7e-0a1b2c3d4e5f`; кадр = u8 вид (0 текст, 1 данные) ‖ u32 длина BE ‖ тело | нет ни сети, ни интернета |
| WebRTC | DataChannel `ctl` (надёжный, по порядку) и `fast` (без повторов и порядка) поверх уже открытой сессии | всегда, когда получилось: в сети — по UDP, в разных сетях — сквозь NAT |

Телефон стартует попытки с перекрытием (сеть → +0,9 с ретранслятор → +1,8 с Bluetooth) и берёт первую удачную. Через ретранслятор и Bluetooth каждые 15 с проверяет сеть и переходит на неё новой сессией, старую закрывает.

**WebRTC.** После снимка состояния телефон шлёт внутри сессии `rtc-offer {sdp}` и кандидаты `rtc-ice {candidate}`; ПК отвечает `rtc-answer {sdp}`, `rtc-ice`, при ошибке `rtc-failed`. Кадры по DataChannel шифруются ещё раз ключами сессии с метками `dotlink/session/v1/rtc-ctl` и `…/rtc-fast` (у `fast` — окно 64 номеров вместо строгого счётчика: кадры приходят не по порядку, повтор всё равно отвергается). Сообщение DataChannel — до 16 КБ; крупнее (видео, файлы, снимок) идут основным путём. Движение — по `fast`, команды — по `ctl`; ответ на пинг — тем же путём, каким пришёл пинг.

## Поиск

- **mDNS.** `_dotlink._tcp.local.`, адреса всех интерфейсов, обновляются сами при смене сети.
- **UDP.** Телефон шлёт `DOTLINK?` на 255.255.255.255:47801 и на широковещательные адреса всех интерфейсов. ПК отвечает JSON `{"t":"dotlink","id","name","port","addrs"}`. Выручает, где мультикаст режется.
- **QR (v2).** `http://<ip>:<port>/#v=2&pair=<секрет base64url>&pc=<id>&h=<ip1,ip2…>&p=<порт>&n=<имя>[&r=<ретранслятор>&rm=<комната>][&bt=<адрес Bluetooth>][&go=<ссылка или текст>]`. Открывается и системной камерой: страница пульта сама прочитает фрагмент `#` (он не уходит на сервер) и тут же уберёт его из адреса. Знакомый ПК (`pc` уже сохранён) подключается сразу по ключу устройства, без нового сопряжения. `go` — контекст: ссылка откроется, текст ляжет в буфер телефона.
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

Ошибки: `{"t":"error","code":…}` — `expired`, `bad-pin`, `bad-secret`, `unknown-device`, `bad-auth`, `forbidden`, `revoked`, `pin-local-only` (PIN через ретранслятор).

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
| `0x09` | движение со временем | i16 dx, i16 dy (четверти пикселя), u32 время касания на телефоне, мс — ПК проигрывает путь в ритме пальца |
| `0x0A` | кадр экрана телефона | u8 флаги (1 ключевой, 2 конфигурация SPS/PPS), u32 время, мс, u16 ширина, u16 высота, данные (H.264 Annex B или VP8) |
| `0x0B` | часть файла | u8 вид (0 данные, 1 конец, 2 отмена), u8 длина билета, билет, данные — когда HTTP до ПК недоступен |
| `0x20` | ПК → телефон: мышь ПК | i16 dx, i16 dy в пикселях ПК |
| `0x21` | ПК → телефон: кнопка | u8 кнопка, u8 нажата |
| `0x22` | ПК → телефон: колесо | i16 v, i16 h |

**Команды телефона (JSON):** `media {a: toggle|play|pause|next|prev|stop}`, `mute {v}`, `power {a: lock|sleep|hibernate|restart|shutdown|logoff|display-off}`, `timer {a, sec}` / `timer {cancel:true}`, `macro {id}`, `clip-set {text}`, `upload {name, size|null}` → `ticket {url}`, `clip-files` → `file-offer…`, `file-get {ticket}`, `open-url {url}`, `notify {app, title, text}`, `mirror {on, w, h, codec}`, `uc-exit`, `rtt {ms}`, `rtc-offer`, `rtc-ice`.

**От ПК:** `snapshot {v: {ключ: значение}}`, `state {k, v}`, `perms {v}`, `file-offer {name, size, url}`, `open-url {url}`, `clip-push {text}`, `mirror-req {on, key, bitrate, max}`, `ctl {a, x, y, x2, y2, ms, path, text, key}`, `uc {on, edge}`, `uc-key {vk, down}`, `uc-text {text}`, `denied {what}`, `ok {for, msg}`, `error {msg|code}`, `rtc-answer`, `rtc-ice`, `rtc-failed`.

`ctl` — жест на телефоне, координаты — доли экрана 0..1: `tap {x,y}`, `long {x,y,ms}`, `swipe {x,y,x2,y2,ms}`, `path {path:[x0,y0,x1,y1…], ms}`, `scroll {x,y, x2: dx, y2: dy}` (доли экрана), `text {text}`, `key {key: backspace|delete|enter|left|right|home-line|end|select-all|copy|paste|cut}`, `back`, `home`, `recents`, `notifications`, `quick`, `lock`, `screenshot`.

**Ключи состояния:** `pc`, `vol {level, muted, seq}`, `media {title, artist, album, app, playing, position, duration}`, `art` (data URL), `sys {cpu, cores, mem_used, mem_total, uptime, battery}`, `win {title, app}`, `clip {seq, kind, text|files, from}`, `timer {action, ends_at, total, now}`, `macros`. `routes {lan, port, relay {url, room}, ice, bt}` — как ещё добраться до ПК. Только дашборду: `devices` (с `via` и `p2p`), `settings`, `pairing`, `net`, `received`, `outbox`, `mirror {device, name, w, h, codec}`, `notifs`, `relay {state, url, msg}`, `bt {state, addr, msg}`, `uc {on, device, name}`.

**Дашборд → ПК (служебные):** `mirror-start|mirror-stop|mirror-key {device, bitrate, max}`, `phone-ctl {device, a, …}`, `phone-open-url {device, url}`, `phone-text {device, text}`, `uc-start {device}`, `uc-stop`, `notifs-clear`, `settings-save {settings}`. Кадры экрана телефона дашборд получает как есть (бинарные `0x0A`).

## Файлы

По Wi-Fi байты идут отдельным HTTP-запросом, чтобы не задерживать ввод: `PUT /api/upload/<билет>` (в «Загрузки\DotLink»), `GET /api/download/<билет>`. Билет одноразовый, живёт 2 минуты, выдаётся только по шифрованному каналу.
Через ретранслятор и Bluetooth HTTP до ПК нет — тогда тот же билет используется внутри сессии: телефон шлёт кадры `0x0B` по 32 КБ (не обгоняя сеть) и `0x0B` «конец», ПК отвечает `ok {for:"upload", id, name}`; файл с ПК телефон просит `file-get {ticket}` и получает кадрами `0x0B`.

## QR-поток

Кадр: `'D' ‖ 1 ‖ id u32 ‖ OTI RaptorQ (12) ‖ пакет RaptorQ (4 + символ)` → Base45 → QR, алфавитно-цифровой режим, коррекция L, версия 10/15/20. Полезная нагрузка: `u16 длина ‖ JSON {n, t, s, z} ‖ данные` (deflate-raw, если сжатие выгодно).
