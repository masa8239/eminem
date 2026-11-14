'use strict';

// 電源・SSD は製品が多すぎて1つずつ追えないので、「規格 × メーカー」ごとに最安の新品を探す。
// 規格・メーカーは商品名から読み取り、少しでもあいまいな商品は使わない（推測しない）。
// 一覧にないメーカーは「その他」にまとめる（サイトではボタンを押したときだけ表示）。

const COMMON_EXCLUDE = /選べる|選択式|よりどり|中古|リユース|並行輸入|平行輸入|海外版|アウトレット|訳あり|ジャンク|再生品|未使用品|開封|展示品|バルク|福袋|セット品|ゲーミングPC|デスクトップPC|パソコン本体|BTO|ノートPC本体/i;

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
// makerFix: 商品コード → 人がシートで直したメーカー名
function pickByMaker(spec, items, makerFix = new Map()) {
  const byMaker = new Map();
  for (const item of [...items].sort((a, b) => a.itemPrice - b.itemPrice)) {
    if (!item || item.availability === 0 || !Number.isSafeInteger(item.itemPrice) || item.itemPrice < spec.floor) continue;
    let parsed = spec.parse(item.itemName);
    if (parsed && makerFix.has(item.itemCode)) parsed = {...parsed, maker: makerFix.get(item.itemCode)};
    if (!parsed || !spec.matches(parsed)) continue;
    if (!byMaker.has(parsed.maker)) byMaker.set(parsed.maker, {best: null, shops: new Set()});
    const entry = byMaker.get(parsed.maker);
    entry.shops.add(item.shopName || item.itemCode);
    if (!entry.best) entry.best = {...item, parsed};
  }
  return [...byMaker.entries()].filter(([, e]) => e.shops.size >= 2).map(([maker, e]) => ({maker, item: e.best, shops: e.shops.size}))
    .sort((a, b) => a.item.itemPrice - b.item.itemPrice);
}

// ---- マザーボード ----
const MB_MAKERS = [
  ['ASUS', /(?<![A-Z])ASUS(?![A-Z])|エイスース|ROG\s*STRIX|TUF\s*GAMING|PRIME\s*[A-Z]\d{3}|PROART/i], ['MSI', /(?<![A-Z])MSI(?![A-Z])|エムエスアイ|MAG\s|MPG\s|MEG\s/i],
  ['GIGABYTE', /GIGABYTE|ギガバイト|AORUS/i], ['ASRock', /ASROCK|アスロック/i], ['BIOSTAR', /BIOSTAR|バイオスター/i], ['NZXT', /NZXT/i],
];
// チップセット → ソケット・メモリ（LGA1700 だけは DDR4 と DDR5 の両方がある）
const CHIPSETS = {
  X870E: ['AM5', 'DDR5'], X870: ['AM5', 'DDR5'], B850: ['AM5', 'DDR5'], X670E: ['AM5', 'DDR5'], X670: ['AM5', 'DDR5'], B650E: ['AM5', 'DDR5'], B650: ['AM5', 'DDR5'], A620: ['AM5', 'DDR5'],
  X570: ['AM4', 'DDR4'], B550: ['AM4', 'DDR4'], A520: ['AM4', 'DDR4'],
  Z890: ['LGA1851', 'DDR5'], B860: ['LGA1851', 'DDR5'], H810: ['LGA1851', 'DDR5'],
  Z790: ['LGA1700', null], B760: ['LGA1700', null], H610: ['LGA1700', null], Z690: ['LGA1700', null], B660: ['LGA1700', null],
};
const CHIPSET_RE = /(?<![A-Z0-9])(X870E|X670E|B650E|X870|X670|B850|B650|A620|X570|B550|A520|Z890|B860|H810|Z790|B760|H610|Z690|B660)(M|I)?(?![A-Z0-9])/gi;
const MB_EXCLUDE = /セット|バンドル|同梱|CPU付|メモリ付|組み合わせ|ジャンク|中古|ノート|サーバー|WS\b|ワークステーション|I\/Oシールド単体|バックプレート|ケーブル|ヒートシンク単体/i;

