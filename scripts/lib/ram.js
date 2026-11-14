'use strict';

// メモリは型番が多すぎて製品ごとに追いかけられないので、「規格」（DDR世代・速度・1枚の容量・枚数）ごとに
// 最安の新品デスクトップ用キットを探す。規格は商品名から読み取り、少しでもあいまいな商品は使わない。

const RAM_SPECS = [
  ['DDR5', 6000, 16, 2], ['DDR5', 6000, 24, 2], ['DDR5', 6000, 32, 2], ['DDR5', 6400, 16, 2],
  ['DDR5', 5600, 8, 2], ['DDR5', 5600, 16, 2], ['DDR5', 5600, 32, 2], ['DDR5', 7200, 16, 2],
  ['DDR4', 3200, 8, 2], ['DDR4', 3200, 16, 2], ['DDR4', 3200, 32, 2], ['DDR4', 3600, 8, 2], ['DDR4', 3600, 16, 2],
].map(([type, speed, perStick, sticks]) => ({type, speed, perStick, sticks, capacity: perStick * sticks, label: ramLabel(type, speed, perStick, sticks)}));

function ramLabel(type, speed, perStick, sticks) {
  return `${type}-${speed} ${perStick * sticks}GB（${perStick}GB×${sticks}）`;
}

// デスクトップ用の普通のメモリ以外（ノート用・サーバー用・中古など）と、対応マザーボードが限られるものを除く
const EXCLUDE = /SO-?DIMM|ノート|laptop|notebook|ECC|RDIMM|Registered|レジスタード|サーバ|server|CUDIMM|CAMM|中古|リユース|並行輸入|平行輸入|海外版|アウトレット|訳あり|ジャンク|再生品|未使用品|開封|展示品|Mac\b|Apple|iMac|ゲーミングPC|デスクトップPC|パソコン本体|BTO|ヒートシンク単体|冷却ファン/i;

function speedsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/DDR([45])[\s-]?(\d{4})(?!\d)/gi)) out.add(`DDR${m[1]}-${m[2]}`);
  // PC5-48000 → DDR5-6000、PC4-25600 → DDR4-3200（モジュール規格の表記）
  for (const m of text.matchAll(/PC([45])-(\d{5})(?!\d)/gi)) out.add(`DDR${m[1]}-${Number(m[2]) / 8}`);
  return out;
}

function kitsIn(text) {
  const out = new Set();
  const t = text.replace(/[×xX＊*]/g, 'x').replace(/ＧＢ/g, 'GB');
  for (const m of t.matchAll(/(\d{1,2})\s*GB\s*x\s*(\d)(?!\d)/gi)) out.add(`${m[1]}x${m[2]}`);
  for (const m of t.matchAll(/(?<![\d.])(\d)\s*x\s*(\d{1,2})\s*GB/gi)) out.add(`${m[2]}x${m[1]}`);
  for (const m of t.matchAll(/(\d{1,2})\s*GB\s*[\s(（]*(\d)\s*枚/gi)) out.add(`${m[1]}x${m[2]}`);
  return out;
}

// 商品名を規格に読み替える。読み取れない・候補が複数あるときは null（推測しない）
function parseRamTitle(title) {
  if (typeof title !== 'string' || EXCLUDE.test(title)) return null;
  const speeds = speedsIn(title);
  const kits = kitsIn(title);
  if (speeds.size !== 1 || kits.size !== 1) return null;
  const [type, speed] = [...speeds][0].split('-');
  const [perStick, sticks] = [...kits][0].split('x').map(Number);
  const cl = title.match(/(?<![A-Z])C(?:L)?\s?(\d{2})(?!\d)/i);
  return {type, speed: Number(speed), perStick, sticks, cl: cl ? Number(cl[1]) : null};
}

function matchesSpec(spec, title) {
  const p = parseRamTitle(title);
  return Boolean(p && p.type === spec.type && p.speed === spec.speed && p.perStick === spec.perStick && p.sticks === spec.sticks);
}

function ramQueries(spec) {
  return [`${spec.type}-${spec.speed} ${spec.perStick}GB 2枚`, `${spec.type}-${spec.speed} ${spec.capacity}GB`];
}

// 安い順の検索結果から、規格がはっきり一致する在庫ありの新品を、ストアの重複なしで最大3件選ぶ
function pickRamOffers(spec, items) {
  const floor = spec.capacity * 80; // 付属品や誤登録の極端な安値を除く（1GBあたり80円未満は扱わない）
  const seenShops = new Set();
  const out = [];
  for (const item of [...items].sort((a, b) => a.itemPrice - b.itemPrice)) {
    if (!item || item.availability === 0 || !Number.isSafeInteger(item.itemPrice) || item.itemPrice < floor) continue;
    if (!matchesSpec(spec, item.itemName)) continue;
    const shop = item.shopName || item.itemCode;
    if (seenShops.has(shop)) continue;
    seenShops.add(shop);
    out.push({...item, cl: parseRamTitle(item.itemName).cl});
    if (out.length >= 3) break;
  }
  // 1店だけの出品は相場とかけ離れていても気づけないので、2店以上で売られている規格だけ載せる
  return out.length >= 2 ? out : [];
}

module.exports = {RAM_SPECS, ramLabel, parseRamTitle, matchesSpec, ramQueries, pickRamOffers};
