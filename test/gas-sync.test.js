'use strict';
// gas/sheet-sync.gs を、Apps Script の最小限の模擬環境で実行して確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeSheet(name, grid, formulas = {}) {
  const notes = {}, backgrounds = {};
  const cell = (row, column) => ({
    setValue(value) { grid[row][column] = value; },
    setNote(note) { notes[`${row},${column}`] = note; },
    clearNote() { delete notes[`${row},${column}`]; },
    setBackground(color) { if (color) backgrounds[`${row},${column}`] = color; else delete backgrounds[`${row},${column}`]; },
  });
  return {
    grid, notes, backgrounds,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => grid[0].length,
    getRange(row, column, rows, columns) {
      const r0 = row - 1, c0 = column - 1;
      const read = fn => Array.from({length: rows}, (_, i) => Array.from({length: columns}, (_, j) => fn(r0 + i, c0 + j)));
      return {
        getValues: () => read((r, c) => grid[r][c]),
        getFormulas: () => read((r, c) => formulas[`${r},${c}`] || ''),
        getBackgrounds: () => read((r, c) => backgrounds[`${r},${c}`] || '#ffffff'),
        getCell: (i, j) => cell(r0 + i - 1, c0 + j - 1),
      };
    },
  };
}

function run(sheets, files, fn) {
  const logs = [];
  const context = vm.createContext({
    SpreadsheetApp: {getActiveSpreadsheet: () => ({getSheets: () => sheets})},
    UrlFetchApp: {fetch: url => {
      const file = url.split('/').pop();
      return {getResponseCode: () => (files[file] ? 200 : 404), getContentText: () => JSON.stringify(files[file])};
    }},
    Utilities: {formatDate: date => date.toISOString().slice(0, 16)},
    Logger: {log: line => logs.push(String(line))},
    ScriptApp: {getProjectTriggers: () => [], newTrigger: () => ({timeBased: () => ({everyDays: () => ({atHour: () => ({create() {}})})})})},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/sheet-sync.gs'), 'utf8'), context);
  vm.runInContext(`${fn}()`, context);
  return logs;
}

const fresh = new Date().toISOString();
const files = () => ({
  'rakuten-prices.json': {products: [
    {category: 'gpu', modelName: 'GeForce RTX 5080', status: 'ok', price: 198000, fetchedAt: fresh},
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

test('preview reports the planned changes without touching the sheet', () => {
  const sheet = makeSheet('GPU', gpuGrid());
  const before = JSON.stringify(sheet.grid);
  const logs = run([sheet], files(), 'benchcorePreview');
  assert.equal(JSON.stringify(sheet.grid), before);
  assert.deepEqual([sheet.notes, sheet.backgrounds], [{}, {}]);
  assert.match(logs[0], /プレビュー/);
  assert.ok(logs.some(line => line.includes('GeForce RTX 5080') && line.includes('198000')));
});

test('sync writes fresh prices, fixes safe names and only flags the rest', () => {
  const sheet = makeSheet('GPU', gpuGrid(), {'3,2': '=A1*2'});
  run([sheet, makeSheet('メモ', [['自由記入'], ['触らないで']])], files(), 'benchcoreSync');
  const g = sheet.grid;
  assert.equal(g[1][2], 198000);                       // 楽天価格で上書き
  assert.match(sheet.notes['1,2'], /以前の値: 91/);
  assert.equal(g[2][2], '');                           // 古い楽天価格は使わない
  assert.equal(sheet.backgrounds['2,2'], '#f4cccc');   // 空の価格は赤
  assert.equal(g[3][2], 44000);                        // 数式のセルは書き換えない
  assert.equal(g[4][0], 'Radeon RX 6700 XT');          // 機械的に直せる名前は修正
  assert.match(sheet.notes['4,0'], /以前の名前: GeForce RTX 6700 XT/);
  assert.equal(g[5][0], 'GeForce RTX 7600 XT');        // 直すと重複する名前は書き換えず要確認
  assert.equal(sheet.backgrounds['5,0'], '#fff2cc');
  assert.equal(g[7][0], 'Radeon RX 9000 XT');          // 直せない名前は色を付けるだけ
  assert.equal(sheet.backgrounds['7,0'], '#fff2cc');
  assert.equal(sheet.backgrounds['7,2'], '#f4cccc');   // 円でない価格は赤
  assert.deepEqual(g[8], ['GeForce RTX 3070', 13500, 44000]); // 正常な行はそのまま
  assert.equal(g.length, 9);                           // 行は削除しない
  assert.equal(g[1][1], 38200);                        // スコア列は触らない
});

test('running twice is stable and fixed cells lose their highlight', () => {
  const sheet = makeSheet('GPU', gpuGrid());
  run([sheet], files(), 'benchcoreSync');
  const after = JSON.stringify([sheet.grid, sheet.notes, sheet.backgrounds]);
  const logs = run([sheet], files(), 'benchcoreSync');
  assert.equal(JSON.stringify([sheet.grid, sheet.notes, sheet.backgrounds]), after);
  assert.match(logs[0], / 0 件/);
  sheet.grid[2][2] = 31000;                            // 人が価格を入れたら赤が消える
  run([sheet], files(), 'benchcoreSync');
  assert.equal(sheet.backgrounds['2,2'], undefined);
});

test('sheets without the expected headers are ignored and a missing data file stops the run', () => {
  const other = makeSheet('その他', [['名前', '値'], ['GeForce RTX 5080', 1]]);
  run([other], files(), 'benchcoreSync');
  assert.deepEqual(other.grid[1], ['GeForce RTX 5080', 1]);
  const sheet = makeSheet('GPU', gpuGrid());
  assert.throws(() => run([sheet], {'sheet-audit.json': {issues: []}}, 'benchcoreSync'), /取得できませんでした/);
  assert.equal(sheet.grid[1][2], 91);
});
