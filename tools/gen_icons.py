"""Иконки DotLink: точечная «D» 5×7 и акцентная точка. PNG для PWA, Tauri и Android.
Запуск: python3 tools/gen_icons.py (нужен Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BG, FG, ACC = (9, 9, 10), (244, 244, 246), (255, 68, 51)
D = ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.']


def icon(size: int, pad: float, round_bg: bool = True, transparent: bool = False) -> Image.Image:
    s = 4  # суперсэмплинг для гладких точек
    W = size * s
    im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if not transparent:
        if round_bg:
            d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=BG)
        else:
            d.rectangle([0, 0, W, W], fill=BG)
    inner = W * (1 - 2 * pad)
    # сетка 7 колонок (5 буквы + промежуток + акцент) × 7 строк
    pitch = inner / 7
    x0 = (W - pitch * 7) / 2
    y0 = (W - pitch * 7) / 2
    r = pitch * 0.38
    for row, line in enumerate(D):
        for col, ch in enumerate(line):
            cx, cy = x0 + (col + 0.5) * pitch, y0 + (row + 0.5) * pitch
            if ch == '#':
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FG)
            else:
                rr = r * 0.32
                d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(60, 60, 66))
    cx, cy = x0 + 6.5 * pitch, y0 + 6.5 * pitch
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACC)
    return im.resize((size, size), Image.LANCZOS)


def save(im: Image.Image, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


web = ROOT / 'web/public'
save(icon(192, 0.16), web / 'icon-192.png')
save(icon(512, 0.16), web / 'icon-512.png')
save(icon(512, 0.26, round_bg=False), web / 'icon-maskable-512.png')
save(icon(1024, 0.14), ROOT / 'apps/desktop/icon-source.png')

res = ROOT / 'apps/android/resources'
for name, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
    save(icon(px, 0.14), res / f'mipmap-{name}/ic_launcher.png')
    save(icon(px, 0.14), res / f'mipmap-{name}/ic_launcher_round.png')
    # адаптивная иконка: передний план 108dp с безопасной зоной 66dp
    save(icon(int(px * 108 / 48), 0.3, transparent=True), res / f'mipmap-{name}/ic_launcher_foreground.png')
print('icons ok')

# заставка Android: тёмный фон и знак по центру — для каждого splash.png своего размера
for p in sorted((ROOT / 'apps/android/android/app/src/main/res').glob('drawable*/splash.png')):
    w, h = Image.open(p).size
    im = Image.new('RGB', (w, h), BG)
    s = int(min(w, h) * 0.3)
    mark = icon(s, 0.1, transparent=True)
    im.paste(mark, ((w - s) // 2, (h - s) // 2), mark)
    im.save(p)
print('splash ok')
