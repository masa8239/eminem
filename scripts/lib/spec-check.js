'use strict';

// シートの仕様（コア数・クロック・TDP・キャッシュ / VRAM・帯域幅・消費電力）を、
// data/spec-reference.json（AMD公式の仕様一覧と Wikipedia の各世代の表から作った照合表）と比べる。
// 食い違いを「要確認」として返すだけで、シートもサイトも書き換えない。

const fs = require('node:fs');
const path = require('node:path');

const REFERENCE_FILE = path.join(__dirname, '..', '..', 'data', 'spec-reference.json');

function loadReference(file = REFERENCE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function num(value) {
  const m = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function cpuKey(name) {
  return String(name).trim().replace(/\s+/g, ' ').replace(/^(AMD|Intel)\s+/i, '')
    .replace(/^Core (i[3579])[- ]/i, 'Core $1 ').replace(/ AF$/i, '').toUpperCase();
}

const GPU_ALIAS = {'NVIDIA TITAN X': 'TITAN X PASCAL', 'NVIDIA TITAN XP': 'TITAN XP', 'NVIDIA TITAN V': 'TITAN V', 'NVIDIA TITAN RTX': 'TITAN RTX'};

// 照合に使う候補（同じ名前で版が複数あるときは全部）。容量違いの名前は、その容量の版だけに絞る
function gpuCandidates(name, ref) {
  const up = String(name).trim().replace(/\s+/g, ' ').toUpperCase();
  const key = GPU_ALIAS[up] || up;
  const usable = list => (list || []).filter(e => !(e.bw !== null && e.bw < 10)); // 表の読み取りに失敗した行は使わない
  if (ref.gpu[key]) {
    const variants = Object.keys(ref.gpu).filter(k => k.startsWith(key + ' ') && / \d+ GB$/.test(k) && k.slice(key.length + 1).match(/^\d+ GB$/));
    return {list: usable([ref.gpu[key], ...variants.map(k => ref.gpu[k])].flat())};
  }
  let m = key.match(/^(.*?)\s+(\d+)\s*GB$/);
  if (m) {
    const gb = Number(m[2]);
    const list = usable(ref.gpu[`${m[1]} ${gb} GB`] || ref.gpu[m[1]]).filter(e => e.vram === gb);
    // 照合表にその容量の版がないときは、ほかの容量の値と比べない（誤った指摘になるため）
    return list.length ? {list} : {list: [], variantMissing: true};
  }
  m = key.match(/^(.*?)\s+GDDR\d$/);
  if (m) return {list: usable(ref.gpu[m[1]])};
  return {list: []};
}

const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

// rows: サイトのパーサーで読んだ行（category, sheetName, 仕様の数値）。返り値: [{category, modelName, type: 'spec', issue}]
function checkSpecs(rows, ref = loadReference()) {
  if (!ref || !ref.cpu || !ref.gpu) return [];
  const issues = [];
  for (const row of rows) {
    const problems = [];
    let unknown = false;
    if (row.category === 'cpu') {
      const r = ref.cpu[cpuKey(row.sheetName)];
      if (!r) unknown = true;
      else {
        for (const [label, sheet, source, unit] of [['コア数', row.cores, r.cores, ''], ['スレッド数', row.threads, r.threads, ''], ['TDP', row.tdp, r.tdp, 'W'],
          ['ベースクロック', row.clockMin, r.base, 'GHz'], ['最大クロック', row.clockMax, r.boost, 'GHz'], ['L3キャッシュ', row.cache, r.l3, 'MB']]) {
          if (source === null || source === undefined || !sheet) continue;
          if (!close(sheet, source, 0.051)) problems.push(`${label} ${sheet}${unit} → 出典 ${source}${unit}`);
        }
        if (problems.length) problems.push(`（${r.src}）`);
      }
    } else if (row.category === 'gpu') {
      const {list, variantMissing} = gpuCandidates(row.sheetName, ref);
      if (!list.length) unknown = !variantMissing;
      else {
        let bw = num(row.bw);
        if (bw !== null && /MB\/s/i.test(String(row.bw))) bw /= 1000;
        for (const [label, sheet, field, unit] of [['VRAM', num(row.vram), 'vram', 'GB'], ['帯域幅', bw, 'bw', 'GB/s'], ['消費電力', row.tdp || null, 'tdp', 'W']]) {
          const values = [...new Set(list.map(e => e[field]).filter(v => v !== null && v !== undefined))];
          if (!values.length || sheet === null || sheet === undefined) continue;
          if (!values.some(v => close(sheet, v, Math.max(1, v * 0.03)))) problems.push(`${label} ${sheet}${unit} → 出典 ${values.sort((a, b) => a - b).join(' / ')}${unit}`);
        }
        if (problems.length) problems.push(`（${list[0].src}）`);
      }
    } else continue;
    if (unknown) issues.push({category: row.category, modelName: row.sheetName, type: 'spec', issue: '仕様の照合表にない型番です。型番が正しいか確認してください'});
    else if (problems.length) issues.push({category: row.category, modelName: row.sheetName, type: 'spec', issue: '仕様が出典と違います: ' + problems.join('、').replace('、（', '（')});
  }
  return issues;
}

module.exports = {checkSpecs, loadReference, cpuKey, gpuCandidates};
