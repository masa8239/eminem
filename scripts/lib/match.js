'use strict';

// 楽天市場の検索結果から、BENCHCORE のモデル名と同じ「新品・単品」の商品だけを選ぶための判定。
// 迷ったら採用しない（価格を出さない）方に倒す。

function normalize(text) {
  return String(text || '').normalize('NFKC').toUpperCase().replace(/[\s　]+/g, ' ').trim();
}

// 中古・PC本体・付属品など、対象モデルそのものではない出品を示す語
const EXCLUDE_WORDS = [
  '中古', '再生', '整備済', 'リファービッシュ', 'ジャンク', '訳あり', 'わけあり', '展示品', '開封済', '箱のみ', '空箱',
  // 「搭載」は単品グラボの商品名（〜搭載グラフィックボード）にも普通に使われるため除外語にしない
  'パソコン', 'デスクトップ', 'ノート', 'ゲーミングPC', 'BTO', 'WINDOWS', 'OFFICE', 'SSD', 'セット', '同梱', '同時購入', 'バンドル',
  'ウォーターブロック', '水冷ブロック', 'バックプレート', 'ケーブル', 'ライザー', 'ステー', 'ホルダー', 'ブラケット',
  'フィルム', 'レンタル', '延長保証', '修理', '買取', 'ふるさと納税', '抽選', 'マザーボード',
  // 互換品・交換部品・並行輸入・中古扱いの「未使用品」
  '互換', '交換用', '並行輸入', '平行輸入', '未使用', 'バッテリー', '電池', 'オートバイ', 'ネジ', '冷却ファン',
  // 箱つぶれ品・バルク品は通常の新品（BOX）と条件が違うので比較に入れない
  '箱難', '箱潰', '箱つぶれ', '外箱', 'バルク',
].map(normalize);

const GPU_SUFFIXES = ['TI SUPER', 'SUPER', 'TI', 'XTX', 'XT', 'GRE'];

function parseGpu(name) {
  const text = normalize(name);
  const match = text.match(/\b(RTX|GTX|RX)\s*(\d{4})\s*(TI\s*SUPER|SUPER|TI|XTX|XT|GRE)?(?![A-Z0-9])(?:\s*(\d{1,2})\s*GB)?/);
  if (!match) return null;
  return {
    family: match[1],
    number: match[2],
    suffix: (match[3] || '').replace(/\s+/g, ' ').replace('TISUPER', 'TI SUPER'),
    vram: match[4] ? Number(match[4]) : null,
  };
}

function parseCpu(name) {
  const text = normalize(name);
  if (text.includes('RYZEN')) {
    const match = text.match(/\b(\d{4}[A-Z0-9]*)\s*$/) || text.match(/\b(\d{4}(?:X3D|XT|X|F|G|GE)?)\b/);
    return match ? {brand: 'RYZEN', token: match[1]} : null;
  }
  if (text.includes('ULTRA')) {
    // 「Core Ultra 7 270K Plus」のように末尾に Plus が付く型番がある
    const match = text.match(/\b(\d{3}[A-Z]{0,2})(\s*PLUS)?\s*$/);
    return match ? {brand: 'ULTRA', token: match[1], plus: Boolean(match[2])} : null;
  }
  const match = text.match(/\bI[3579][\s-]*(\d{4,5}[A-Z]{0,2})\b/);
  return match ? {brand: 'CORE', token: match[1]} : null;
}

