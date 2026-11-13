"""Wikipedia の表（行・列の結合あり）を、結合をほどいた2次元の表として読み出す。"""
import html as htmllib
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = 'BenchcoreVerifier/1.0 (data accuracy check)'


def fetch_render(title):
    url = 'https://en.wikipedia.org/w/index.php?title=' + urllib.parse.quote(title.replace(' ', '_')) + '&action=render'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode('utf-8'), 'https://en.wikipedia.org/wiki/' + urllib.parse.quote(title.replace(' ', '_'))


class _Tables(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []      # list of list of rows; row = list of (text, rowspan, colspan, is_header)
        self.stack = []
        self.cell = None
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('style', 'script') or (tag == 'sup' and 'reference' in (a.get('class') or '')):
            self.skip += 1
            return
        if self.skip:
            return
        if tag == 'table':
            self.stack.append([])
        elif tag == 'tr' and self.stack:
            self.stack[-1].append([])
        elif tag in ('td', 'th') and self.stack and self.stack[-1]:
            def num(v):
                try:
                    return max(1, int(re.sub(r'\D', '', v or '1') or 1))
                except ValueError:
                    return 1
            self.cell = {'text': [], 'rs': num(a.get('rowspan')), 'cs': num(a.get('colspan')), 'th': tag == 'th'}
        elif tag == 'br' and self.cell is not None:
            self.cell['text'].append(' ')

    def handle_endtag(self, tag):
        if tag in ('style', 'script', 'sup') and self.skip:
            self.skip -= 1
            return
        if self.skip:
            return
        if tag in ('td', 'th') and self.cell is not None and self.stack and self.stack[-1]:
            text = re.sub(r'\s+', ' ', ''.join(self.cell['text'])).strip()
            self.stack[-1][-1].append((text, self.cell['rs'], self.cell['cs'], self.cell['th']))
            self.cell = None
        elif tag == 'table' and self.stack:
            self.tables.append(self.stack.pop())

    def handle_data(self, data):
        if not self.skip and self.cell is not None:
            self.cell['text'].append(data)


def grids(html_text):
    """各表を、結合を展開した行のリスト（各セルは文字列）で返す。"""
    p = _Tables()
    p.feed(html_text)
    out = []
    for rows in p.tables:
        grid, pending = [], {}
        for row in rows:
            line, col, cells = [], 0, list(row)
            while cells or col in pending:
                if col in pending:
                    text, left = pending[col]
                    line.append(text)
                    if left > 1:
                        pending[col] = (text, left - 1)
                    else:
                        del pending[col]
                    col += 1
                    continue
                text, rs, cs, _ = cells.pop(0)
                for k in range(cs):
                    line.append(text)
                    if rs > 1:
                        pending[col] = (text, rs - 1)
                    col += 1
            grid.append(line)
        out.append(grid)
    return out