function parseMb(title) {
  const t = normalizeTitle(title);
  if (COMMON_EXCLUDE.test(t) || MB_EXCLUDE.test(t)) return null;
  if (!/マザーボード|MOTHERBOARD|マザボ/i.test(t)) return null;
  const found = [...t.matchAll(CHIPSET_RE)];
  const chipsets = [...new Set(found.map(m => m[1].toUpperCase()))];
  if (chipsets.length !== 1) return null;
  // 「B650 / B650M」のように同じチップセットで別サイズの型番が並ぶ商品は、どれの値段かわからないので使わない
  if (new Set(found.map(m => (m[2] || '').toUpperCase())).size > 1) return null;
  const chipset = chipsets[0];
  // サイズ: 型番の末尾（B650M / B650I）と、商品名の表記（Micro-ATX など）の両方を見て、食い違えば使わない
  const forms = new Set(found.map(m => (m[2] || '').toUpperCase()).filter(Boolean).map(x => (x === 'M' ? 'mATX' : 'ITX')));
  let rest = t;
  if (/MICRO[\s-]?ATX|M[\s-]ATX|MATX|μATX|マイクロATX/i.test(rest)) { forms.add('mATX'); rest = rest.replace(/MICRO[\s-]?ATX|M[\s-]ATX|MATX|μATX|マイクロATX/gi, ' '); }
  if (/MINI[\s-]?ITX|(?<![A-Z])ITX(?![A-Z])/i.test(rest)) { forms.add('ITX'); rest = rest.replace(/MINI[\s-]?ITX|(?<![A-Z])ITX(?![A-Z])/gi, ' '); }
  if (/E[\s-]ATX|EATX|EXTENDED[\s-]ATX/i.test(rest)) return null;
  if (/(?<![A-Z])ATX(?![A-Z0-9.])/i.test(rest)) forms.add('ATX');
  if (forms.size !== 1) return null;
  const [socket, fixedMemory] = CHIPSETS[chipset];
  const mems = [...new Set([...t.matchAll(/DDR([45])/gi)].map(m => 'DDR' + m[1]))];
  let memory = fixedMemory;
  if (fixedMemory) { if (mems.some(x => x !== fixedMemory)) return null; }
  else { if (mems.length !== 1) return null; memory = mems[0]; } // LGA1700 はメモリの種類が書かれていない商品を使わない
  const maker = makerOf(t, MB_MAKERS);
  if (!maker) return null;
  // Wi-Fi は商品名に書かれているときだけ「あり」にする（書かれていないときは不明。「なし」とは決めない）
  const wifi = /WI-?FI|(?<![A-Z])AX(?![A-Z0-9])/i.test(t);
  return {chipset, form: [...forms][0], socket, memory, maker, wifi};
}

const FORM_LABEL = {ATX: 'ATX', mATX: 'Micro-ATX', ITX: 'Mini-ITX'};
const MB_LIST = [
  ['X870E', ['ATX']], ['X870', ['ATX', 'mATX']], ['B850', ['ATX', 'mATX', 'ITX']], ['B650E', ['ATX']], ['B650', ['ATX', 'mATX', 'ITX']], ['A620', ['ATX', 'mATX']],
  ['X570', ['ATX']], ['B550', ['ATX', 'mATX']], ['A520', ['mATX']],
  ['Z890', ['ATX', 'mATX', 'ITX']], ['B860', ['ATX', 'mATX', 'ITX']], ['H810', ['mATX']],
  ['Z790', ['ATX'], 'DDR5'], ['B760', ['ATX', 'mATX'], 'DDR5'], ['B760', ['ATX', 'mATX'], 'DDR4'], ['H610', ['mATX'], 'DDR4'], ['H610', ['mATX'], 'DDR5'],
];
const MB_SPECS = MB_LIST.flatMap(([chipset, forms, mem]) => forms.map(form => {
  const [socket, fixed] = CHIPSETS[chipset];
  const memory = mem || fixed;
  const formQ = form === 'ATX' ? 'ATX' : form === 'mATX' ? 'Micro ATX' : 'Mini-ITX';
  return {
    category: 'mb', key: `${chipset} ${form}${mem ? ' ' + mem : ''}`, label: `${chipset} ${FORM_LABEL[form]}${mem ? '（' + mem + '）' : ''}`,
    chipset, form, socket, memory,
    queries: [`マザーボード ${chipset} ${formQ}${mem ? ' ' + mem : ''}`],
    floor: 6000,
    matches: p => p.chipset === chipset && p.form === form && p.memory === memory,
    parse: parseMb,
  };
}));

// サイトで並べる順番（規格の一覧の順）
[...PSU_SPECS, ...SSD_SPECS, ...MB_SPECS].forEach((spec, i) => { spec.order = i; });

module.exports = {PSU_SPECS, SSD_SPECS, MB_SPECS, parsePsu, parseSsd, parseMb, pickByMaker, makerOf, PSU_MAKERS, SSD_MAKERS, MB_MAKERS, normalizeTitle, COMMON_EXCLUDE, SSD_EXCLUDE, MB_EXCLUDE, CAPS};