// モデルごとの検索語と、商品名の合否判定を返す。判定できないモデルは null。
function modelSpec(category, modelName, siblingNames = []) {
  if (category === 'gpu') {
    const gpu = parseGpu(modelName);
    if (!gpu) return null;
    const siblingVrams = siblingNames.map(parseGpu)
      .filter(other => other && other.family === gpu.family && other.number === gpu.number && other.suffix === gpu.suffix && other.vram && other.vram !== gpu.vram)
      .map(other => other.vram);
    const pattern = new RegExp(`(?<![A-Z0-9])${gpu.family}\\s*${gpu.number}(?![0-9])\\s*-?\\s*(TI\\s*SUPER|SUPER|TI|XTX|XT|GRE)?(?![A-Z])`, 'g');
    return {
      keyword: [gpu.family, gpu.number, gpu.suffix].filter(Boolean).join(' '),
      matches(itemName) {
        const text = normalize(itemName);
        const found = [...text.matchAll(pattern)];
        if (!found.length) return false;
        // 商品名に出てくる型番表記がすべて同じグレードであること（"5070 Ti" を "5070" として採用しない）
        if (!found.every(m => (m[1] || '').replace(/\s+/g, ' ').replace('TISUPER', 'TI SUPER') === gpu.suffix)) return false;
        const vramIn = size => new RegExp(`(?<![0-9])${size}\\s*G(B)?(?![A-Z])`).test(text);
        if (gpu.vram && !vramIn(gpu.vram)) return false;
        if (siblingVrams.some(vramIn)) return false;
        // 別の型番がいくつも並んでいる出品は、互換部品や対応機種の一覧
        const numbers = new Set([...text.matchAll(/(?<![A-Z0-9])(?:RTX|GTX|RX)\s*(\d{4})(?![0-9])/g)].map(m => m[1]));
        if (numbers.size > 1) return false;
        // CPU名が入っている出品はグラボ単品ではなくPC本体
        if (/RYZEN|CORE\s*I[3579]|CORE\s*ULTRA/.test(text)) return false;
        return true;
      },
    };
  }
  if (category === 'cpu') {
    const cpu = parseCpu(modelName);
    if (!cpu) return null;
    const pattern = cpu.plus ? new RegExp(`(?<![A-Z0-9])${cpu.token}\\s*PLUS(?![A-Z0-9])`)
      : new RegExp(`(?<![A-Z0-9])${cpu.token}(?![A-Z0-9])(?!\\s*PLUS)`);
    const brandOk = text => cpu.brand === 'RYZEN' ? text.includes('RYZEN')
      : cpu.brand === 'ULTRA' ? text.includes('ULTRA')
      : /CORE|INTEL|インテル/.test(text);
    return {
      keyword: cpu.brand === 'RYZEN' ? `Ryzen ${cpu.token}` : cpu.brand === 'ULTRA' ? `Core Ultra ${cpu.token}${cpu.plus ? ' Plus' : ''}` : `Core ${cpu.token}`,
      matches(itemName) {
        const text = normalize(itemName);
        // グラボ名やメモリ規格が入っている出品はCPU単品ではない
        return pattern.test(text) && brandOk(text) && !/DDR[45]|メモリ|RTX|GTX|RADEON RX/.test(text);
      },
    };
  }
  return null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// items: 楽天APIの商品配列。referencePrice: サイト上の参考価格（なければ null）。
// 戻り値: {item} か {reason}
// 本体として明らかに安すぎる価格（部品やアクセサリー）
const PRICE_FLOOR = {cpu: 8000, gpu: 15000};

function pickItem(spec, items, referencePrice, category) {
  const candidates = items.filter(item => item && typeof item.itemName === 'string'
    && Number.isSafeInteger(item.itemPrice) && item.itemPrice > 0 && item.availability === 1
    && typeof item.itemCode === 'string'
    && spec.matches(item.itemName)
    && !EXCLUDE_WORDS.some(word => normalize(item.itemName).includes(word)));
  if (!candidates.length) return {reason: '一致する新品単品の出品なし'};

  const prices = candidates.map(item => item.itemPrice);
  const mid = median(prices);
  let inBand;
  const floor = PRICE_FLOOR[category] || 0;
  if (Number.isSafeInteger(referencePrice) && referencePrice > 0) {
    // 参考価格から大きく外れる出品（付属品・抱き合わせ・転売・相場より極端に安い怪しい出品）は採用しない
    inBand = item => item.itemPrice >= Math.max(floor, referencePrice * 0.7) && item.itemPrice <= referencePrice * 1.8
      && (candidates.length < 3 || item.itemPrice >= mid * 0.8);
  } else {
    // 参考価格がないモデルは、同条件の出品が3件以上あるときだけ相場（中央値）付近を採用
    if (candidates.length < 5) return {reason: '参考価格なし・候補5件未満'};
    inBand = item => item.itemPrice >= Math.max(floor, mid * 0.75) && item.itemPrice <= mid * 1.5;
  }
  const accepted = candidates.filter(inBand).sort((a, b) => a.itemPrice - b.itemPrice);
  if (!accepted.length) return {reason: '価格が相場から外れている'};
  return {item: accepted[0]};
}

module.exports = {normalize, parseGpu, parseCpu, modelSpec, pickItem, median, EXCLUDE_WORDS, PRICE_FLOOR};

// ---- 新着候補の発見 ----
// 検索結果の商品名から型番を読み取り、まだサイトに載っていないモデルを候補として挙げる。
const SUFFIX_LABEL = {'TI': 'Ti', 'TI SUPER': 'Ti SUPER', 'SUPER': 'SUPER', 'XT': 'XT', 'XTX': 'XTX', 'GRE': 'GRE', '': ''};
function canonicalGpu(gpu) {
  const brand = gpu.family === 'RX' ? 'Radeon' : 'GeForce';
  return `${brand} ${gpu.family} ${gpu.number}${gpu.suffix ? ' ' + SUFFIX_LABEL[gpu.suffix] : ''}`;
}
function modelFromItemName(itemName) {
  const text = normalize(itemName);
  if (EXCLUDE_WORDS.some(word => text.includes(word)) || /QUADRO|ワークステーション|MOBILE|モバイル/.test(text)) return null;
  const hasCpu = /RYZEN|CORE\s*I[3579]|CORE\s*ULTRA/.test(text), hasGpu = /(?<![A-Z])(RTX|GTX|RX)\s*\d{4}/.test(text);
  if (hasCpu && hasGpu) return null; // PC本体
  if (hasGpu) {
    const gpu = parseGpu(text);
    if (!gpu || gpu.family === 'GTX' || !['50', '60', '70', '80', '90'].includes(gpu.number.slice(2))) return null;
    return {category: 'gpu', modelName: canonicalGpu(gpu)};
  }
  if (/DDR[45]|メモリ/.test(text)) return null;
  let m = text.match(/RYZEN\s*([3579])\s*(\d{4})(X3D|XT|X|F|GT|GE|G)?(?![A-Z0-9])/);
  if (m) return {category: 'cpu', modelName: `Ryzen ${m[1]} ${m[2]}${m[3] || ''}`};
  m = text.match(/CORE\s*ULTRA\s*([3579])\s*(?:プロセッサー\s*)?(\d{3})(KF|K|F|T)?(?![A-Z0-9])(\s*PLUS(?![A-Z0-9]))?/);
  if (m) return {category: 'cpu', modelName: `Core Ultra ${m[1]} ${m[2]}${m[3] || ''}${m[4] ? ' Plus' : ''}`};
  m = text.match(/CORE\s*I([3579])[\s-]*(\d{5})(KF|KS|K|F|T)?(?![A-Z0-9])/);
  if (m) return {category: 'cpu', modelName: `Core i${m[1]}-${m[2]}${m[3] || ''}`};
  return null;
}
// items: 各ストアの商品。known: [{category, modelName}]。3件以上の出品で見つかった未登録モデルだけ返す。
function discoverNewModels(items, known, minSightings = 3) {
  const knownKeys = new Set(known.map(model => {
    const gpu = model.category === 'gpu' && parseGpu(model.modelName);
    return model.category + '\0' + normalize(gpu ? canonicalGpu(gpu) : model.modelName);
  }));
  const found = new Map();
  for (const item of items) {
    if (!item || typeof item.itemName !== 'string' || !Number.isSafeInteger(item.itemPrice) || item.itemPrice <= 0 || item.availability !== 1) continue;
    const model = modelFromItemName(item.itemName);
    if (!model) continue;
    const key = model.category + '\0' + normalize(model.modelName);
    if (knownKeys.has(key)) continue;
    if (!found.has(key)) found.set(key, {...model, codes: new Set(), prices: [], example: item.itemName});
    const entry = found.get(key);
    if (!entry.codes.has(item.itemCode)) { entry.codes.add(item.itemCode); entry.prices.push(item.itemPrice); }
  }
  return [...found.values()].filter(entry => entry.codes.size >= minSightings)
    .map(entry => ({category: entry.category, modelName: entry.modelName, listings: entry.codes.size, medianPrice: Math.round(median(entry.prices)), example: entry.example}))
    .sort((a, b) => b.listings - a.listings);
}
module.exports.modelFromItemName = modelFromItemName;
module.exports.discoverNewModels = discoverNewModels;
