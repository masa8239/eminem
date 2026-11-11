'use strict';

// スプレッドシートのモデル名に、型番の規則と合わない点がないかを調べる。
// 「たぶん間違い」を指摘するだけで、自動で書き換えはしない。

const {normalize} = require('./match');

// Ryzen: 型番から本来の等級（3/5/7/9）を返す。判定できなければ null。
function ryzenTier(number, suffix) {
  const exceptions = {'5700X3D': 7, '5700X': 7, '5700G': 7, '5700': 7, '5500': 5, '5500GT': 5, '4500': 5, '8700G': 7, '8700F': 7, '8500G': 5, '8400F': 5, '8300G': 3};
  const key = number + suffix;
  if (exceptions[key] !== undefined) return exceptions[key];
  const hundreds = Number(number.slice(1));
  if (hundreds >= 900) return 9;
  if (hundreds >= 700) return 7;
  if (hundreds >= 400) return 5;
  if (hundreds >= 100) return 3;
  return null;
}

// Intel Core i: 型番から本来の等級を返す
function intelTier(number) {
  if (number === '10850') return 9;
  const hundreds = Number(number.slice(-3));
  if (hundreds >= 900) return 9;
  if (hundreds >= 700) return 7;
  if (hundreds >= 400) return 5;
  if (hundreds >= 100) return 3;
  return null;
}

// 規則上はあり得る形だが、実際には発売されていない型番
const NONEXISTENT_CPUS = new Set(['RYZEN 5 5500X', 'RYZEN 9 5500X', 'RYZEN 7 3800', 'RYZEN 5 3800', 'CORE I5-9500KF', 'CORE I9-9500KF', 'RYZEN 5 8600X3D', 'RYZEN 7 8600X3D', 'RYZEN 5 9500X', 'RYZEN 5 9500G', 'RYZEN 5 7500G', 'RYZEN 3 2100X', 'CORE I5-10550']);

function cpuIssue(name) {
  const text = normalize(name);
  if (NONEXISTENT_CPUS.has(text)) return '発売が確認できない型番です';
  if (text.startsWith('APPLE')) return null;
  let match = text.match(/^RYZEN (\d) (?:PRO )?(\d{4})([A-Z0-9]*)(?: AF)?$/);
  if (match) {
    const [, tier, number, suffix] = match;
    const generation = Number(number[0]);
    if (generation === 6) return 'デスクトップ向けに存在しない世代です';
    if (!/^(|X|XT|X3D|F|G|GE|GT)$/.test(suffix)) return `末尾「${suffix}」の型番は存在しません`;
    const expected = ryzenTier(number, suffix);
    if (expected === null || Number(number.slice(1)) % 50 !== 0) return '存在しない型番の可能性があります';
    if (expected !== Number(tier)) return `等級が違います（正しくは Ryzen ${expected} ${number}${suffix}）`;
    return null;
  }
  match = text.match(/^CORE I(\d)[- ](\d{4,5})([A-Z]{0,2})$/);
  if (match) {
    const [, tier, number, suffix] = match;
    const generation = Number(number.length === 5 ? number.slice(0, 2) : number[0]);
    if (generation < 2 || generation > 14 || (number.length === 4 && generation === 1)) return '存在しない世代の型番です';
    if (!/^(|K|KF|KS|F|T)$/.test(suffix)) return `末尾「${suffix}」の型番は存在しません`;
    const expected = intelTier(number);
    if (expected === null || Number(number.slice(-2)) % 50 !== 0) return '存在しない型番の可能性があります';
    if (expected !== Number(tier)) return `等級が違います（正しくは Core i${expected}-${number}${suffix}）`;
    return null;
  }
  match = text.match(/^CORE ULTRA (\d) (\d{3})([A-Z]{0,2})$/);
  if (match) {
    const [, tier, number] = match;
    const expected = number[1] === '8' ? 9 : number[1] === '6' ? 7 : number[1] === '4' || number[1] === '3' || number[1] === '2' ? 5 : null;
    if (expected === null) return '存在しない型番の可能性があります';
    if (expected !== Number(tier)) return `等級が違います（正しくは Core Ultra ${expected} ${match[2]}${match[3]}）`;
    return null;
  }
  return '型番の形式を判定できません';
}

function gpuIssue(name) {
  const text = normalize(name);
  if (text.startsWith('ARC ')) return /^ARC [AB]\d{3}( \d+GB)?$/.test(text) ? null : 'Arc の型番として存在しません';
  if (/^(NVIDIA TITAN|GEFORCE GTX TITAN|RADEON R9 |RADEON \d{3}M|INTEL |RADEON GRAPHICS|GEFORCE GT )/.test(text)) return null;
  if (/VEGA/.test(text)) return text.startsWith('GEFORCE') ? 'Vega は Radeon の製品です（GeForce ではありません）' : null;
  const match = text.match(/^(GEFORCE|RADEON) (RTX|GTX|RX|RT) (\d{3,4})\b/);
  if (!match) return '型番の形式を判定できません';
  const [, brand, family, number] = match;
  if (family === 'RT') return '「RT」という系列は存在しません';
  if (brand === 'GEFORCE' && family === 'RX') return 'RX は Radeon の系列です';
  if (brand === 'RADEON' && family !== 'RX') return `${family} は GeForce の系列です`;
  const series = number.length === 4 ? Number(number.slice(0, 2)) : Number(number[0]);
  if (family === 'RTX') {
    if (number.length !== 4 || ![20, 30, 40, 50].includes(series)) return `RTX ${number} は存在しません（Radeon RX や GTX の型番の可能性）`;
    if (!['50', '60', '70', '80', '90'].includes(number.slice(2))) return `RTX ${number} は存在しません`;
  }
  if (family === 'GTX') {
    if (number.length === 4 && ![10, 16].includes(series)) return `GTX ${number} は存在しません（RTX の型番の可能性）`;
  }
  if (family === 'RX') {
    const known = ['460', '470', '480', '550', '560', '570', '580', '590', '5500', '5600', '5700', '6400', '6500', '6600', '6650', '6700', '6750', '6800', '6900', '6950', '7600', '7700', '7800', '7900', '9060', '9070'];
    if (!known.includes(number)) return `RX ${number} は存在しません`;
  }
  if (/\(.*GPU\)/.test(text)) return 'モデル名に不要な文字が入っています';
  if (/RTX 3060 SUPER/.test(text)) return 'RTX 3060 SUPER は存在しません';
  return null;
}

function nameIssue(category, name) {
  return category === 'cpu' ? cpuIssue(name) : category === 'gpu' ? gpuIssue(name) : null;
}

module.exports = {nameIssue, cpuIssue, gpuIssue};
