"""amd_ref.json / cpu_ref.json / gpu_ref.json と AMD公式GPU一覧の容量違いの版をまとめて、照合表を書き出す。
使い方: python3 merge.py amd_graphics.html 出力先.json"""
import html
import json
import re
import sys


def n(v):
    m = re.search(r'(\d+(?:\.\d+)?)', str(v))
    return float(m.group(1)) if m else None


def amd_gpu_raw(path):
    t = html.unescape(open(path, encoding='utf-8', errors='replace').read())
    dec = json.JSONDecoder()
    out = {}
    for m in re.finditer(r'"elements":', t):
        try:
            el, _ = dec.raw_decode(t, m.end())
        except ValueError:
            continue
        name = (el.get('name') or {}).get('value')
        if isinstance(name, str):
            out.setdefault(name, {k: (v.get('formatValue', v.get('value')) if isinstance(v, dict) else v) for k, v in el.items() if k != 'name'})
    return out


def first(v):
    return v[0] if isinstance(v, list) and v else v


a = json.load(open('amd_ref.json'))
w = json.load(open('cpu_ref.json'))
g = json.load(open('gpu_ref.json'))
raw = amd_gpu_raw(sys.argv[1])

cpu = {}
for k, x in w.items():
    cpu[k] = {'cores': x['cores'], 'threads': x['threads'], 'tdp': x['tdp'], 'base': x['base'], 'boost': x['boost'], 'l3': x['l3'], 'src': 'Wikipedia',
              'boost_unchecked': 'Arrow_Lake' in x['url']}
for k, x in a.items():
    if not re.match(r'RYZEN [3579] (PRO )?\d{4}[A-Z0-9]*$', k) or re.search(r'\d{4}(U|H|HS|HX|C|M)$', k):
        continue
    cpu[k] = {'cores': n(x['numOfCpuCores']), 'threads': n(x['numOfThreads']), 'tdp': n(x['defaultTdp']), 'base': n(x['baseClock']),
              'boost': n(x['maxBoostClock']), 'l3': n(x['l3Cache']), 'src': 'AMD公式'}
for k, v in cpu.items():
    # Arrow Lake の Wikipedia の表は Pコアの最大クロックだけで、Intel が公表する最大クロックと定義が違うので照合しない
    if v.pop('boost_unchecked', False):
        v['boost'] = None
    for f in ('cores', 'threads'):
        if isinstance(v[f], float) and v[f].is_integer():
            v[f] = int(v[f])

gpu = {}
mobile = re.compile(r'MOBILE|LAPTOP|NOTEBOOK|MAX-Q|\dM$')
for k, es in g.items():
    if mobile.search(k) or not re.match(r'^(GEFORCE (RTX|GTX|GT)|TITAN|RADEON (RX|R9|R7)|ARC A|ARC B)', k):
        continue
    off = [e for e in es if e['src'] == 'AMD公式']
    gpu[k] = [{'vram': e['vram'], 'bw': e['bw'], 'tdp': e['tdp'], 'src': e['src']} for e in (off or es)]
for name, v in raw.items():
    m = re.match(r'AMD Radeon™ (RX [0-9]{4}(?: XT| XTX| GRE)?) \((\d+)GB\)$', name)
    if m and 'Desktop' in (v.get('boardType') or []):
        gpu[f'RADEON {m.group(1)} {m.group(2)} GB'] = [{'vram': n(first(v.get('maxMemorySize'))), 'bw': n(first(v.get('memoryBandwidth'))),
                                                         'tdp': n(first(v.get('typicalBoardPowerDesktop'))), 'src': 'AMD公式'}]

ref = {'note': '仕様の照合表。AMDはamd.comの公式仕様一覧、Intel・NVIDIA・Intel ArcはWikipediaの各世代の表から作成。シートの値の確認だけに使い、サイトには表示しない。'
               '作り直し: sh tools/spec-reference/build.sh',
       'sources': {'AMD公式CPU': 'https://www.amd.com/en/products/specifications/processors.html',
                   'AMD公式GPU': 'https://www.amd.com/en/products/specifications/graphics.html',
                   'NVIDIA': 'https://en.wikipedia.org/wiki/List_of_Nvidia_graphics_processing_units',
                   'Intel Arc': 'https://en.wikipedia.org/wiki/Intel_Arc'},
       'cpu': dict(sorted(cpu.items())), 'gpu': dict(sorted(gpu.items()))}
open(sys.argv[2], 'w').write(json.dumps(ref, ensure_ascii=False, separators=(',', ':')) + '\n')
print(len(cpu), 'CPU /', len(gpu), 'GPU')
