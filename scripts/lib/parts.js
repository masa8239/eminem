'use strict';

// 電源・SSD は製品が多すぎて1つずつ追えないので、「規格 × メーカー」ごとに最安の新品を探す。
// 規格・メーカーは商品名から読み取り、少しでもあいまいな商品は使わない（推測しない）。
// 一覧にないメーカーは「その他」にまとめる（サイトではボタンを押したときだけ表示）。

const COMMON_EXCLUDE = /中古|リユース|並行輸入|平行輸入|海外版|アウトレット|訳あり|ジャンク|再生品|未使用品|開封|展示品|バルク|福袋|セット品|ゲーミングPC|デスクトップPC|パソコン本体|BTO|ノートPC本体/i;

function normalizeTitle(title) {
  return String(title || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/［|【/g, '[').replace(/］|】/g, ']')
    .replace(/\s+/g, ' ');
}

// ---- メーカー ----
// [表示名, 商品名に出てくる表記]。上から順に調べ、最初に見つかったメーカーにする（2社以上見つかったら判定しない）
const PSU_MAKERS = [
  ['Corsair', /CORSAIR|コルセア/i], ['Seasonic', /SEASONIC|シーソニック/i], ['Antec', /ANTEC|アンテック/i],
  ['玄人志向', /玄人志向|KUROUTOSHIKOU/i], ['Cooler Master', /COOLER\s*MASTER|クーラーマスター/i], ['be quiet!', /BE\s*QUIET/i],
  ['FSP', /(?<![A-Z])FSP(?![A-Z])/i], ['Thermaltake', /THERMALTAKE|サーマルテイク/i], ['SilverStone', /SILVER\s*STONE|シルバーストーン/i],
  ['MSI', /(?<![A-Z])MSI(?![A-Z])|エムエスアイ/i], ['ASUS', /(?<![A-Z])ASUS(?![A-Z])|エイスース/i], ['NZXT', /NZXT/i],
  ['DeepCool', /DEEP\s*COOL|ディープクール/i], ['Super Flower', /SUPER\s*FLOWER|スーパーフラワー/i], ['GIGABYTE', /GIGABYTE|ギガバイト/i],
  ['Fractal Design', /FRACTAL\s*DESIGN|フラクタル/i], ['Lian Li', /LIAN\s*LI|リアンリー/i], ['ENERMAX', /ENERMAX|エナーマックス/i],
  ['ASRock', /ASROCK|アスロック/i], ['Cougar', /COUGAR|クーガー/i], ['Montech', /MONTECH/i], ['Thermalright', /THERMALRIGHT/i],
];
const SSD_MAKERS = [
  ['Samsung', /SAMSUNG|サムスン/i], ['WD', /WESTERN\s*DIGITAL|(?<![A-Z])WD(?![A-Z])|WD_BLACK|ウエスタンデジタル/i], ['SanDisk', /SANDISK|サンディスク/i],
  ['Crucial', /CRUCIAL|クルーシャル/i], ['Kioxia', /KIOXIA|キオクシア/i], ['Kingston', /KINGSTON|キングストン/i],
  ['SK hynix', /SK\s*HYNIX|ハイニックス/i], ['Solidigm', /SOLIDIGM|ソリダイム/i], ['Transcend', /TRANSCEND|トランセンド/i],
  ['Seagate', /SEAGATE|シーゲイト/i], ['Lexar', /LEXAR|レキサー/i], ['CFD', /CFD/i], ['Corsair', /CORSAIR|コルセア/i],
  ['ADATA', /ADATA|エーデータ|XPG/i], ['TEAMGROUP', /TEAM\s*GROUP|(?<![A-Z])TEAM(?![A-Z])|チームグループ/i], ['Silicon Power', /SILICON\s*POWER|シリコンパワー/i],
  ['PNY', /(?<![A-Z])PNY(?![A-Z])/i], ['Sabrent', /SABRENT/i], ['MSI', /(?<![A-Z])MSI(?![A-Z])/i], ['Micron', /MICRON|マイクロン/i],
  ['GIGABYTE', /GIGABYTE|AORUS/i], ['Acer', /(?<![A-Z])ACER(?![A-Z])|PREDATOR/i], ['Verbatim', /VERBATIM|バーベイタム/i],
];

function makerOf(text, makers) {
  const hits = makers.filter(([, re]) => re.test(text)).map(([name]) => name);
  // WD と SanDisk は同じ会社の表記ゆれ（WD_BLACK を SanDisk が販売）なので1つにまとめる
  const set = new Set(hits.map(n => (n === 'SanDisk' ? 'WD' : n === 'Micron' ? 'Crucial' : n)));
  if (set.size === 1) return [...set][0];
  return set.size === 0 ? 'その他' : null;
}

// ---- 電源 ----
const PSU_RATINGS = [['Titanium', /TITANIUM|チタン/i], ['Platinum', /PLATINUM|プラチナ/i], ['Gold', /GOLD|ゴールド/i], ['Bronze', /BRONZE|ブロンズ/i]];
const PSU_EXCLUDE = /SFX|TFX|FLEX|1U|2U|サーバー|server|ケーブル単品|ケーブルのみ|延長ケーブル|変換ケーブル|スリーブケーブル|カスタムケーブル|テスター|ACアダプター|ノート用|外付け|UPS|無停電/i;

