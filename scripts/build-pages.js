'use strict';

// 検索エンジンから見つけてもらうための、製品ごとの静的ページを作る（GitHub Actions で毎日実行）。
//   p/<製品>.html … 1製品の最安値・スコア・仕様・近い性能の製品
//   p/cpu.html, p/gpu.html … 製品ページの一覧
//   sitemap.xml, robots.txt, data/pages.json（サイトから製品ページへリンクするための一覧）
// 値はサイトと同じ（スプレッドシート・価格ファイル・Blender のファイル）。新しく推測した値は載せない。

const fs = require('node:fs');
const path = require('node:path');
const {loadModels} = require('./update-rakuten-prices');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://eminem-steel.vercel.app';
const PRICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const slug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
const num = n => Number(n).toLocaleString('ja-JP', {maximumFractionDigits: 1});
const readJson = file => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch { return null; } };

function safeHttps(url) {
  try { const u = new URL(url); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
}

const STYLE = `
:root{--bg:#fff;--surface:#f5f6f8;--border:#dde1e6;--text:#1f2933;--text2:#4d5967;--accent:#1d5fa8;--good:#2b7a52}
@media (prefers-color-scheme:dark){:root{--bg:#14181d;--surface:#1d232a;--border:#323a44;--text:#e6e9ed;--text2:#a7b0bb;--accent:#7fb2ec;--good:#6cc79a}}
*{box-sizing:border-box}body{margin:0;font-family:'Noto Sans JP',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7;font-size:15px}
a{color:var(--accent)}header,main,footer{max-width:860px;margin:0 auto;padding:0 16px}
header{display:flex;align-items:center;gap:12px;padding-top:14px;padding-bottom:14px;border-bottom:1px solid var(--border)}
.logo{font-weight:800;letter-spacing:.04em;text-decoration:none;color:var(--text)}.logo span{color:var(--accent)}
.crumb{font-size:12px;color:var(--text2);margin:14px 0 4px}h1{font-size:24px;margin:4px 0 10px;line-height:1.35}
h2{font-size:17px;margin:28px 0 10px;border-left:4px solid var(--accent);padding-left:10px}
.price{background:var(--surface);border:1px solid var(--border);padding:14px 16px;border-radius:6px}
.price strong{font-size:26px}.meta{font-size:12px;color:var(--text2)}
.btn{display:inline-block;margin-top:10px;padding:8px 16px;background:var(--accent);color:#fff;text-decoration:none;border-radius:4px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{width:38%;color:var(--text2);font-weight:500}.list td{width:auto}.list th{width:auto}
.note{font-size:12px;color:var(--text2)}footer{margin-top:40px;padding-top:16px;padding-bottom:30px;border-top:1px solid var(--border);font-size:12px;color:var(--text2)}
@media (max-width:600px){h1{font-size:20px}th{width:44%}}
`;

function layout({title, description, canonical, body}) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${esc(canonical)}">
<style>${STYLE}</style>
</head>
<body>
<header><a class="logo" href="/">BENCH<span>CORE</span></a><span class="meta">PCパーツの性能と最安値を比較</span></header>
<main>
${body}
</main>
<footer>
<p>価格は毎日自動で取得した参考価格です。購入前にリンク先で商品と価格を確認してください。購入リンクにはアフィリエイト広告が含まれます。</p>
<p>CPUのスコアは PassMark、GPUのスコアは 3DMark Time Spy（グラフィックスコア）の公開値、Blender のスコアは <a href="https://opendata.blender.org/">Blender Open Data</a> の中央値です。仕様は AMD 公式の仕様一覧と Wikipedia の各世代の仕様表を基にしています。</p>
<p><a href="/?page=about">運営者情報・利用規約・プライバシーポリシー</a></p>
</footer>
</body>
</html>
`;
}

function buildData(rows, prices, blender, now) {
  const fresh = new Map();
  for (const p of prices) {
    if (p && p.status === 'ok' && Number.isSafeInteger(p.price) && now - new Date(p.fetchedAt) < PRICE_MAX_AGE_MS) fresh.set(`${p.category}\0${p.modelName}`, p);
  }
  const out = {cpu: [], gpu: []};
  const seen = new Set();
  for (const row of rows) {
    if (!out[row.category] || seen.has(`${row.category}\0${row.name}`)) continue;
    seen.add(`${row.category}\0${row.name}`);
    const b = blender && blender[row.category] && blender[row.category].scores && blender[row.category].scores[row.name];
    const item = {...row, slug: slug(row.name), offer: fresh.get(`${row.category}\0${row.name}`) || null,
      blender: b && b.score > 0 ? b : null, blenderVersion: blender && blender[row.category] && blender[row.category].blenderVersion};
    // スコアも価格もない製品はページにしない（中身のないページは作らない）
    if (!(item.score > 0) && !item.blender && !item.offer) continue;
    out[row.category].push(item);
  }
  for (const list of Object.values(out)) {
    const byScore = list.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    byScore.forEach((x, i) => { x.rank = i + 1; x.rankOf = byScore.length; });
    const byBlender = list.filter(x => x.blender).sort((a, b) => b.blender.score - a.blender.score);
    byBlender.forEach((x, i) => { x.blenderRank = i + 1; x.blenderOf = byBlender.length; });
  }
  return out;
}

function specRows(item) {
  if (item.category === 'cpu') {
    return [
      ['メーカー', item.maker], ['ソケット', item.socket], ['コア / スレッド', item.cores ? `${item.cores} コア / ${item.threads || '—'} スレッド` : ''],
      ['クロック', item.clockMax ? `${item.clockMin ? item.clockMin + ' 〜 ' : ''}${item.clockMax} GHz` : ''], ['L3キャッシュ', item.cache ? item.cache + ' MB' : ''],
      ['TDP', item.tdp ? item.tdp + ' W' : ''],
    ];
  }
  return [
    ['メーカー', item.maker], ['VRAM', item.vram], ['メモリ帯域幅', item.bw], ['消費電力', item.tdp ? item.tdp + ' W' : ''],
    ['レイトレーシング（専用回路）', item.rt], ['専用アップスケーラー', item.dlss && item.dlss !== '—' ? item.dlss : ''],
  ];
}

function productPage(item, list, updated) {
  const cat = item.category === 'cpu' ? 'CPU' : 'GPU';
  const scoreName = item.category === 'cpu' ? 'PassMark（マルチスレッド）' : '3DMark Time Spy（グラフィックスコア）';
  const title = `${item.name} の最安値と性能（${item.category === 'cpu' ? 'PassMark' : '3DMark'}・Blender）| BENCHCORE`;
  const parts = [];
  if (item.offer) parts.push(`最安値 ${yen(item.offer.price)}`);
  if (item.score > 0) parts.push(`${item.category === 'cpu' ? 'PassMark' : '3DMark Time Spy'} ${num(item.score)}`);
  if (item.blender) parts.push(`Blender ${num(item.blender.score)}`);
  const description = `${item.name}の${parts.join('、')}。仕様と、近い性能の${cat}との比較をまとめています（${updated}更新）。`;
  const canonical = `${SITE}/p/${item.slug}.html`;

  const offerUrl = item.offer && safeHttps(item.offer.url);
  const price = item.offer && offerUrl
    ? `<div class="price"><div class="meta">最安値（${esc(item.offer.source || 'ストア')}${item.offer.shopName ? '・' + esc(item.offer.shopName) : ''}、${esc(new Date(item.offer.fetchedAt).toLocaleDateString('ja-JP', {timeZone: 'Asia/Tokyo'}))} 取得）</div>
<strong>${yen(item.offer.price)}</strong>${item.offer.points > 0 ? ` <span class="meta">＋${item.offer.points.toLocaleString('ja-JP')}ポイント</span>` : ''}
<div><a class="btn" href="${esc(offerUrl)}" rel="sponsored noopener" target="_blank">${esc(item.offer.source || 'ストア')}で見る</a></div></div>`
    : `<div class="price"><div class="meta">ストアの価格はまだ取得できていません。</div></div>`;

  const scores = [];
  if (item.score > 0) scores.push([scoreName, `${num(item.score)}（${item.rankOf}製品中 ${item.rank} 位）`]);
  if (item.blender) scores.push([`Blender Benchmark（Blender ${esc(item.blenderVersion || '')}）`, `${num(item.blender.score)}（${item.blenderOf}製品中 ${item.blenderRank} 位・測定 ${Number(item.blender.samples).toLocaleString('ja-JP')} 件${item.blender.computeType ? '・' + esc(item.blender.computeType) : ''}）`]);

  // 近い性能の製品（同じ指標で上下3つずつ）
  const key = item.score > 0 ? 'score' : 'blender';
  const ranked = list.filter(x => key === 'score' ? x.score > 0 : x.blender).sort((a, b) => key === 'score' ? b.score - a.score : b.blender.score - a.blender.score);
  const at = ranked.indexOf(item);
  const near = ranked.slice(Math.max(0, at - 3), at + 4).filter(x => x !== item);
  const nearRows = near.map(x => {
    const v = key === 'score' ? x.score : x.blender.score;
    const mine = key === 'score' ? item.score : item.blender.score;
    const diff = Math.round((v / mine - 1) * 100);
    return `<tr><td><a href="/p/${x.slug}.html">${esc(x.name)}</a></td><td>${num(v)}（${diff > 0 ? '+' : ''}${diff}%）</td><td>${x.offer ? yen(x.offer.price) : '—'}</td></tr>`;
  }).join('');

  const body = `<div class="crumb"><a href="/">BENCHCORE</a> › <a href="/p/${item.category}.html">${cat}一覧</a> › ${esc(item.name)}</div>
<h1>${esc(item.name)} の最安値と性能</h1>
${price}
<h2>ベンチマークスコア</h2>
${scores.length ? `<table>${scores.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>` : '<p class="note">スコアはまだありません。</p>'}
<h2>仕様</h2>
<table>${specRows(item).filter(([, v]) => v).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
${near.length ? `<h2>近い性能の${cat}（${key === 'score' ? (item.category === 'cpu' ? 'PassMark' : '3DMark') : 'Blender'}）</h2>
<table class="list"><tr><th>製品</th><th>スコア（${esc(item.name)}との差）</th><th>最安値</th></tr>${nearRows}</table>` : ''}
<p style="margin-top:24px"><a href="/?page=${item.category}-rank">${cat}ランキングをすべて見る</a> ・ <a href="/?page=${item.category}-compare">${cat}を2つ選んで比較する</a></p>`;
  return layout({title, description, canonical, body});
}

function indexPage(category, list, updated) {
  const cat = category === 'cpu' ? 'CPU' : 'GPU';
  const sorted = [...list].sort((a, b) => (b.score || 0) - (a.score || 0) || (b.blender?.score || 0) - (a.blender?.score || 0));
  const rows = sorted.map(x => `<tr><td><a href="/p/${x.slug}.html">${esc(x.name)}</a></td><td>${x.score > 0 ? num(x.score) : '—'}</td><td>${x.blender ? num(x.blender.score) : '—'}</td><td>${x.offer ? yen(x.offer.price) : '—'}</td></tr>`).join('');
  const body = `<div class="crumb"><a href="/">BENCHCORE</a> › ${cat}一覧</div>
<h1>${cat}の性能と最安値の一覧（${sorted.length}製品）</h1>
<p class="note">${updated}更新。製品名を選ぶと、仕様と近い性能の製品との比較を見られます。</p>
<table class="list"><tr><th>製品</th><th>${category === 'cpu' ? 'PassMark' : '3DMark'}</th><th>Blender</th><th>最安値</th></tr>${rows}</table>`;
  return layout({title: `${cat}の性能と最安値の一覧 | BENCHCORE`, description: `${cat} ${sorted.length}製品のベンチマークスコア（${category === 'cpu' ? 'PassMark' : '3DMark Time Spy'}・Blender）と最安値の一覧。毎日更新。`, canonical: `${SITE}/p/${category}.html`, body});
}

async function main(options = {}) {
  const now = options.now || new Date();
  const updated = now.toLocaleDateString('ja-JP', {timeZone: 'Asia/Tokyo'});
  const models = options.models || await loadModels(options.fetchImpl || fetch);
  const rows = (models.specRows || []).filter(r => r.category === 'cpu' || r.category === 'gpu');
  if (!rows.length) { console.log('スプレッドシートを読めなかったため、製品ページは更新しません'); return 1; }
  const prices = (readJson('data/rakuten-prices.json') || {}).products || [];
  const blender = readJson('data/blender-scores.json');
  const data = buildData(rows, prices, blender, now);
  const outDir = options.outDir || path.join(ROOT, 'p');
  fs.mkdirSync(outDir, {recursive: true});
  const written = new Set();
  const write = (file, html) => { fs.writeFileSync(path.join(outDir, file), html); written.add(file); };
  for (const category of ['cpu', 'gpu']) {
    for (const item of data[category]) write(`${item.slug}.html`, productPage(item, data[category], updated));
    write(`${category}.html`, indexPage(category, data[category], updated));
  }
  // シートから消えた製品のページは消す
  for (const file of fs.readdirSync(outDir)) if (file.endsWith('.html') && !written.has(file)) fs.unlinkSync(path.join(outDir, file));

  const day = now.toISOString().slice(0, 10);
  const urls = ['/', '/?page=cpu-rank', '/?page=gpu-rank', '/?page=ram-rank', '/p/cpu.html', '/p/gpu.html',
    ...data.cpu.map(x => `/p/${x.slug}.html`), ...data.gpu.map(x => `/p/${x.slug}.html`)];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${esc(SITE + u)}</loc><lastmod>${day}</lastmod></url>`).join('\n')}\n</urlset>\n`;
  fs.writeFileSync(options.sitemapFile || path.join(ROOT, 'sitemap.xml'), sitemap);
  fs.writeFileSync(options.robotsFile || path.join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`);
  const pages = {cpu: Object.fromEntries(data.cpu.map(x => [x.name, x.slug])), gpu: Object.fromEntries(data.gpu.map(x => [x.name, x.slug]))};
  fs.writeFileSync(options.pagesFile || path.join(ROOT, 'data', 'pages.json'), JSON.stringify(pages) + '\n');
  console.log(`製品ページ: CPU ${data.cpu.length} / GPU ${data.gpu.length}`);
  return 0;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error('製品ページの作成に失敗しました', error && error.message); process.exitCode = 1; });
module.exports = {main, buildData, productPage, slug};
