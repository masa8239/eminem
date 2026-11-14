'use strict';

// 運営者がスプレッドシートで管理する「おすすめ製品」（マザーボード・SSD）。
//   タブ「マザーボード」「SSD」: 1行 = 1製品。「製品名」は必須、そのほかの列は自由（サイトにそのまま表示）
//   価格は毎朝その製品名で検索し、製品名の文字がすべて含まれ、チップセット・サイズ・容量・接続が食い違わない出品だけを使う。

const {parseCsv} = require('./corrections');
const {normalizeTitle, COMMON_EXCLUDE, SSD_EXCLUDE, MB_EXCLUDE, CAPS} = require('./parts');

const TABS = {mb: 'マザーボード', ssd: 'SSD'};
const HIDDEN = /^(最安値\(円\)|最安値|メモ|備考)$/;

const compact = s => normalizeTitle(s).toUpperCase().replace(/[\s_\-‐－・/()（）]+/g, '');

function toProducts(text, kind) {
  const rows = parseCsv(text || '');
  if (rows.length < 1) return [];
  const header = rows[0].map(h => h.trim());
  const nameAt = header.indexOf('製品名');
  if (nameAt < 0) return [];
  const out = [];
  const seen = new Set();
  for (const r of rows.slice(1)) {
    const name = String(r[nameAt] || '').trim().replace(/\s+/g, ' ');
    if (name.length < 4 || seen.has(compact(name))) continue;
    seen.add(compact(name));
    const fields = {};
    header.forEach((h, i) => {
      if (i === nameAt || !h || HIDDEN.test(h)) return;
      const v = String(r[i] ?? '').trim();
      if (v) fields[h] = v.slice(0, 80);
    });
    out.push({kind, name: name.slice(0, 80), maker: fields['メーカー'] || '', fields});
  }
  return out.slice(0, 300);
}

async function loadSheetParts(spreadsheetId, fetchImpl = fetch) {
  const result = {ok: false, mb: [], ssd: []};
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) return result;
  for (const [kind, tab] of Object.entries(TABS)) {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`;
      const response = await fetchImpl(url, {signal: AbortSignal.timeout(20000)});
      const text = await response.text();
      if (!response.ok || !/製品名/.test(text.split('\n')[0] || '')) continue;
      result[kind] = toProducts(text, kind);
      result.ok = true;
    } catch { /* このタブは使わない */ }
  }
  return result;
}

// 出品がこの製品のものか。製品名の文字（メーカー名は除く）がすべて含まれ、仕様の列と食い違わないこと
function listingMatches(product, itemName) {
  const t = normalizeTitle(itemName);
  if (COMMON_EXCLUDE.test(t) || (product.kind === 'mb' ? MB_EXCLUDE : SSD_EXCLUDE).test(t)) return false;
  const title = compact(t);
  const makerWords = new Set(String(product.maker || '').toUpperCase().split(/\s+/).filter(Boolean));
  const tokens = normalizeTitle(product.name).toUpperCase().split(/\s+/).filter(w => w && !makerWords.has(w)).map(compact).filter(Boolean);
  if (!tokens.length || !tokens.every(w => title.includes(w))) return false;
  const f = product.fields;
  if (product.kind === 'mb') {
    if (!/マザーボード|MOTHERBOARD|マザボ/i.test(t)) return false;
    const chipset = String(f['チップセット'] || '').toUpperCase().trim();
    if (chipset && !title.includes(compact(chipset))) return false;
    const size = String(f['サイズ'] || '').toUpperCase();
    const isM = /MICRO|MATX|M-ATX/.test(size), isI = /ITX/.test(size);
    if (size && isM && /MINI[\s-]?ITX|E[\s-]?ATX/i.test(t)) return false;
    if (size && isI && /MICRO[\s-]?ATX|M[\s-]ATX|E[\s-]?ATX/i.test(t)) return false;
    if (size && !isM && !isI && /MICRO[\s-]?ATX|M[\s-]ATX|MINI[\s-]?ITX/i.test(t)) return false;
  } else {
    if (!/SSD/i.test(t)) return false;
    const want = String(f['容量'] || '').toUpperCase().match(/(\d+(?:\.\d+)?)\s*(TB|GB)/);
    const sizes = new Set();
    for (const m of t.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(TB|GB)(?![A-Za-z\/])/gi)) {
      const gb = Number(m[1]) * (/TB/i.test(m[2]) ? 1000 : 1);
      if (gb >= 100) sizes.add(Math.round(gb / 10) * 10);
    }
    if (sizes.size > 1) return false; // 容量を選ぶ商品は使わない
    if (want) {
      const gb = Number(want[1]) * (want[2] === 'TB' ? 1000 : 1);
      const cap = CAPS.find(([, lo, hi]) => gb >= lo && gb <= hi);
      const got = [...sizes][0];
      if (got === undefined) return false;
      const gotCap = CAPS.find(([, lo, hi]) => got >= lo && got <= hi);
      if (cap ? !(gotCap && gotCap[0] === cap[0]) : Math.abs(got - gb) > gb * 0.05) return false;
    }
    const conn = String(f['接続'] || '').toUpperCase();
    if (/GEN\s*5/.test(conn) && /GEN\s*4|PCIE\s*4|SATA/i.test(t) && !/GEN\s*5|PCIE\s*5/i.test(t)) return false;
    if (/GEN\s*4/.test(conn) && /GEN\s*5|PCIE\s*5|SATA/i.test(t) && !/GEN\s*4|PCIE\s*4/i.test(t)) return false;
    if (/SATA/.test(conn) && /NVME|PCIE/i.test(t)) return false;
  }
  return true;
}

function pickForProduct(product, items) {
  const floor = product.kind === 'mb' ? 6000 : 2000;
  return [...items].filter(item => item && item.availability !== 0 && Number.isSafeInteger(item.itemPrice) && item.itemPrice >= floor && listingMatches(product, item.itemName))
    .sort((a, b) => a.itemPrice - b.itemPrice)[0] || null;
}

module.exports = {loadSheetParts, toProducts, listingMatches, pickForProduct, TABS};
