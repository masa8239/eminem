'use strict';

// 予算ごとのゲーミングPC構成を、毎日の最安値から機械的に組む。
// 決まりごと（ページにも書く）:
//   ・CPU と GPU は、スコアと今の価格がある製品だけ。予算内で GPU のスコアがいちばん高くなる組み合わせ。
//     CPU は、サイトのボトルネック診断で CPU が弱すぎも強すぎもしないもののうち、予算内でスコアがいちばん高いもの
//   ・マザーボードは CPU のソケットに合う B 以上のチップセット（A520/A620/H610/H810 は使わない）。AM4 は Ryzen 5000 シリーズだけ
//   ・メモリは DDR4/DDR5 をマザーボードに合わせ、予算15万円以下は16GB、それより上は32GB
//   ・SSD は NVMe Gen4（予算30万円以上は2TB、それ未満は1TB）
//   ・電源は (CPU と GPU の消費電力の合計 × 1.3 + 100W) 以上。予算25万円以上は 80PLUS Gold 以上
//   ・CPUクーラーは CPU の TDP が 105W 以下なら DeepCool AK400、それより上は DeepCool AK620
//   ・ケースはビルダーに載せているケースのうち最安
//   ・メーカーを判定できない出品（「その他」）は使わない

const BUDGETS = [120000, 150000, 200000, 250000, 300000, 400000, 500000];
// サイトのボトルネック診断（index.html の calcBottleneck）と同じ計算
const CPU_GAME_CAP = 40000;
const GPU_GAME_CAP = 38000;
function balance(cpu, gpu, maxCpu, maxGpu) {
  const c = Math.min(cpu.score, CPU_GAME_CAP) / Math.min(maxCpu, CPU_GAME_CAP) * 100;
  const g = Math.min(gpu.score, GPU_GAME_CAP) / Math.min(maxGpu, GPU_GAME_CAP) * 100;
  const pct = (1 - Math.min(c, g) / Math.max(c, g)) * 100;
  return {pct, cpuWeaker: c < g};
}
// 診断で「良好」か「CPUに余裕」: CPU が弱い側なら差 15% 未満、GPU が弱い側なら差 60% 未満（「CPUが過剰」は使わない）
const balanced = b => (b.cpuWeaker ? b.pct < 15 : b.pct < 60);
const LOW_CHIPSETS = new Set(['A520', 'A620', 'H610', 'H810']);

function cheapest(list, test) {
  let best = null;
  for (const x of list) if (test(x) && (!best || x.price < best.price)) best = x;
  return best;
}

// 価格ファイルから、構成に使うパーツの候補を取り出す
function partsFromPrices(products, now, maxAgeMs) {
  const fresh = (products || []).filter(p => p && p.status === 'ok' && Number.isSafeInteger(p.price) && p.price > 0 && p.spec && now - new Date(p.fetchedAt) < maxAgeMs);
  const byCat = c => fresh.filter(p => p.category === c);
  return {
    mb: byCat('mb').filter(p => p.spec.maker && p.spec.maker !== 'その他' && !LOW_CHIPSETS.has(p.spec.chipset) && p.spec.form !== 'ITX'),
    ram: byCat('ram'),
    ssd: byCat('ssd').filter(p => p.spec.maker && p.spec.maker !== 'その他' && p.spec.type === 'Gen4'),
    psu: byCat('psu').filter(p => p.spec.maker && p.spec.maker !== 'その他'),
    cooler: byCat('cooler'),
    case: byCat('case'),
  };
}

function cpuAllowed(cpu) {
  if (!cpu.socket) return false;
  if (cpu.socket === 'AM4') return /Ryzen \d 5\d{3}/.test(cpu.name); // AM4 は B550 で確実に動く Ryzen 5000 シリーズだけ
  return ['AM5', 'LGA1700', 'LGA1851'].includes(cpu.socket);
}

// CPU と GPU を決めたときの、残りのパーツ（いちばん安い組み合わせ）
function restFor(cpu, gpu, budget, parts) {
  const ramGb = budget <= 150000 ? 16 : 32;
  const ssdCap = budget >= 300000 ? 2000 : 1000;
  let best = null;
  for (const memory of ['DDR4', 'DDR5']) {
    const mb = cheapest(parts.mb, p => p.spec.socket === cpu.socket && p.spec.memory === memory);
    const ram = cheapest(parts.ram, p => p.spec.type === memory && p.spec.capacity === ramGb);
    if (!mb || !ram) continue;
    if (!best || mb.price + ram.price < best.mb.price + best.ram.price) best = {mb, ram};
  }
  if (!best) return null;
  const ssd = cheapest(parts.ssd, p => p.spec.capacity === ssdCap);
  const need = (Number(cpu.tdp) || 0) * 1 + (Number(gpu.tdp) || 0);
  const watts = need * 1.3 + 100;
  const goldOnly = budget >= 250000;
  const psu = cheapest(parts.psu, p => p.spec.watts >= watts && (!goldOnly || ['Gold', 'Platinum', 'Titanium'].includes(p.spec.rating)));
  const coolerId = (Number(cpu.tdp) || 0) <= 105 ? 'bco5' : 'bco2';
  const cooler = parts.cooler.find(p => p.spec.id === coolerId) || null;
  const pcCase = cheapest(parts.case, () => true);
  if (!ssd || !psu || !cooler || !pcCase) return null;
  return {...best, ssd, psu, cooler, case: pcCase, psuNeed: Math.ceil(watts / 50) * 50};
}

function buildFor(budget, cpus, gpus, parts) {
  const cpuList = cpus.filter(c => c.score > 0 && c.offer && cpuAllowed(c));
  const gpuList = gpus.filter(g => g.score > 0 && g.offer);
  if (!cpuList.length || !gpuList.length) return null;
  // 診断と同じく、価格のない製品も含めた全製品の最高スコアを基準にする
  const maxCpu = Math.max(...cpus.filter(c => c.score > 0).map(c => c.score));
  const maxGpu = Math.max(...gpus.filter(g => g.score > 0).map(g => g.score));
  let best = null;
  for (const cpu of cpuList) {
    for (const gpu of gpuList) {
      if (cpu.offer.price + gpu.offer.price >= budget) continue;
      const bal = balance(cpu, gpu, maxCpu, maxGpu);
      if (!balanced(bal)) continue;
      const rest = restFor(cpu, gpu, budget, parts);
      if (!rest) continue;
      const total = cpu.offer.price + gpu.offer.price + rest.mb.price + rest.ram.price + rest.ssd.price + rest.psu.price + rest.cooler.price + rest.case.price;
      if (total > budget) continue;
      const better = !best || gpu.score > best.gpu.score
        || (gpu.score === best.gpu.score && (cpu.score > best.cpu.score || (cpu.score === best.cpu.score && total < best.total)));
      if (better) best = {budget, cpu, gpu, ...rest, total, balance: bal};
    }
  }
  return best;
}

// 予算を上げても同じ構成になるときは、低い方の予算だけ残す（同じ中身のページを作らない）
function buildAll(cpus, gpus, parts) {
  const out = [];
  for (const b of BUDGETS) {
    const build = buildFor(b, cpus, gpus, parts);
    if (!build) continue;
    const prev = out[out.length - 1];
    if (prev && prev.cpu === build.cpu && prev.gpu === build.gpu && prev.total === build.total) continue;
    out.push(build);
  }
  return out;
}

module.exports = {balance, balanced, BUDGETS, partsFromPrices, buildFor, buildAll, restFor, cpuAllowed, LOW_CHIPSETS};
