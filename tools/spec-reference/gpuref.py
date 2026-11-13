"""GPU の仕様（VRAM・帯域幅・消費電力）を出典ごとに集める。同じ名前で複数の仕様がある製品は全部残す。"""
import html
import json
import re
import sys
import time

sys.path.insert(0, '.')
from tables import fetch_render, grids  # noqa: E402

NUM = re.compile(r'(\d+(?:,\d{3})*(?:\.\d+)?)')


def num(s):
    m = NUM.search(str(s))
    return float(m.group(1).replace(',', '')) if m else None


def norm(name):
    n = html.unescape(name).replace('™', '').replace('®', '')
    n = re.sub(r'\[.*?\]', '', n)
    n = re.sub(r'^(AMD|NVIDIA|Nvidia|Intel)\s+', '', n.strip())
    n = re.sub(r'\s+', ' ', n).strip().upper()
    return n


def labels(grid, upto):
    cols = max(len(r) for r in grid)
    out = []
    for c in range(cols):
        parts = []
        for r in grid[:upto]:
            if c < len(r) and r[c] and r[c] not in parts:
                parts.append(r[c])
        out.append(' / '.join(parts).lower())
    return out


def wiki_rows(title, url_title=None):
    h, url = fetch_render(title)
    out = []
    for g in grids(h):
        if not g or not g[0] or 'model' not in g[0][0].lower():
            continue
        arc = g[0][0].lower().startswith('branding')
        first = g[0][0].strip().lower()
        hdr = 0
        while hdr < len(g) and g[hdr] and g[hdr][0].strip().lower() == first:
            hdr += 1
        lab = labels(g, hdr)
        def col(pred):
            return next((i for i, L in enumerate(lab) if pred(L)), None)
        c_size = col(lambda L: 'memory' in L and 'size' in L) or col(lambda L: L.endswith('size (gb)') or 'size (gib)' in L or 'size (mib)' in L or 'size (mb)' in L)
        c_bw = col(lambda L: 'bandwidth' in L)
        c_tdp = col(lambda L: 'tdp' in L or 'tbp' in L or 'board power' in L)
        if c_size is None and c_bw is None and c_tdp is None:
            continue
        unit_mb = c_size is not None and ('mib' in lab[c_size] or '(mb)' in lab[c_size])
        for r in g[hdr:]:
            if not r or len(r) < 5:
                continue
            name = norm('Arc ' + r[1]) if arc else norm(r[0])
            name = re.sub(r'\s*\([A-Z0-9 ]+\)$', '', name) if not arc else name
            if not name or len(name) > 60:
                continue
            def cell(c):
                return r[c] if c is not None and c < len(r) else ''
            size = num(cell(c_size))
            if size is not None and unit_mb:
                size = size / 1024
            out.append({'name': name, 'vram': size, 'bw': num(cell(c_bw)), 'tdp': num(cell(c_tdp)),
                        'raw': {'size': cell(c_size), 'bw': cell(c_bw), 'tdp': cell(c_tdp)},
                        'src': 'Wikipedia', 'url': url})
    return out


def amd_official(path):
    t = html.unescape(open(path, encoding='utf-8', errors='replace').read())
    dec = json.JSONDecoder()
    out, seen = [], set()
    for m in re.finditer(r'"elements":', t):
        try:
            el, _ = dec.raw_decode(t, m.end())
        except ValueError:
            continue
        name = (el.get('name') or {}).get('value')
        if not isinstance(name, str) or name in seen:
            continue
        seen.add(name)
        def v(k):
            x = el.get(k)
            if not isinstance(x, dict):
                return None
            y = x.get('formatValue', x.get('value'))
            return y[0] if isinstance(y, list) and y else y
        out.append({'name': norm(name), 'vram': num(v('maxMemorySize')), 'bw': num(v('memoryBandwidth')),
                    'tdp': num(v('typicalBoardPowerDesktop')),
                    'board': v('boardType'),
                    'raw': {'size': v('maxMemorySize'), 'bw': v('memoryBandwidth'), 'tdp': v('typicalBoardPowerDesktop')},
                    'src': 'AMD公式', 'url': 'https://www.amd.com/en/products/specifications/graphics.html'})
    return out


def main():
    ref = {}
    rows = amd_official(sys.argv[1] if len(sys.argv) > 1 else 'amd_graphics.html')
    for title in ['List of Nvidia graphics processing units', 'List of AMD graphics processing units', 'Intel Arc']:
        try:
            rows += wiki_rows(title)
        except Exception as e:  # noqa: BLE001
            print('取得失敗', title, e, file=sys.stderr)
        time.sleep(1)
    for r in rows:
        ref.setdefault(r['name'], []).append(r)
    json.dump(ref, open('gpu_ref.json', 'w'), ensure_ascii=False, indent=1)
    print(len(ref), 'names')


if __name__ == '__main__':
    main()
