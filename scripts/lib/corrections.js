'use strict';

// スプレッドシートの「パーツの修正」「パーツ最安値」タブから、人が入れた修正を読む。
//   除外する: その商品（商品コード）を価格の候補から外す
//   正しいメーカー: 商品名から判定したメーカーの代わりに使う
// 読めなかったときは修正なしで続ける（価格の更新は止めない）。

const SHEETS = ['パーツの修正', 'パーツ最安値'];

// 引用符つきの CSV を読む（Google スプレッドシートの出力形式）
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function toCorrections(csvTexts) {
  const exclude = new Set(), maker = new Map();
  // 先に読んだタブ（パーツの修正）を優先する
  const seen = new Set();
  for (const text of csvTexts) {
    const rows = parseCsv(text || '');
    if (rows.length < 2) continue;
    const header = rows[0].map(h => h.trim());
    const c = {code: header.indexOf('商品コード'), ex: header.indexOf('除外する'), maker: header.indexOf('正しいメーカー')};
    if (c.code < 0) continue;
    for (const r of rows.slice(1)) {
      const code = String(r[c.code] || '').trim();
      if (!code || seen.has(code)) continue;
      const ex = c.ex >= 0 && String(r[c.ex] || '').trim().toUpperCase() === 'TRUE';
      const mk = c.maker >= 0 ? String(r[c.maker] || '').trim() : '';
      if (!ex && !mk) continue;
      seen.add(code);
      if (ex) exclude.add(code);
      else if (mk) maker.set(code, mk.slice(0, 40));
    }
  }
  return {exclude, maker};
}

async function loadCorrections(spreadsheetId, fetchImpl = fetch) {
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) return {exclude: new Set(), maker: new Map(), ok: false};
  const texts = [];
  let ok = false;
  for (const sheet of SHEETS) {
    try {
      const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(sheet)}`;
      const response = await fetchImpl(url, {signal: AbortSignal.timeout(20000)});
      const text = await response.text();
      // タブがないときも Google は別のタブを返すことがあるので、見出しで確かめる
      if (response.ok && /商品コード/.test(text.split('\n')[0] || '')) { texts.push(text); ok = true; }
    } catch { /* 読めなかったタブは使わない */ }
  }
  return {...toCorrections(texts), ok};
}

// 「マザーボード仕様」タブ: 1行 = 1枚の板。「型番」列（商品名に含まれる文字）と、自由に足せる仕様の列
const BOARD_SHEET = 'マザーボード仕様';
function toBoardSpecs(text) {
  const rows = parseCsv(text || '');
  if (rows.length < 1) return {columns: [], boards: []};
  const header = rows[0].map(h => h.trim());
  const modelAt = header.indexOf('型番');
  if (modelAt < 0) return {columns: [], boards: []};
  const columns = header.filter((h, i) => i !== modelAt && h && !/^(メモ|備考)$/.test(h)).slice(0, 12);
  const boards = [];
  const seen = new Set();
  for (const r of rows.slice(1)) {
    const model = String(r[modelAt] || '').trim();
    const key = model.toUpperCase().replace(/[\s_-]+/g, '');
    // 短すぎる型番は別の板に当たってしまうので使わない
    if (key.length < 5 || seen.has(key)) continue;
    seen.add(key);
    const fields = {};
    header.forEach((h, i) => { if (columns.includes(h)) { const v = String(r[i] ?? '').trim(); if (v) fields[h] = v.slice(0, 80); } });
    if (Object.keys(fields).length) boards.push({model: model.slice(0, 60), fields});
  }
  return {columns, boards};
}

async function loadBoardSpecs(spreadsheetId, fetchImpl = fetch) {
  if (!spreadsheetId || !/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) return {ok: false};
  try {
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(BOARD_SHEET)}`;
    const response = await fetchImpl(url, {signal: AbortSignal.timeout(20000)});
    const text = await response.text();
    if (!response.ok || !/型番/.test(text.split('\n')[0] || '')) return {ok: false};
    return {ok: true, ...toBoardSpecs(text)};
  } catch { return {ok: false}; }
}

module.exports = {loadCorrections, toCorrections, parseCsv, toBoardSpecs, loadBoardSpecs};
