"""Wikipedia の各世代の表から、デスクトップCPUの公式スペック（出典URL付き）を集める。"""
import json
import re
import sys
import time

sys.path.insert(0, '.')
from tables import fetch_render, grids  # noqa: E402

SOURCES = [
    # (ページ, ソケット, そのページで使う表の番号。None はページ内の表を全部調べる)
    ('Template:AMD Ryzen 1000 series', 'AM4', None),
    ('Template:AMD Ryzen 2000 series', 'AM4', None),
    ('Template:AMD Ryzen 2000 desktop APUs', 'AM4', None),
    ('Template:AMD Ryzen 3000 series', 'AM4', None),
    ('Template:AMD Ryzen 3000 desktop APUs', 'AM4', None),
    ('Template:AMD Ryzen 4000 series', 'AM4', None),
    ('Template:AMD Ryzen 4000G series', 'AM4', None),
    ('Template:AMD Ryzen 5000 Series', 'AM4', None),
    ('Template:AMD Ryzen 5000 desktop APUs', 'AM4', None),
    ('Template:AMD Ryzen 7000 Series', 'AM5', None),
    ('Template:AMD Ryzen 8000 desktop APUs', 'AM5', None),
    ('Template:AMD Ryzen 8000 series', 'AM5', None),
    ('Template:AMD Ryzen 9000 Series', 'AM5', None),
    ('Kaby Lake', 'LGA1151', [1]),
    ('Coffee Lake', 'LGA1151', [1, 4, 5]),
    ('Comet Lake', 'LGA1200', [1, 2]),
    ('Rocket Lake', 'LGA1200', [1]),
    ('Alder Lake', 'LGA1700', [3]),
    ('Raptor Lake', 'LGA1700', [1, 7]),
    ('Arrow Lake (microprocessor)', 'LGA1851', [3, 7]),
]

MODEL = re.compile(r'^(PRO\s+)?\d{3,5}(?:[A-Z]{1,3}\d?[A-Z]?)?(\s+Plus)?$')
CT = re.compile(r'^(\d+)\s*\((\d+)\)$')
NUM = re.compile(r'(\d+(?:\.\d+)?)')


def labels(grid, first_data):
    cols = max(len(r) for r in grid)
    out = []
    for c in range(cols):
        parts = []
        for r in grid[:first_data]:
            if c < len(r) and r[c] and r[c] not in parts:
                parts.append(r[c])
        out.append(' / '.join(parts))
    return out


def num(text):
    m = NUM.search(text.replace(',', ''))
    return float(m.group(1)) if m else None


def parse_grid(grid, socket, url):
    first = next((i for i, r in enumerate(grid) if len(r) > 1 and MODEL.match(r[1].strip())), None)
    if first is None:
        return []
    lab = labels(grid, first)
    out = []
    for r in grid[first:]:
        if len(r) < 3 or not MODEL.match(r[1].strip()):
            continue
        brand, model = r[0].strip(), re.sub(r'\s+', ' ', r[1].strip())
        if not re.match(r'^(Ryzen [3579]|Core (i[3579]|Ultra [579]))$', brand):
            continue
        cores = threads = 0
        total = None
        base = boost = l3 = tdp = None
        for c, cell in enumerate(r[2:], start=2):
            L = lab[c] if c < len(lab) else ''
            m = CT.match(cell.strip())
            if m and 'ore' in L:
                # 「合計」列があるときはそれを使う（内訳の列を足すと二重に数えてしまう）
                if 'total' in L.lower():
                    total = (int(m.group(1)), int(m.group(2)))
                else:
                    cores += int(m.group(1)); threads += int(m.group(2))
                continue
            v = num(cell)
            if v is None:
                continue
            low = L.lower()
            if ('clock' in low or 'ghz' in low) and 'gpu' not in low and 'graphics' not in low and v < 10:
                # 「PB2」は AMD の Precision Boost 2（最大クロック）。列名にベース/ブーストが書かれていない最初の列はベース
                if any(k in low for k in ('turbo', 'boost', 'max', 'pb2', 'pbo')):
                    boost = max(boost or 0, v)
                elif base is None and ('base' in low or 'clock rate' in low):
                    base = v
            if ('l3' in low or 'smart cache' in low or low.endswith('cache')) and 'l4' not in low and 'MB' in cell:
                l3 = v
            if ('tdp' in low or 'power' in low) and tdp is None and re.search(r'\bW\b', cell):
                tdp = v
        if total:
            cores, threads = total
        out.append({'brand': brand, 'model': model, 'cores': cores or None, 'threads': threads or None,
                    'base': base, 'boost': boost, 'l3': l3, 'tdp': tdp, 'socket': socket, 'url': url})
    return out


def main():
    ref = {}
    for title, socket, picks in SOURCES:
        try:
            html, url = fetch_render(title)
        except Exception as e:  # noqa: BLE001
            print('取得失敗', title, e, file=sys.stderr)
            continue
        gs = grids(html)
        for i, g in enumerate(gs):
            if picks is not None and i not in picks:
                continue
            for row in parse_grid(g, socket, url):
                key = f"{row['brand']} {row['model']}".upper()
                ref.setdefault(key, row)
        time.sleep(1)
    json.dump(ref, open('cpu_ref.json', 'w'), ensure_ascii=False, indent=1)
    print(len(ref), 'models')


if __name__ == '__main__':
    main()
