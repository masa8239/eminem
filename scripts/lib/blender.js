'use strict';

// Blender Benchmark（Blender Open Data）のスコアを取得する。
// Blender Open Data は誰でも使える公開データ（著作権などの制限なし）で、利用者が測定した結果の中央値を返す。
// https://opendata.blender.org/about/
//
// 方針
// - 版（Blender のバージョン）が違うスコアは比べられないので、CPU・GPUそれぞれ1つの版だけを使う。
//   シートの製品が一番多くそろう版を選ぶ（新しい版を優先）。
// - 測定数が少ない（MIN_SAMPLES 未満）結果は使わない。
// - GPU は計算方式（OptiX / CUDA / HIP / oneAPI）ごとに結果があるので、そのGPUで一番速い方式の値を使う（Blender 公式の比較と同じ考え方）。
// - ノート向け・内蔵グラフィックスは使わない。名前が型番として読み取れないものも使わない。

const BASE = 'https://opendata.blender.org/benchmarks/query/';
const GPU_TYPES = ['OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'];
const MIN_SAMPLES = 3;

// CPU名を「Ryzen 7 7800X3D」「Core i7-14700K」「Core Ultra 7 265K」の形にそろえる
function cpuModel(deviceName) {
  const s = String(deviceName).replace(/\((R|TM)\)/gi, ' ').replace(/\s+/g, ' ').toUpperCase();
  let m = s.match(/RYZEN ([3579]) (PRO )?(\d{4})(X3D|XT|X|GE|GT|G|F|E)?(?![A-Z0-9])/);
  if (m) return `Ryzen ${m[1]} ${m[2] ? 'PRO ' : ''}${m[3]}${m[4] || ''}`;
  m = s.match(/CORE ULTRA ([3579]) (\d{3})(KF|K|F|T)?(?![A-Z0-9])( PLUS)?/);
  if (m) return `Core Ultra ${m[1]} ${m[2]}${m[3] || ''}${m[4] ? ' Plus' : ''}`;
  m = s.match(/CORE I([3579])-(\d{4,5})(KS|KF|K|F|T|S)?(?![A-Z0-9])/);
  if (m) return `Core i${m[1]}-${m[2]}${m[3] || ''}`;
  return null;
}

// GPU名を比べやすい形にする（メーカー名・「Graphics」を外し、大文字に）
function gpuKey(name) {
  const s = String(name).replace(/\s+/g, ' ').trim().toUpperCase();
  if (/LAPTOP|MOBILE|MAX-Q|NOTEBOOK|(?<![A-Z])\d{3}M\b|VEGA \d+$|RADEON GRAPHICS|UHD|IRIS/.test(s)) return null;
  const k = s.replace(/^(NVIDIA|AMD|INTEL)\s+/, '').replace(/\s+GRAPHICS$/, '').replace(/^(NVIDIA|AMD|INTEL)\s+/, '').trim();
  return /^(GEFORCE|RADEON|ARC|TITAN)/.test(k) ? k : null;
}

function siteGpuKey(name) {
  return String(name).replace(/\s+/g, ' ').trim().toUpperCase().replace(/^NVIDIA\s+/, '').replace(/^GEFORCE GTX TITAN/, 'GEFORCE GTX TITAN');
}

async function fetchTable(params, fetchImpl) {
  const url = new URL(BASE);
  for (const [k, v] of params) url.searchParams.append(k, v);
  url.searchParams.set('response_type', 'datatables');
  const response = await fetchImpl(url, {headers: {Accept: 'application/json', 'User-Agent': 'BENCHCORE price and score updater'}, signal: AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error(`Blender Open Data HTTP ${response.status}`);
  const data = await response.json();
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) throw new Error('Blender Open Data: 想定外の応答');
  const col = name => data.columns.findIndex(c => c && c.display_name === name);
  const idx = {device: col('Device Name'), type: col('Compute Type'), score: col('Median Score'), count: col('Number of Benchmarks')};
  if (idx.device < 0 || idx.score < 0 || idx.count < 0) throw new Error('Blender Open Data: 列が見つかりません');
  return data.rows.map(r => ({device: r[idx.device], type: idx.type >= 0 ? r[idx.type] : 'CPU', score: Number(r[idx.score]), count: Number(r[idx.count])}))
    .filter(r => typeof r.device === 'string' && Number.isFinite(r.score) && r.score > 0 && Number.isFinite(r.count));
}

async function fetchVersions(fetchImpl) {
  const url = new URL(BASE + 'suggest/');
  url.searchParams.set('column', 'blender_version');
  url.searchParams.set('expression', '');
  const response = await fetchImpl(url, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`Blender Open Data HTTP ${response.status}`);
  const list = await response.json();
  return (Array.isArray(list) ? list : []).map(v => v && v.value).filter(v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v));
}

// rows（1つの版の結果）を、サイトの製品名ごとのスコアにする
function scoresFor(category, rows, siteNames) {
  const wanted = new Map(siteNames.map(name => [category === 'cpu' ? name.replace(/\s+/g, ' ').trim().toUpperCase() : siteGpuKey(name), name]));
  const best = new Map();
  for (const row of rows) {
    if (row.count < MIN_SAMPLES) continue;
    const key = category === 'cpu' ? (cpuModel(row.device) || '').toUpperCase() : gpuKey(row.device);
    const name = key && wanted.get(key);
    if (!name) continue;
    const prev = best.get(name);
    // 同じ製品が別の表記で入っていることがある。CPUは測定数の多い方、GPUは速い計算方式の方を使う
    const better = !prev || (category === 'cpu' ? row.count > prev.samples : row.score > prev.score);
    if (better) best.set(name, {score: Math.round(row.score * 100) / 100, samples: row.count, ...(category === 'gpu' ? {computeType: row.type} : {}), deviceName: row.device});
  }
  return Object.fromEntries([...best.entries()].sort((a, b) => b[1].score - a[1].score));
}

// 新しい版から順に見て、シートの製品が一番多くそろう版を選ぶ（同数なら新しい版）
async function fetchBlenderScores(siteNames, fetchImpl = fetch, options = {}) {
  const versions = options.versions || (await fetchVersions(fetchImpl)).slice(0, options.maxVersions || 6);
  const out = {};
  for (const category of ['cpu', 'gpu']) {
    const names = siteNames[category] || [];
    let chosen = null;
    for (const version of versions) {
      const params = category === 'cpu'
        ? [['compute_type', 'CPU'], ['blender_version', version], ['group_by', 'device_name']]
        : [...GPU_TYPES.map(t => ['compute_type', t]), ['blender_version', version], ['group_by', 'device_name'], ['group_by', 'compute_type']];
      let rows;
      try { rows = await fetchTable(params, fetchImpl); } catch { continue; }
      const scores = scoresFor(category, rows, names);
      if (!chosen || Object.keys(scores).length > Object.keys(chosen.scores).length) chosen = {version, scores};
    }
    if (chosen) out[category] = {blenderVersion: chosen.version, scores: chosen.scores};
  }
  return out;
}

module.exports = {fetchBlenderScores, scoresFor, cpuModel, gpuKey, MIN_SAMPLES};
