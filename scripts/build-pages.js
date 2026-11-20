'use strict';

// 検索エンジンから見つけてもらうための、製品ごとの静的ページを作る（GitHub Actions で毎日実行）。
//   p/<製品>.html … 1製品の最安値・スコア・仕様・近い性能の製品
//   p/cpu.html, p/gpu.html … 製品ページの一覧
//   p/<A>-vs-<B>.html, p/cpu-vs.html, p/gpu-vs.html … 2製品の比較ページと、その一覧
//   p/gaming-pc-<N>man.html, p/gaming-pc.html … 予算ごとのゲーミングPC構成と、その一覧
//   sitemap.xml, robots.txt, data/pages.json（サイトから製品ページへリンクするための一覧）
// 値はサイトと同じ（スプレッドシート・価格ファイル・Blender のファイル）。新しく推測した値は載せない。

const fs = require('node:fs');
const path = require('node:path');
const {loadModels} = require('./update-rakuten-prices');
const budget = require('./lib/budget');

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
<p><a href="/p/gaming-pc.html">予算別のゲーミングPC構成</a> ・ <a href="/p/gpu-vs.html">GPUの比較</a> ・ <a href="/p/cpu-vs.html">CPUの比較</a> ・ <a href="/?page=about">運営者情報・利用規約・プライバシーポリシー</a></p>
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
    if (!out[row.category] || row.discontinued || seen.has(`${row.category}\0${row.name}`)) continue; // 販売終了の製品はページを作らない
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
  if (item.category === 'cpu' && item.single > 0) scores.push(['PassMark（シングルスレッド）', num(item.single)]);
  if (item.blender) scores.push([`Blender Benchmark（Blender ${esc(item.blenderVersion || '')}）`, `${num(item.blender.score)}（${item.blenderOf}製品中 ${item.blenderRank} 位・測定 ${Number(item.blender.samples).toLocaleString('ja-JP')} 件${item.blender.computeType ? '・' + esc(item.blender.computeType) : ''}）`]);

  // 近い性能の製品（同じ指標で上下3つずつ）
  // 近い性能の製品は、この製品にスコアがあるときだけ出す（価格だけの製品は比べる基準がない）
  const key = item.score > 0 ? 'score' : item.blender ? 'blender' : null;
  const ranked = key ? list.filter(x => key === 'score' ? x.score > 0 : x.blender).sort((a, b) => key === 'score' ? b.score - a.score : b.blender.score - a.blender.score) : [];
  const at = ranked.indexOf(item);
  const near = at < 0 ? [] : ranked.slice(Math.max(0, at - 3), at + 4).filter(x => x !== item);
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
${(item.pairs || []).length ? `<h2>${esc(item.name)} とほかの${cat}の比較</h2><ul>${item.pairs.map(([p, q]) => `<li><a href="/p/${pairSlug(p, q)}.html">${esc(p.name)} vs ${esc(q.name)}</a></li>`).join('')}</ul>` : ''}
<p style="margin-top:24px"><a href="/?page=${item.category}-rank">${cat}ランキングをすべて見る</a> ・ <a href="/?page=${item.category}-compare">${cat}を2つ選んで比較する</a></p>`;
  return layout({title, description, canonical, body});
}

// ---- 2製品の比較ページ（p/<A>-vs-<B>.html） ----
// 比べる組み合わせは、スコアと今の価格がある製品のうち
//   ・スコアが近い製品（上下2つずつ）
//   ・メーカー違いでいちばんスコアが近い製品（Intel と AMD、NVIDIA と AMD など）
//   ・前の世代の同じ位置づけの製品
// 文章は数字から機械的に作る（推測や主観の評価は書かない）
const PAIR_NEIGHBORS = 2;
const pairSlug = (a, b) => `${a.slug}-vs-${b.slug}`;

function comparePairs(list) {
  const ranked = list.filter(x => x.score > 0 && x.offer).sort((a, b) => b.score - a.score);
  const pairs = new Map();
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    const [x, y] = a.slug < b.slug ? [a, b] : [b, a];
    pairs.set(pairSlug(x, y), [x, y]);
  };
  ranked.forEach((item, i) => {
    for (let k = 1; k <= PAIR_NEIGHBORS; k++) add(item, ranked[i + k]);
    const rival = ranked.filter(x => x.maker && item.maker && x.maker !== item.maker)
      .sort((a, b) => Math.abs(a.score - item.score) - Math.abs(b.score - item.score))[0];
    add(item, rival);
    // 前の世代の同じ位置づけの製品（RTX 5060 と 4060、Ryzen 7 9800X3D と 7800X3D、Core i5-14600K と 13600K など）
    const m = item.name.match(/^(.*?)(\d)(\d{3,4})(.*)$/);
    if (m) {
      for (const back of [1, 2]) {
        const g = Number(m[2]) - back;
        if (g < 1) break;
        const prev = ranked.find(x => x.name === `${m[1]}${g}${m[3]}${m[4]}`);
        if (prev) { add(item, prev); break; }
      }
    }
  });
  return [...pairs.values()];
}

const pct = (a, b) => Math.round((a / b - 1) * 100);

function compareSummary(a, b, metric) {
  const lines = [];
  const [hi, lo] = a.score >= b.score ? [a, b] : [b, a];
  const dd = pct(hi.score, lo.score);
  lines.push(dd < 3 ? `${metric}のスコアはほぼ同じです（差は ${dd}%）。` : `${metric}のスコアは ${hi.name} の方が ${dd}% 高い結果です。`);
  const pa = a.offer.price, pb = b.offer.price;
  const [cheap, dear] = pa <= pb ? [a, b] : [b, a];
  if (pa === pb) lines.push('最安値は同じです。');
  else lines.push(`最安値は ${cheap.name} の方が ${yen(Math.abs(pa - pb))} 安くなっています。`);
  const va = a.score / pa, vb = b.score / pb;
  const [better] = va >= vb ? [a, b] : [b, a];
  if (Math.abs(pct(va, vb)) >= 3) lines.push(`価格あたりのスコア（1万円あたり）は ${better.name} の方が ${Math.abs(pct(va, vb))}% 高く、コスパでは ${better.name} が上です。`);
  else lines.push('価格あたりのスコア（1万円あたり）はほぼ同じです。');
  if (dd >= 3 && hi === cheap && pa !== pb) lines.push(`${hi.name} は、スコアが高く値段も安いので、この2つでは ${hi.name} を選ぶ理由が多い組み合わせです。`);
  return lines;
}

function comparePage(a, b, category, updated, pairsOf) {
  const cat = category === 'cpu' ? 'CPU' : 'GPU';
  const metric = category === 'cpu' ? 'PassMark（マルチスレッド）' : '3DMark Time Spy（グラフィックスコア）';
  const short = category === 'cpu' ? 'PassMark' : '3DMark';
  const title = `${a.name} と ${b.name} の比較（性能・最安値・コスパ）| BENCHCORE`;
  // 差は「高い方が低い方より何%高いか」で、結論の文と同じ数字にする
  const d = pct(Math.max(a.score, b.score), Math.min(a.score, b.score));
  const description = `${a.name} と ${b.name} を${short}のスコアと最安値で比較。スコアの差は ${d}%、最安値は ${yen(a.offer.price)} と ${yen(b.offer.price)}（${updated}更新）。`;
  const canonical = `${SITE}/p/${pairSlug(a, b)}.html`;
  const perMan = x => num(Math.round(x.score / x.offer.price * 10000));
  const cell = (x, v) => `<td>${v}</td>`;
  const row = (label, va, vb) => `<tr><th>${esc(label)}</th>${cell(a, va)}${cell(b, vb)}</tr>`;
  const offerCell = x => {
    const url = safeHttps(x.offer.url);
    return `${yen(x.offer.price)}${url ? `<br><a href="${esc(url)}" rel="sponsored noopener" target="_blank">${esc(x.offer.source || 'ストア')}で見る</a>` : ''}`;
  };
  const rows = [
    row(metric, `${num(a.score)}（${a.rank}位）`, `${num(b.score)}（${b.rank}位）`),
    ...(category === 'cpu' && a.single > 0 && b.single > 0 ? [row('PassMark（シングルスレッド）', num(a.single), num(b.single))] : []),
    row('最安値', offerCell(a), offerCell(b)),
    row('1万円あたりのスコア', perMan(a), perMan(b)),
  ];
  // Blender は測り方（CUDA・OptiX・HIP など）が製品で違うことがあるので、必ず一緒に書く
  const bl = x => `${num(x.blender.score)}${x.blender.computeType ? `<br><span class="meta">${esc(x.blender.computeType)}</span>` : ''}`;
  if (a.blender && b.blender) rows.push(row(`Blender Benchmark（${a.blenderVersion || ''}）`, bl(a), bl(b)));
  const specA = new Map(specRows(a)), specB = new Map(specRows(b));
  for (const [label] of specRows(a)) {
    const va = specA.get(label), vb = specB.get(label);
    if (va || vb) rows.push(row(label, esc(va || '—'), esc(vb || '—')));
  }
  const related = x => (pairsOf.get(x.slug) || []).filter(([p, q]) => !(p === a && q === b) && !(p === b && q === a)).slice(0, 6)
    .map(([p, q]) => `<li><a href="/p/${pairSlug(p, q)}.html">${esc(p.name)} vs ${esc(q.name)}</a></li>`).join('');
  const relA = related(a), relB = related(b);
  const body = `<div class="crumb"><a href="/">BENCHCORE</a> › <a href="/p/${category}.html">${cat}一覧</a> › 比較</div>
