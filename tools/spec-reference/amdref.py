"""AMD 公式の仕様一覧ページ（amd.com）から、各CPUの仕様を取り出す。"""
import html, json, re, sys
src = open(sys.argv[1], encoding='utf-8', errors='replace').read()
t = html.unescape(src)
dec = json.JSONDecoder()
out = {}
for m in re.finditer(r'"elements":', t):
    try:
        el, _ = dec.raw_decode(t, m.end())
    except ValueError:
        continue
    name = (el.get('name') or {}).get('value')
    if not isinstance(name, str) or 'Ryzen' not in name:
        continue
    def v(k):
        x = el.get(k) or {}
        return x.get('formatValue', x.get('value'))
    key = re.sub(r'\s+', ' ', name.replace('™', '').replace('®', '').replace('AMD ', '')).strip().upper()
    key = re.sub(r'\s*\(OEM ONLY\)|\s+WITH .*$|\s+PROCESSOR\b', '', key).strip()
    out.setdefault(key, {k: v(k) for k in ('numOfCpuCores', 'numOfThreads', 'baseClock', 'maxBoostClock', 'l3Cache', 'defaultTdp', 'cpuSocket', 'formFactor')})
json.dump(out, open('amd_ref.json', 'w'), ensure_ascii=False, indent=1)
print(len(out))
