'use strict';
// シートに貼る gas/loader.gs を、Apps Script の最小限の模擬環境で実行して確かめる。
// loader は GitHub から gas/sheet-sync.gs を読み込んで動かすので、本番と同じ経路を通る。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SYNC_SOURCE = fs.readFileSync(path.join(__dirname, '../gas/sheet-sync.gs'), 'utf8');
const LOADER_SOURCE = fs.readFileSync(path.join(__dirname, '../gas/loader.gs'), 'utf8');

function makeSheet(name, grid, formulas = {}) {
  const notes = {}, backgrounds = {};
  const width = () => Math.max(...grid.map(row => row.length));
  const cell = (row, column) => {
    const c = {
      setValue(value) { grid[row][column] = value; return c; },
      setNote(note) { notes[`${row},${column}`] = note; return c; },
      clearNote() { delete notes[`${row},${column}`]; return c; },
      setBackground(color) { if (color) backgrounds[`${row},${column}`] = color; else delete backgrounds[`${row},${column}`]; return c; },
    };
    return c;
  };
  return {
    grid, notes, backgrounds,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: width,
    getRange(row, column, rows, columns) {
      const r0 = row - 1, c0 = column - 1;
      if (rows === undefined) return cell(r0, c0);
      const read = fn => Array.from({length: rows}, (_, i) => Array.from({length: columns}, (_, j) => fn(r0 + i, c0 + j)));
      return {
        getValues: () => read((r, c) => grid[r][c] ?? ''),
        getFormulas: () => read((r, c) => formulas[`${r},${c}`] || ''),
        getBackgrounds: () => read((r, c) => backgrounds[`${r},${c}`] || '#ffffff'),
        getCell: (i, j) => cell(r0 + i - 1, c0 + j - 1),
      };
    },
  };
}

function run(sheets, files, fn, {code = SYNC_SOURCE, codeStatus = 200} = {}) {
  const logs = [], fetched = [];
  const context = vm.createContext({
    SpreadsheetApp: {getActiveSpreadsheet: () => ({getSheets: () => sheets})},
    UrlFetchApp: {fetch: url => {
      fetched.push(url);
      const file = url.split('/').pop();
      if (file === 'sheet-sync.gs') return {getResponseCode: () => codeStatus, getContentText: () => code};
      return {getResponseCode: () => (files[file] ? 200 : 404), getContentText: () => JSON.stringify(files[file])};
    }},
    Utilities: {formatDate: date => date.toISOString().slice(0, 16)},
    Logger: {log: line => logs.push(String(line))},
    ScriptApp: {getProjectTriggers: () => [], newTrigger: () => ({timeBased: () => ({everyDays: () => ({atHour: () => ({create() {}})})})})},
  });
  vm.runInContext(LOADER_SOURCE, context);
  vm.runInContext(`${fn}()`, context);
  return {logs, fetched, context};
}

const fresh = new Date().toISOString();
const files = () => ({
  'rakuten-prices.json': {products: [
    {category: 'gpu', modelName: 'GeForce RTX 5080', status: 'ok', price: 198000, fetchedAt: fresh, source: 'Yahoo!ショッピング'},
    {category: 'gpu', modelName: 'Radeon RX 7600', status: 'ok', price: 31000, fetchedAt: '2020-01-01T00:00:00Z'},
    {category: 'gpu', modelName: 'GeForce RTX 4060', status: 'ok', price: 45000, fetchedAt: fresh},
  ]},
  'sheet-audit.json': {issues: [
    {category: 'gpu', modelName: 'GeForce RTX 6700 XT', type: 'name', issue: 'RTX 6700 は存在しません', fix: 'Radeon RX 6700 XT'},
    {category: 'gpu', modelName: 'GeForce RTX 7600 XT', type: 'name', issue: 'RTX 7600 は存在しません', fix: 'Radeon RX 7600 XT'},
    {category: 'gpu', modelName: 'Radeon RX 9000 XT', type: 'name', issue: 'RX 9000 は存在しません'},
  ]},
});
const gpuGrid = () => [
  ['GPU名', 'スコア', '価格(円)'],
  ['GeForce RTX 5080', 38200, 91],
  ['Radeon RX 7600', 11000, ''],
  ['GeForce RTX 4060', 13200, 44000],
  ['GeForce RTX 6700 XT', 12000, 28000],
  ['GeForce RTX 7600 XT', 12500, 38000],
  ['Radeon RX 7600 XT', 12500, 38000],
  ['Radeon RX 9000 XT', 9000, 55.4],
  ['GeForce RTX 3070', 13500, 44000],
];

test('the loader fetches the sync code from GitHub main and preview changes nothing', () => {
  const sheet = makeSheet('GPU', gpuGrid());
  const before = JSON.stringify(sheet.grid);
  const {logs, fetched} = run([sheet], files(), 'benchcorePreview');
  assert.equal(fetched[0], 'https://raw.githubusercontent.com/masa8239/eminem/main/gas/sheet-sync.gs');
  assert.equal(JSON.stringify(sheet.grid), before);
  assert.deepEqual([sheet.notes, sheet.backgrounds], [{}, {}]);
  assert.match(logs[0], /プレビュー/);
  assert.ok(logs.some(line => line.includes('GeForce RTX 5080') && line.includes('198000')));
});

