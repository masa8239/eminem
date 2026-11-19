'use strict';

// ビルダーに載せている CPUクーラー・ケース（決まった製品）の最安値を探す。
// 商品名に型番の文字がすべて含まれ、別モデル・付属品・中古の表記がない在庫ありの新品だけを使う。
// 1店だけの出品は相場とかけ離れていても気づけないので、2店以上で売られている製品だけ価格を出す。

const {normalizeTitle, COMMON_EXCLUDE} = require('./parts');

// 製品そのものではない出品（交換用ファン・取付金具・パネルなど）
const ACCESSORY = /ファン単体|ファンのみ|交換用|取付金具|取り付けキット|マウンティングキット|マウントキット|ブラケット|リテンション|変換キット|AM5キット|LGA\d{4}キット|グリス単体|サーマルペースト単体|パネル単体|サイドパネル|フロントパネル|ガラスパネル|ライザー|垂直マウント|縦置きキット|ディスプレイキット|LCDキット|スタンド単体|ダストフィルター|防塵フィルター|オプションパーツ|専用パーツ|補修/i;

const DEEPCOOL = /DEEP\s*COOL|ディープクール/i;
const THERMALRIGHT = /THERMALRIGHT|サーマルライト/i;
const BEQUIET = /BE\s*QUIET|ビークワイエット/i;
const LIANLI = /LIAN\s*LI|リアンリー/i;
const ARCTIC = /ARCTIC|アークティック/i;

// maxTdp: メーカーが公表している冷却能力（W）。公表していない製品は null（推測で数字を入れない）
const FIXED_PARTS = [
  {category: 'cooler', id: 'bco1', name: 'Noctua NH-D15 G2', query: 'Noctua NH-D15 G2', must: [/NOCTUA|ノクチュア/i, /NH-?D15\s*G2/i], not: /NH-?D15S(?![A-Z])/i, floor: 10000, maxTdp: null},
  {category: 'cooler', id: 'bco2', name: 'DeepCool AK620', query: 'DeepCool AK620', must: [DEEPCOOL, /AK620(?![0-9A-Z])/i], not: /DIGITAL|デジタル/i, floor: 3000, maxTdp: 260},
  {category: 'cooler', id: 'bco3', name: 'Thermalright Peerless Assassin 120 SE', query: 'Thermalright Peerless Assassin 120 SE', must: [THERMALRIGHT, /PEERLESS\s*ASSASSIN\s*120\s*SE|PA\s*120\s*SE/i], not: /DIGITAL|デジタル|MINI|(?<![A-Z])V[23](?![0-9])/i, floor: 2500, maxTdp: null},
  {category: 'cooler', id: 'bco5', name: 'DeepCool AK400', query: 'DeepCool AK400', must: [DEEPCOOL, /AK400(?![0-9A-Z])/i], not: /DIGITAL|デジタル/i, floor: 2000, maxTdp: 220},
  {category: 'cooler', id: 'bco6', name: 'CORSAIR iCUE LINK TITAN 360 RX', query: 'CORSAIR TITAN 360 RX', must: [/CORSAIR|コルセア/i, /TITAN\s*360\s*RX/i], not: /LCD/i, floor: 15000, maxTdp: null},
  {category: 'cooler', id: 'bco7', name: 'ARCTIC Liquid Freezer III Pro 360', query: 'ARCTIC Liquid Freezer III Pro 360', must: [ARCTIC, /LIQUID\s*FREEZER\s*(III|3)\s*PRO\s*360/i], not: /240|280|420/, floor: 8000, maxTdp: null},
  {category: 'cooler', id: 'bco8', name: 'ARCTIC Liquid Freezer III Pro 240', query: 'ARCTIC Liquid Freezer III Pro 240', must: [ARCTIC, /LIQUID\s*FREEZER\s*(III|3)\s*PRO\s*240/i], not: /280|360|420/, floor: 6000, maxTdp: null},
  {category: 'cooler', id: 'bco9', name: 'Thermalright Aqua Elite 240', query: 'Thermalright Aqua Elite 240', must: [THERMALRIGHT, /AQUA\s*ELITE\s*240/i], not: /360|280/, floor: 4000, maxTdp: null},
  {category: 'case', id: 'bk1', name: 'Fractal Design Torrent', query: 'Fractal Design Torrent', must: [/FRACTAL|フラクタル/i, /TORRENT|トレント/i], not: /COMPACT|コンパクト|NANO|ナノ/i, floor: 15000},
  {category: 'case', id: 'bk2', name: 'Fractal Design North', query: 'Fractal Design North', must: [/FRACTAL|フラクタル/i, /NORTH|ノース/i], not: /(?<![A-Z])XL(?![A-Z])/i, floor: 15000},
  {category: 'case', id: 'bk3', name: 'NZXT H7 Flow', query: 'NZXT H7 Flow', must: [/NZXT/i, /H7\s*FLOW/i], not: /RGB|ELITE/i, floor: 10000},
  {category: 'case', id: 'bk4', name: 'Cooler Master HAF 500', query: 'Cooler Master HAF 500', must: [/COOLER\s*MASTER|クーラーマスター/i, /HAF\s*500(?![0-9])/i], not: /HAF\s*500\s*\d/i, floor: 10000},
  {category: 'case', id: 'bk5', name: 'NZXT H5 Flow', query: 'NZXT H5 Flow', must: [/NZXT/i, /H5\s*FLOW/i], not: /RGB|ELITE/i, floor: 8000},
];

// 入れ替え候補（サイトには出さない）。毎日の取得で2店以上で売られているかを確かめてから FIXED_PARTS に移す
const CANDIDATE_PARTS = [];

function listingMatches(part, itemName) {
  const t = normalizeTitle(itemName);
  if (COMMON_EXCLUDE.test(t) || ACCESSORY.test(t)) return false;
  if (part.not && part.not.test(t)) return false;
  return part.must.every(re => re.test(t));
}

// 安い順に見て、一致する在庫ありの新品の最安1件と、売っている店の数を返す（2店未満なら null）
function pickFixedPart(part, items) {
  let best = null;
  const shops = new Set();
  for (const item of [...items].sort((a, b) => a.itemPrice - b.itemPrice)) {
    if (!item || item.availability === 0 || !Number.isSafeInteger(item.itemPrice) || item.itemPrice < part.floor) continue;
    if (!listingMatches(part, item.itemName)) continue;
    shops.add(item.shopName || item.itemCode);
    if (!best) best = item;
  }
  return best && shops.size >= 2 ? {item: best, shops: shops.size} : null;
}

module.exports = {FIXED_PARTS, CANDIDATE_PARTS, listingMatches, pickFixedPart, ACCESSORY};