<h1>${esc(a.name)} と ${esc(b.name)} の比較</h1>
<p class="note">${updated}更新。スコアは公開されているベンチマークの値、最安値は毎日自動で取得した価格です。</p>
<h2>結論（数字から）</h2>
<ul>${compareSummary(a, b, metric).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
<h2>性能・価格・仕様の比較</h2>
<div style="overflow-x:auto"><table class="list"><tr><th></th><th><a href="/p/${a.slug}.html">${esc(a.name)}</a></th><th><a href="/p/${b.slug}.html">${esc(b.name)}</a></th></tr>${rows.join('')}</table></div>
<p class="note">ベンチマークのスコアは測定環境で変わります。ゲームでの差は、タイトルや解像度によってスコアの差より大きくも小さくもなります。</p>
${relA || relB ? `<h2>ほかの比較</h2><ul>${relA}${relB}</ul>` : ''}
<p style="margin-top:24px"><a href="/?page=${category}-compare">好きな${cat}を2つ選んで比較する</a> ・ <a href="/p/${category}-vs.html">${cat}の比較ページ一覧</a></p>`;
  return layout({title, description, canonical, body});
}

function compareIndexPage(category, pairs, updated) {
  const cat = category === 'cpu' ? 'CPU' : 'GPU';
  const items = [...pairs].sort((p, q) => Math.max(q[0].score, q[1].score) - Math.max(p[0].score, p[1].score))
    .map(([a, b]) => `<li><a href="/p/${pairSlug(a, b)}.html">${esc(a.name)} vs ${esc(b.name)}</a></li>`).join('');
  const body = `<div class="crumb"><a href="/">BENCHCORE</a> › <a href="/p/${category}.html">${cat}一覧</a> › 比較ページ一覧</div>
<h1>${cat}の比較ページ一覧（${pairs.length}組）</h1>
<p class="note">${updated}更新。性能が近い${cat}と、メーカー違いのライバル製品の組み合わせです。</p>
<ul>${items}</ul>`;
  return layout({title: `${cat}の比較ページ一覧 | BENCHCORE`, description: `性能が近い${cat}同士を、スコア・最安値・コスパで比べたページの一覧（${pairs.length}組）。毎日更新。`, canonical: `${SITE}/p/${category}-vs.html`, body});
}

// ---- 予算ごとのゲーミングPC構成（p/gaming-pc-<N>man.html） ----
const man = yenValue => `${Math.round(yenValue / 10000)}万円`;
const budgetSlug = b => `gaming-pc-${Math.round(b.budget / 10000)}man`;

function budgetRows(b) {
  const link = (url, label) => { const u = safeHttps(url); return u ? `<a href="${esc(u)}" rel="sponsored noopener" target="_blank">${esc(label)}</a>` : ''; };
  const part = (kind, name, price, url, source, detail) => ({kind, name, price, url, source, detail});
  const fromPrice = (kind, p, name) => part(kind, name, p.price, p.url, p.source, p.itemName);
  return [
    part('CPU', `<a href="/p/${b.cpu.slug}.html">${esc(b.cpu.name)}</a>`, b.cpu.offer.price, b.cpu.offer.url, b.cpu.offer.source, ''),
    fromPrice('CPUクーラー', b.cooler, esc(b.cooler.modelName)),
    part('GPU', `<a href="/p/${b.gpu.slug}.html">${esc(b.gpu.name)}</a>`, b.gpu.offer.price, b.gpu.offer.url, b.gpu.offer.source, ''),
    fromPrice('マザーボード', b.mb, `${esc(b.mb.spec.label)}（${esc(b.mb.spec.maker)}）`),
    fromPrice('メモリ', b.ram, esc(b.ram.modelName)),
    fromPrice('SSD', b.ssd, `${esc(b.ssd.spec.label)}（${esc(b.ssd.spec.maker)}）`),
    fromPrice('電源', b.psu, `${esc(b.psu.spec.label)}（${esc(b.psu.spec.maker)}）`),
    fromPrice('ケース', b.case, esc(b.case.modelName)),
  ].map(x => `<tr><td>${x.kind}</td><td>${x.name}${x.detail ? `<br><span class="meta">${esc(String(x.detail).slice(0, 60))}</span>` : ''}</td><td>${yen(x.price)}<br>${link(x.url, (x.source || 'ストア') + 'で見る')}</td></tr>`).join('');
}

function budgetPage(b, all, updated) {
  const title = `予算${man(b.budget)}のゲーミングPC構成（${b.gpu.name}・${b.cpu.name}）| BENCHCORE`;
  const description = `予算${man(b.budget)}で組めるゲーミングPCの構成例。${b.gpu.name} と ${b.cpu.name} で合計 ${yen(b.total)}。毎日の最安値から自動で計算しています（${updated}更新）。`;
  const canonical = `${SITE}/p/${budgetSlug(b)}.html`;
  const bal = b.balance;
  const balText = bal.cpuWeaker ? `CPUとGPUの性能の差は約${Math.round(bal.pct)}%で、バランスは良好です。` : bal.pct < 40 ? `CPUとGPUの性能の差は約${Math.round(bal.pct)}%で、バランスは良好です。` : `CPUの性能に余裕があります（差は約${Math.round(bal.pct)}%）。将来GPUだけ交換するときにも使いやすい組み合わせです。`;
  const others = all.filter(x => x !== b).map(x => `<li><a href="/p/${budgetSlug(x)}.html">予算${man(x.budget)}</a>（${esc(x.gpu.name)}・合計 ${yen(x.total)}）</li>`).join('');
  const body = `<div class="crumb"><a href="/">BENCHCORE</a> › <a href="/p/gaming-pc.html">予算別のゲーミングPC構成</a> › 予算${man(b.budget)}</div>
<h1>予算${man(b.budget)}のゲーミングPC構成</h1>
<div class="price"><div class="meta">${updated}の最安値で計算（OSは含みません）</div>
<strong>${yen(b.total)}</strong> <span class="meta">予算まで残り ${yen(b.budget - b.total)}</span>
<div>GPU: <a href="/p/${b.gpu.slug}.html">${esc(b.gpu.name)}</a>（3DMark ${num(b.gpu.score)}）・CPU: <a href="/p/${b.cpu.slug}.html">${esc(b.cpu.name)}</a>（PassMark ${num(b.cpu.score)}）</div></div>
<h2>パーツ一覧</h2>
<div style="overflow-x:auto"><table class="list"><tr><th>パーツ</th><th>製品</th><th>最安値</th></tr>${budgetRows(b)}</table></div>
<h2>CPUとGPUのバランス</h2>
<p>${esc(balText)}<a href="/?page=bottleneck">ボトルネック診断</a>と同じ計算です。</p>
<h2>この構成の決め方</h2>
<ul>
<li>予算内で、GPUのスコア（3DMark Time Spy）がいちばん高くなる組み合わせを選んでいます。CPUは、GPUとのバランスが取れるもののうち、予算内でいちばんスコアの高いものです。</li>
<li>マザーボードはCPUのソケットに合うBシリーズ以上の最安値、メモリは${b.budget <= 150000 ? '16GB' : '32GB'}、SSDはNVMe Gen4の${b.budget >= 300000 ? '2TB' : '1TB'}です。</li>
<li>電源は、CPUとGPUの消費電力の合計 × 1.3 + 100W 以上（この構成では${b.psuNeed}W以上）${b.budget >= 250000 ? 'で、80PLUS Gold 以上' : ''}の最安値です。</li>
<li>マザーボード・メモリ・SSD・電源は「規格ごとの最安値」の製品です。商品名を確認してから購入してください。</li>
</ul>
<p class="note">価格は毎日変わるため、構成も毎日変わることがあります。マザーボードは、新しいCPUを使うときにBIOSの更新が必要な場合があります。購入前に、メーカーの対応CPU一覧を確認してください。</p>
<p><a href="/?page=builder">構成ビルダーでパーツを入れ替えて試す</a></p>
${others ? `<h2>ほかの予算の構成</h2><ul>${others}</ul>` : ''}`;
  return layout({title, description, canonical, body});
}

function budgetIndexPage(builds, updated) {
  const rows = builds.map(b => `<tr><td><a href="/p/${budgetSlug(b)}.html">予算${man(b.budget)}</a></td><td>${esc(b.gpu.name)}</td><td>${esc(b.cpu.name)}</td><td>${yen(b.total)}</td></tr>`).join('');
  const body = `<div class="crumb"><a href="/">BENCHCORE</a> › 予算別のゲーミングPC構成</div>
<h1>予算別のゲーミングPC構成</h1>
<p class="note">${updated}更新。毎日の最安値から、予算内でいちばんゲーム性能が高くなる構成を自動で計算しています。予算を上げても同じ構成になる場合は、低い方の予算だけを載せています。</p>
<div style="overflow-x:auto"><table class="list"><tr><th>予算</th><th>GPU</th><th>CPU</th><th>合計</th></tr>${rows}</table></div>`;
  return layout({title: '予算別のゲーミングPC構成（毎日の最安値で自動計算）| BENCHCORE', description: `予算${builds.map(b => man(b.budget)).join('・')}のゲーミングPC構成例。毎日の最安値から自動で計算（${updated}更新）。`, canonical: `${SITE}/p/gaming-pc.html`, body});
}

function indexPage(category, list, updated) {
  const cat = category === 'cpu' ? 'CPU' : 'GPU';
  const sorted = [...list].sort((a, b) => (b.score || 0) - (a.score || 0) || (b.blender?.score || 0) - (a.blender?.score || 0));
  const rows = sorted.map(x => `<tr><td><a href="/p/${x.slug}.html">${esc(x.name)}</a></td><td>${x.score > 0 ? num(x.score) : '—'}</td><td>${x.blender ? num(x.blender.score) : '—'}</td><td>${x.offer ? yen(x.offer.price) : '—'}</td></tr>`).join('');
  const body = `<div class="crumb"><a href="/">BENCHCORE</a> › ${cat}一覧</div>
<h1>${cat}の性能と最安値の一覧（${sorted.length}製品）</h1>
<p class="note">${updated}更新。製品名を選ぶと、仕様と近い性能の製品との比較を見られます。 <a href="/p/${category}-vs.html">2製品の比較ページ一覧</a></p>
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
  const pairs = {};
  for (const category of ['cpu', 'gpu']) {
    pairs[category] = comparePairs(data[category]);
    const pairsOf = new Map();
    for (const pair of pairs[category]) for (const x of pair) { if (!pairsOf.has(x.slug)) pairsOf.set(x.slug, []); pairsOf.get(x.slug).push(pair); }
    for (const item of data[category]) item.pairs = pairsOf.get(item.slug) || [];
    for (const item of data[category]) write(`${item.slug}.html`, productPage(item, data[category], updated));
    write(`${category}.html`, indexPage(category, data[category], updated));
    for (const [a, b] of pairs[category]) write(`${pairSlug(a, b)}.html`, comparePage(a, b, category, updated, pairsOf));
    write(`${category}-vs.html`, compareIndexPage(category, pairs[category], updated));
  }
  const builds = budget.buildAll(data.cpu, data.gpu, budget.partsFromPrices(prices, now, PRICE_MAX_AGE_MS));
  for (const b of builds) write(`${budgetSlug(b)}.html`, budgetPage(b, builds, updated));
  if (builds.length) write('gaming-pc.html', budgetIndexPage(builds, updated));
  // シートから消えた製品のページは消す
  for (const file of fs.readdirSync(outDir)) if (file.endsWith('.html') && !written.has(file)) fs.unlinkSync(path.join(outDir, file));

  const day = now.toISOString().slice(0, 10);
  const urls = ['/', '/?page=cpu-rank', '/?page=gpu-rank', '/?page=ram-rank', '/?page=ssd-rank', '/?page=psu-rank', '/?page=mb-rank', '/p/cpu.html', '/p/gpu.html',
    ...data.cpu.map(x => `/p/${x.slug}.html`), ...data.gpu.map(x => `/p/${x.slug}.html`),
    ...(builds.length ? ['/p/gaming-pc.html', ...builds.map(b => `/p/${budgetSlug(b)}.html`)] : []),
    '/p/cpu-vs.html', '/p/gpu-vs.html', ...pairs.cpu.map(([a, b]) => `/p/${pairSlug(a, b)}.html`), ...pairs.gpu.map(([a, b]) => `/p/${pairSlug(a, b)}.html`)];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${esc(SITE + u)}</loc><lastmod>${day}</lastmod></url>`).join('\n')}\n</urlset>\n`;
  fs.writeFileSync(options.sitemapFile || path.join(ROOT, 'sitemap.xml'), sitemap);
  fs.writeFileSync(options.robotsFile || path.join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`);
  const pages = {cpu: Object.fromEntries(data.cpu.map(x => [x.name, x.slug])), gpu: Object.fromEntries(data.gpu.map(x => [x.name, x.slug]))};
  fs.writeFileSync(options.pagesFile || path.join(ROOT, 'data', 'pages.json'), JSON.stringify(pages) + '\n');
  console.log(`製品ページ: CPU ${data.cpu.length} / GPU ${data.gpu.length}、比較ページ: CPU ${pairs.cpu.length} / GPU ${pairs.gpu.length}、予算別構成: ${builds.length}`);
  return 0;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error('製品ページの作成に失敗しました', error && error.message); process.exitCode = 1; });
module.exports = {main, budgetPage, buildData, productPage, comparePairs, comparePage, compareSummary, slug};