test('sync writes fetched prices to a separate column and never overwrites the reference price', () => {
  const sheet = makeSheet('GPU', gpuGrid(), {'3,2': '=A1*2'});
  run([sheet, makeSheet('メモ', [['自由記入'], ['触らないで']])], files(), 'benchcoreSync');
  const g = sheet.grid;
  assert.equal(g[0][3], '最安値(円)');                 // 新しい列を右端に作る
  assert.equal(g[1][3], 198000);                       // 取れた価格は最安値の列へ
  assert.equal(g[1][2], 91);                           // 価格(円) は書き換えない
  assert.match(sheet.notes['1,3'], /Yahoo!ショッピング/);
  assert.equal(sheet.backgrounds['1,2'], undefined);   // 最安値が取れていれば赤くしない
  assert.equal(g[2][3] ?? '', '');                     // 古い取得価格は使わない
  assert.equal(sheet.backgrounds['2,2'], '#f4cccc');   // 価格も最安値もない行は赤
  assert.equal(g[3][3], 45000);
  assert.equal(g[3][2], 44000);                        // 数式のセルはもちろん、基準価格も触らない
  assert.equal(g[4][0], 'Radeon RX 6700 XT');          // 機械的に直せる名前は修正
  assert.match(sheet.notes['4,0'], /以前の名前: GeForce RTX 6700 XT/);
  assert.equal(g[5][0], 'GeForce RTX 7600 XT');        // 直すと重複する名前は書き換えず要確認
  assert.equal(sheet.backgrounds['5,0'], '#fff2cc');
  assert.equal(g[7][0], 'Radeon RX 9000 XT');          // 直せない名前は色を付けるだけ
  assert.equal(sheet.backgrounds['7,0'], '#fff2cc');
  assert.equal(sheet.backgrounds['7,2'], '#f4cccc');   // 円でない価格は赤
  assert.deepEqual(g[8].slice(0, 3), ['GeForce RTX 3070', 13500, 44000]); // 正常な行はそのまま
  assert.equal(g.length, 9);                           // 行は削除しない
  assert.equal(g[1][1], 38200);                        // スコア列は触らない
});

test('running twice is stable, and a price that is no longer fetched is cleared', () => {
  const sheet = makeSheet('GPU', gpuGrid());
  run([sheet], files(), 'benchcoreSync');
  const after = JSON.stringify([sheet.grid, sheet.notes, sheet.backgrounds]);
  const {logs} = run([sheet], files(), 'benchcoreSync');
  assert.equal(JSON.stringify([sheet.grid, sheet.notes, sheet.backgrounds]), after);
  assert.match(logs[0], / 0 件/);
  const f = files();
  f['rakuten-prices.json'].products = f['rakuten-prices.json'].products.filter(p => p.modelName !== 'GeForce RTX 4060');
  run([sheet], f, 'benchcoreSync');
  assert.equal(sheet.grid[3][3], '');                  // 取れなくなった最安値は消す
  assert.equal(sheet.grid[3][2], 44000);
  sheet.grid[2][2] = 31000;                            // 人が価格を入れたら赤が消える
  run([sheet], files(), 'benchcoreSync');
  assert.equal(sheet.backgrounds['2,2'], undefined);
});

test('the loader does nothing when GitHub is unreachable or returns something unexpected', () => {
  for (const options of [{codeStatus: 503}, {code: '<html>maintenance</html>'}]) {
    const sheet = makeSheet('GPU', gpuGrid());
    const before = JSON.stringify(sheet.grid);
    assert.throws(() => run([sheet], files(), 'benchcoreSync', options), /読み込めませんでした|中止しました/);
    assert.equal(JSON.stringify(sheet.grid), before);
  }
});

test('loaded code stays out of the project scope, so other scripts in the sheet are unaffected', () => {
  const sheet = makeSheet('GPU', gpuGrid());
  const {context} = run([sheet], files(), 'benchcoreSync');
  assert.equal(typeof context.benchcoreRun_, 'undefined');
  assert.equal(typeof context.BENCHCORE_DATA_URL, 'undefined');
  assert.equal(typeof context.benchcoreSync, 'function');
  assert.equal(typeof context.benchcoreInstallDailyTrigger, 'function');
});

test('sheets without the expected headers are ignored and a missing data file stops the run', () => {
  const other = makeSheet('その他', [['名前', '値'], ['GeForce RTX 5080', 1]]);
  run([other], files(), 'benchcoreSync');
  assert.deepEqual(other.grid[1], ['GeForce RTX 5080', 1]);
  const sheet = makeSheet('GPU', gpuGrid());
  assert.throws(() => run([sheet], {'sheet-audit.json': {issues: []}}, 'benchcoreSync'), /取得できませんでした/);
  assert.equal(sheet.grid[1][2], 91);
});