function parsePsu(title) {
  const t = normalizeTitle(title);
  if (COMMON_EXCLUDE.test(t) || PSU_EXCLUDE.test(t)) return null;
  if (!/電源|PSU|POWER\s*SUPPLY|80\s*PLUS/i.test(t)) return null;
  let watts = [...t.matchAll(/(?<![\d.])(\d{3,4})\s*W(?![A-Za-z])/gi)].map(m => Number(m[1])).filter(w => w >= 400 && w <= 1700);
  // 12V-2x6（12VHPWR）コネクタの「600W」はGPU向けケーブルの上限で、電源の容量ではない
  if (/12V-?2X6|12VHPWR|12V\s*2x6/i.test(t)) watts = watts.filter(w => w !== 600 || watts.every(x => x === 600));
  const wset = [...new Set(watts)];
  if (wset.length !== 1) return null;
  if (!/80\s*PLUS|80PLUS/i.test(t)) return null;
  const ratings = PSU_RATINGS.filter(([, re]) => re.test(t)).map(([n]) => n);
  if (ratings.length !== 1) return null;
  const maker = makerOf(t, PSU_MAKERS);
  if (!maker) return null;
  return {watts: wset[0], rating: ratings[0], maker, atx3: /ATX\s*3\.[01]|ATX3\.[01]/i.test(t)};
}

const PSU_SPECS = [650, 750, 850, 1000, 1200].flatMap(watts => ['Bronze', 'Gold', 'Platinum'].map(rating => ({
  category: 'psu', key: `${watts}W ${rating}`, label: `${watts}W 80PLUS ${rating}`, watts, rating,
  queries: [`電源ユニット ${watts}W 80PLUS ${rating}`],
  floor: Math.round(watts * 6),
  matches: p => p.watts === watts && p.rating === rating,
  parse: parsePsu,
})));

// ---- SSD ----
const SSD_EXCLUDE = /外付け|ポータブル|PORTABLE|USB|EXTERNAL|ケース単体|エンクロージャ|ヒートシンク単体|2230|2242|M\.2\s*2230|mSATA|SAS|U\.2|サーバー|HDD|ハードディスク|SDカード|microSD|USBメモリ|NAS用|ケーブル/i;
const CAPS = [[500, 480, 512], [1000, 960, 1024], [2000, 1920, 2048], [4000, 3840, 4096]];

function parseSsd(title) {
  const t = normalizeTitle(title);
  if (COMMON_EXCLUDE.test(t) || SSD_EXCLUDE.test(t)) return null;
  if (!/SSD/i.test(t)) return null;
  const sizes = new Set();
  for (const m of t.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(TB|GB)(?![A-Za-z\/])/gi)) {
    const gb = Number(m[1]) * (/TB/i.test(m[2]) ? 1000 : 1);
    const cap = CAPS.find(([, lo, hi]) => gb >= lo && gb <= hi);
    if (cap) sizes.add(cap[0]);
    else if (gb >= 100) return null; // 一覧にない容量（256GB・8TB など）が書かれている商品は使わない
  }
  if (sizes.size !== 1) return null;
  const gen5 = /PCIE\s*(GEN\s*)?5(\.0)?(?![\d.])|GEN\s*5(?![\d])|PCIE5/i.test(t);
  const gen4 = /PCIE\s*(GEN\s*)?4(\.0)?(?![\d.])|GEN\s*4(?![\d])|PCIE4/i.test(t);
  const sata = /SATA|2\.5\s*(インチ|INCH|")/i.test(t) && !/NVME|PCIE/i.test(t);
  const types = [gen5 && 'Gen5', gen4 && 'Gen4', sata && 'SATA'].filter(Boolean);
  if (types.length !== 1) return null;
  if (types[0] !== 'SATA' && !/NVME|M\.2|PCIE/i.test(t)) return null;
  const maker = makerOf(t, SSD_MAKERS);
  if (!maker) return null;
  return {type: types[0], capacity: [...sizes][0], maker};
}

const SSD_SPECS = [['Gen5', [1000, 2000, 4000]], ['Gen4', [500, 1000, 2000, 4000]], ['SATA', [500, 1000, 2000]]].flatMap(([type, caps]) => caps.map(capacity => {
  const cap = capacity >= 1000 ? `${capacity / 1000}TB` : `${capacity}GB`;
  const iface = type === 'SATA' ? 'SATA 2.5インチ' : `NVMe ${type}`;
  return {
    category: 'ssd', key: `${type} ${cap}`, label: `${iface} ${cap}`, type, capacity,
    queries: [type === 'SATA' ? `SSD ${cap} 2.5インチ SATA` : `SSD ${cap} M.2 NVMe PCIe ${type}`],
    floor: Math.round(capacity * 3),
    matches: p => p.type === type && p.capacity === capacity,
    parse: parseSsd,
  };
}));

// 安い順の検索結果から、規格が一致する在庫ありの新品を、メーカーごとに最安1件ずつ選ぶ。
// 1店だけの出品は相場とかけ離れていても気づけないので、2店以上で売られているメーカーだけ残す
function pickByMaker(spec, items) {
  const byMaker = new Map();
  for (const item of [...items].sort((a, b) => a.itemPrice - b.itemPrice)) {
    if (!item || item.availability === 0 || !Number.isSafeInteger(item.itemPrice) || item.itemPrice < spec.floor) continue;
    const parsed = spec.parse(item.itemName);
    if (!parsed || !spec.matches(parsed)) continue;
    if (!byMaker.has(parsed.maker)) byMaker.set(parsed.maker, {best: null, shops: new Set()});
    const entry = byMaker.get(parsed.maker);
    entry.shops.add(item.shopName || item.itemCode);
    if (!entry.best) entry.best = {...item, parsed};
  }
  return [...byMaker.entries()].filter(([, e]) => e.shops.size >= 2).map(([maker, e]) => ({maker, item: e.best, shops: e.shops.size}))
    .sort((a, b) => a.item.itemPrice - b.item.itemPrice);
}

module.exports = {PSU_SPECS, SSD_SPECS, parsePsu, parseSsd, pickByMaker, makerOf, PSU_MAKERS, SSD_MAKERS};
