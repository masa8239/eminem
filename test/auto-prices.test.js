'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {modelSpec, pickItem, parseGpu, parseCpu} = require('../scripts/lib/match');
const {main} = require('../scripts/update-rakuten-prices');
const NO_FIX = {exclude: new Set(), maker: new Map()};

const item = (itemName, itemPrice, extra = {}) => ({itemCode: 'shop:' + itemName.length + itemPrice, itemName, itemPrice, availability: 1, itemUrl: 'https://item.rakuten.co.jp/shop/x/', ...extra});
const GPUS = ['GeForce RTX 5070 Ti', 'GeForce RTX 5070', 'GeForce RTX 5060 Ti 16GB', 'GeForce RTX 5060 Ti', 'GeForce RTX 4070 Ti SUPER', 'GeForce RTX 4070 SUPER', 'Radeon RX 7900 XTX', 'Radeon RX 7900 XT', 'Radeon RX 7600'];

test('model names are parsed into exact grades', () => {
  assert.deepEqual(parseGpu('GeForce RTX 5060 Ti 16GB'), {family: 'RTX', number: '5060', suffix: 'TI', vram: 16});
  assert.deepEqual(parseGpu('GeForce RTX 4070 Ti SUPER'), {family: 'RTX', number: '4070', suffix: 'TI SUPER', vram: null});
  assert.deepEqual(parseGpu('Radeon RX 7900 GRE'), {family: 'RX', number: '7900', suffix: 'GRE', vram: null});
  assert.deepEqual(parseCpu('Ryzen 9 9950X3D'), {brand: 'RYZEN', token: '9950X3D'});
  assert.deepEqual(parseCpu('Core i9-14900KS'), {brand: 'CORE', token: '14900KS'});
  assert.deepEqual(parseCpu('Core Ultra 7 265KF'), {brand: 'ULTRA', token: '265KF', plus: false});
  assert.deepEqual(parseCpu('Core Ultra 7 270K Plus'), {brand: 'ULTRA', token: '270K', plus: true});
  assert.equal(modelSpec('ram', 'G.Skill Trident Z5 DDR5-7200'), null);
});

test('GPU matching never accepts a different grade or VRAM size', () => {
  const s5070 = modelSpec('gpu', 'GeForce RTX 5070', GPUS);
  assert.equal(s5070.keyword, 'RTX 5070');
  assert.ok(s5070.matches('MSI GeForce RTX 5070 12G GAMING TRIO OC グラフィックボード'));
  assert.ok(s5070.matches('ASUS PRIME-RTX5070-O12G RTX5070搭載ビデオカード'));
  assert.ok(!s5070.matches('MSI GeForce RTX 5070 Ti 16G GAMING TRIO'));
  assert.ok(!s5070.matches('GIGABYTE RTX5070TI GAMING OC'));
  assert.ok(!s5070.matches('GeForce RTX 5060 8G'));
  assert.ok(!s5070.matches('ゲーミング Core i7 14700F RTX 5070 メモリ32GB'));

  const ti = modelSpec('gpu', 'GeForce RTX 5070 Ti', GPUS);
  assert.ok(ti.matches('玄人志向 GeForce RTX5070Ti 16GB'));
  assert.ok(!ti.matches('GeForce RTX 5070 12G'));

  const tiSuper = modelSpec('gpu', 'GeForce RTX 4070 Ti SUPER', GPUS);
  assert.ok(tiSuper.matches('GeForce RTX 4070 Ti SUPER 16G'));
  assert.ok(!tiSuper.matches('GeForce RTX 4070 SUPER 12G'));
  assert.ok(!tiSuper.matches('GeForce RTX 4070 Ti 12G'));

  const xt = modelSpec('gpu', 'Radeon RX 7900 XT', GPUS);
  assert.ok(xt.matches('SAPPHIRE PULSE Radeon RX 7900 XT 20GB'));
  assert.ok(!xt.matches('SAPPHIRE NITRO+ Radeon RX 7900 XTX 24GB'));

  const ti16 = modelSpec('gpu', 'GeForce RTX 5060 Ti 16GB', GPUS);
  const ti8 = modelSpec('gpu', 'GeForce RTX 5060 Ti', GPUS);
  assert.ok(ti16.matches('GeForce RTX 5060 Ti 16G VENTUS'));
  assert.ok(!ti16.matches('GeForce RTX 5060 Ti 8G VENTUS'));
  assert.ok(ti8.matches('GeForce RTX 5060 Ti 8G VENTUS'));
  assert.ok(!ti8.matches('GeForce RTX 5060 Ti 16G VENTUS'));
});

test('CPU matching requires the exact model number', () => {
  const k = modelSpec('cpu', 'Core i7-14700K');
  assert.ok(k.matches('Intel Core i7-14700K BOX 第14世代'));
  assert.ok(!k.matches('Intel Core i7-14700KF BOX'));
  assert.ok(!k.matches('Intel Core i7-14700 BOX'));
  const r = modelSpec('cpu', 'Ryzen 5 5600');
  assert.equal(r.keyword, 'Ryzen 5600');
  assert.ok(r.matches('AMD Ryzen 5 5600 BOX Wraith Stealth クーラー付属'));
  assert.ok(!r.matches('AMD Ryzen 5 5600X BOX'));
  assert.ok(!r.matches('Crucial DDR5-5600 32GB メモリ Ryzen対応'));
  assert.ok(!r.matches('ゲーミングPC Ryzen 5 5600 RTX 4060'));
  const u = modelSpec('cpu', 'Core Ultra 7 265K');
  assert.ok(u.matches('インテル Core Ultra 7 265K BOX'));
  assert.ok(!u.matches('インテル Core Ultra 7 265KF BOX'));
});

test('item selection rejects used goods, bundles and off-market prices', () => {
  const spec = modelSpec('gpu', 'GeForce RTX 5070', GPUS);
  const items = [
    item('【中古】GeForce RTX 5070 12G', 60000),
    item('GeForce RTX 5070 用 サポートステー', 2000),
    item('GeForce RTX 5070 12G 本体+延長保証セット', 120000),
    item('MSI GeForce RTX 5070 12G VENTUS', 112000),
    item('ASUS GeForce RTX 5070 12G PRIME', 109800),
    item('GIGABYTE GeForce RTX 5070 12G', 400000),
    item('GeForce RTX 5070 12G 在庫なし', 90000, {availability: 0}),
  ];
  assert.equal(pickItem(spec, items, 110000).item.itemPrice, 109800);
  // 参考価格から大きく外れたものしかなければ採用しない
  assert.equal(pickItem(spec, [item('GeForce RTX 5070 12G', 30000)], 110000).item, undefined);
  // 参考価格がないときは3件以上の相場が必要
  assert.match(pickItem(spec, items.slice(3, 5), null).reason, /5件未満/);
  assert.equal(pickItem(spec, [...items.slice(3, 5), item('ZOTAC GeForce RTX 5070 12G', 115000), item('Palit RTX 5070 12G', 112500), item('PNY RTX 5070 12G', 113000), item('謎 GeForce RTX 5070 12G', 9800)], null).item.itemPrice, 109800);
});

test('update script writes prices, keeps going on misses and never leaks credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const env = {RAKUTEN_APPLICATION_ID: 'app-secret', RAKUTEN_ACCESS_KEY: 'access-secret', RAKUTEN_AFFILIATE_ID: 'aff-secret'};
  const models = [
    {category: 'gpu', modelName: 'GeForce RTX 5070', referencePrice: 110000},
    {category: 'cpu', modelName: 'Ryzen 5 5600', referencePrice: 9800},
    {category: 'gpu', modelName: 'Radeon RX 7600', referencePrice: 32000},
  ];
  const keywords = [], logs = [];
  const fetchImpl = async (url, options) => {
    keywords.push(url.searchParams.get('keyword'));
    assert.equal(options.headers.accessKey, 'access-secret');
    const keyword = url.searchParams.get('keyword');
    const Items = keyword === 'RTX 5070' ? [item('MSI GeForce RTX 5070 12G', 111000, {affiliateUrl: 'https://hb.afl.rakuten.co.jp/abc', shopName: 'ショップ'})]
      : keyword === 'Ryzen 5600' ? [item('AMD Ryzen 5 5600 BOX', 9980)]
      : [item('【中古】Radeon RX 7600 8GB', 20000)];
    return {ok: true, json: async () => ({Items})};
  };
  const code = await main(env, fetchImpl, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log: line => logs.push(line), now: new Date('2026-11-11T00:00:00Z'), discoveryQueries: []});
  assert.equal(code, 0);
  assert.deepEqual(keywords, ['RTX 5070', 'Ryzen 5600', 'RX 7600']);
  const text = fs.readFileSync(output, 'utf8');
  const data = JSON.parse(text);
  assert.deepEqual(data.products.map(p => [p.modelName, p.price, p.status]), [['GeForce RTX 5070', 111000, 'ok'], ['Ryzen 5 5600', 9980, 'ok']]);
  assert.equal(data.products[0].url, 'https://hb.afl.rakuten.co.jp/abc');
  assert.equal(data.products[0].fetchedAt, '2026-11-11T00:00:00.000Z');
  assert.deepEqual(data.unmatched.map(u => u.modelName), ['Radeon RX 7600']);
  assert.ok(!/app-secret|access-secret/.test(text + logs.join('\n')));
});

test('an API outage keeps the previous price file untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  fs.writeFileSync(output, '{"products":[{"category":"gpu","modelName":"GeForce RTX 5070","status":"ok","price":1,"fetchedAt":"2026-11-10T00:00:00Z"}]}');
  const env = {RAKUTEN_APPLICATION_ID: 'a', RAKUTEN_ACCESS_KEY: 'b', RAKUTEN_AFFILIATE_ID: 'c'};
  const models = ['5070', '5070 Ti', '5080', '5090', '4060'].map(n => ({category: 'gpu', modelName: 'GeForce RTX ' + n, referencePrice: 100000}));
  const code = await main(env, async () => ({ok: false, status: 503}), {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}});
  assert.equal(code, 1);
  assert.match(fs.readFileSync(output, 'utf8'), /"price":1/);
  assert.equal(await main({}, async () => assert.fail('no network without credentials'), {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, log() {}}), 1);
});

test('the site model list can be read from index.html without network', async () => {
  const {loadModels} = require('../scripts/update-rakuten-prices');
  const models = await loadModels(async () => { throw new Error('offline'); });
  assert.ok(models.length > 80);
  const gpu = models.find(m => m.modelName === 'GeForce RTX 5090');
  assert.equal(gpu.category, 'gpu');
  assert.ok(gpu.referencePrice > 100000);
  // すべての内蔵モデルが検索語と判定を持つ
  for (const model of models) {
    assert.ok(modelSpec(model.category, model.modelName, models.filter(m => m.category === model.category).map(m => m.modelName)), model.modelName);
  }
});

test('sheet audit flags wrong tiers and non-existent models without touching valid ones', () => {
  const {nameIssue} = require('../scripts/lib/audit');
  for (const name of ['Ryzen 9 9950X3D', 'Ryzen 5 5600', 'Ryzen 7 5700X3D', 'Ryzen 7 PRO 4750G', 'Ryzen 5 3600 AF', 'Core i9-14900KS', 'Core i9-10850K', 'Core i5-12400F', 'Core i7-8700T', 'Core Ultra 7 265KF', 'Core Ultra 9 285', 'Apple M2 Max']) {
    assert.equal(nameIssue('cpu', name), null, name);
  }
  assert.match(nameIssue('cpu', 'Core i9-14600KF'), /Core i5-14600KF/);
  assert.match(nameIssue('cpu', 'Ryzen 5 1800X'), /Ryzen 7 1800X/);
  assert.match(nameIssue('cpu', 'Core Ultra 9 235'), /Core Ultra 5 235/);
  for (const name of ['Core i9-6790 XT', 'Core i7 5900X', 'Core i7-1700', 'Core i5-12000', 'Ryzen 5 9600ST', 'AMD 4700G']) assert.ok(nameIssue('cpu', name), name);
  for (const name of ['GeForce RTX 5090', 'GeForce RTX 5060 Ti 16GB', 'GeForce GTX 1660 SUPER', 'GeForce GTX 980 Ti', 'Radeon RX 7900 XTX', 'Radeon RX 6500 XT 4GB', 'Radeon RX Vega 8(Ryzen 5000)', 'Arc A770 8GB', 'NVIDIA TITAN Xp', 'Radeon 780M']) {
    assert.equal(nameIssue('gpu', name), null, name);
  }
  for (const name of ['GeForce RTX 6700 XT', 'GeForce RTX 1080 Ti', 'GeForce GTX 2060 6GB', 'Radeon RX 9000 XT 16GB', 'Radeon RT 360', 'GeForce RX Vega 64', 'Arc 8970', 'GeForce RTX 3060 SUPER']) assert.ok(nameIssue('gpu', name), name);
});

test('update run also writes the sheet audit next to the price file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const env = {RAKUTEN_APPLICATION_ID: 'a', RAKUTEN_ACCESS_KEY: 'b', RAKUTEN_AFFILIATE_ID: 'c'};
  const models = [
    {category: 'gpu', modelName: 'GeForce RTX 6700 XT', referencePrice: null, fromSheet: true, sheetPriceValid: false},
    {category: 'gpu', modelName: 'GeForce RTX 5070', referencePrice: 110000, fromSheet: true, sheetPriceValid: false},
    {category: 'cpu', modelName: 'Ryzen 5 5600', referencePrice: 9800, fromSheet: false},
  ];
  let calls = 0;
  const fetchImpl = async url => { calls++; return {ok: true, json: async () => ({Items: url.searchParams.get('keyword') === 'RTX 5070' ? [item('MSI GeForce RTX 5070 12G', 111000)] : []})}; };
  assert.equal(await main(env, fetchImpl, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: []}), 0);
  assert.equal(calls, 3);
  const audit = JSON.parse(fs.readFileSync(path.join(dir, 'sheet-audit.json'), 'utf8'));
  assert.deepEqual(audit.issues.map(i => [i.modelName, i.type]), [['GeForce RTX 6700 XT', 'name'], ['GeForce RTX 6700 XT', 'price']]);
});

test('site-side name correction agrees with the audit and leaves valid names alone', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const document = {addEventListener() {}, getElementById() { return {value: '', innerHTML: '', textContent: '', style: {}}; }};
  const context = vm.createContext({document, window: {addEventListener() {}}, localStorage: {getItem() { return null; }}, URL, URLSearchParams, console});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1].split('// ===== INIT =====')[0], context);
  const fix = (category, name) => vm.runInContext(`correctModelName(${JSON.stringify(category)},${JSON.stringify(name)})`, context);
  const {nameIssue} = require('../scripts/lib/audit');
  // 内蔵データの名前は一切変わらない
  for (const [category, list] of [['cpu', 'FALLBACK_CPU'], ['gpu', 'FALLBACK_GPU']]) {
    for (const name of JSON.parse(vm.runInContext(`JSON.stringify(${list}.map(x=>x.name))`, context))) assert.equal(fix(category, name), name);
  }
  for (const [from, to] of [['Core i9-14600KF', 'Core i5-14600KF'], ['Core i5-12700', 'Core i7-12700'], ['Core i9-14100F', 'Core i3-14100F'], ['Core i7-10900KF', 'Core i9-10900KF'],
    ['Ryzen 5 1800X', 'Ryzen 7 1800X'], ['Ryzen 3 3600', 'Ryzen 5 3600'], ['Ryzen 5 5700X3D', 'Ryzen 7 5700X3D'], ['Core Ultra 9 235', 'Core Ultra 5 235']]) {
    assert.equal(fix('cpu', from), to);
    assert.ok(nameIssue('cpu', from).includes(to), from);
    assert.equal(nameIssue('cpu', to), null, to);
  }
  for (const name of ['Core i9-10850K', 'Ryzen 7 PRO 4750G', 'Core i9-6790 XT', 'Core i7 5900X', 'Apple M2 Max', 'Core i7-1700']) assert.equal(fix('cpu', name), name);
  for (const [from, to] of [['GeForce RTX 6700 XT', 'Radeon RX 6700 XT'], ['GeForce RTX 7900 GRE', 'Radeon RX 7900 GRE'], ['GeForce RTX 1080 Ti', 'GeForce GTX 1080 Ti'],
    ['GeForce GTX 2060 12GB', 'GeForce RTX 2060 12GB'], ['GeForce RX Vega 64', 'Radeon RX Vega 64'], ['Radeon RX 5600 XT(145gpu)', 'Radeon RX 5600 XT']]) {
    assert.equal(fix('gpu', from), to);
    assert.ok(nameIssue('gpu', from), from);
    assert.equal(nameIssue('gpu', to), null, to);
  }
  for (const name of ['GeForce RTX 5090', 'GeForce RTX 3060 SUPER', 'Radeon RX 9000 XT 16GB', 'Arc 8970']) assert.equal(fix('gpu', name), name);
  // 補正後は系列に合ったメーカー・機能になり、重複は1件にまとまる
  const parsed = JSON.parse(vm.runInContext(`JSON.stringify(dedupeByName([{'GPU名':'GeForce RTX 6700 XT','スコア':12000},{'GPU名':'Radeon RX 6700 XT','スコア':11000}].map(parseGpuRow)))`, context));
  assert.equal(parsed.length, 1);
  assert.deepEqual([parsed[0].name, parsed[0].sheetName, parsed[0].maker, parsed[0].rt, parsed[0].dlss], ['Radeon RX 6700 XT', 'GeForce RTX 6700 XT', 'AMD', '対応', '—']);
});

test('socket, ray tracing and upscaler follow the rules checked against maker and Wikipedia specs', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const document = {addEventListener() {}, getElementById() { return {value: '', innerHTML: '', textContent: '', style: {}}; }};
  const context = vm.createContext({document, window: {addEventListener() {}}, localStorage: {getItem() { return null; }}, URL, URLSearchParams, console});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1].split('// ===== INIT =====')[0], context);
  const run = code => vm.runInContext(code, context);
  const socket = name => run(`cpuSocket(${JSON.stringify(name)})`);
  for (const [name, want] of [['Core i7-7700', 'LGA1151'], ['Core i9-9900KS', 'LGA1151'], ['Core i9-10850K', 'LGA1200'], ['Core i5-11400F', 'LGA1200'],
    ['Core i5-12600', 'LGA1700'], ['Core i9-14900KS', 'LGA1700'], ['Core Ultra 7 270K Plus', 'LGA1851'], ['Core Ultra 5 225F', 'LGA1851'],
    ['Ryzen 7 1800X', 'AM4'], ['Ryzen 5 3600 AF', 'AM4'], ['Ryzen 7 PRO 4750G', 'AM4'], ['Ryzen 7 5700X3D', 'AM4'], ['Ryzen 5 5600GT', 'AM4'],
    ['Ryzen 7 7700', 'AM5'], ['Ryzen 5 8600G', 'AM5'], ['Ryzen 9 9950X3D', 'AM5'],
    // 規則に当てはまらない型番は推測しない（空欄）
    ['Ryzen 7 8845HS', ''], ['Core i7-1260P', ''], ['Apple M2', '']]) assert.equal(socket(name), want, name);
  const feat = name => JSON.parse(run(`JSON.stringify(gpuFeatures(${JSON.stringify(name)}))`));
  for (const [name, rt, up] of [['GeForce RTX 2060 12GB', '対応', 'DLSS'], ['GeForce RTX 5090', '対応', 'DLSS'], ['GeForce GTX 1080 Ti', '非対応', '—'],
    ['NVIDIA TITAN V', '非対応', '—'], ['GeForce GTX TITAN X', '非対応', '—'], ['Radeon RX 9070 XT', '対応', 'FSR 4'], ['Radeon RX 7600', '対応', '—'],
    ['Radeon RX 6500 XT 4GB', '対応', '—'], ['Radeon RX 5700 XT', '非対応', '—'], ['Radeon RX 590', '非対応', '—'], ['Radeon RX Vega 64', '非対応', '—'],
    ['Arc A380', '対応', 'XeSS']]) assert.deepEqual([feat(name).rt, feat(name).upscaler], [rt, up], name);
  for (const [name, maker] of [['Arc A770 8GB', 'Intel'], ['NVIDIA TITAN Xp', 'NVIDIA'], ['GeForce GT 1030', 'NVIDIA'], ['Radeon R9 Fury X', 'AMD']]) assert.equal(run(`gpuMaker(${JSON.stringify(name)})`), maker, name);
});

test('new models are discovered from listings and known or doubtful ones are ignored', () => {
  const {discoverNewModels, modelFromItemName} = require('../scripts/lib/match');
  assert.deepEqual(modelFromItemName('MSI GeForce RTX 6070 Ti 16G GAMING'), {category: 'gpu', modelName: 'GeForce RTX 6070 Ti'});
  assert.deepEqual(modelFromItemName('AMD Ryzen 7 9850X3D BOX'), {category: 'cpu', modelName: 'Ryzen 7 9850X3D'});
  assert.deepEqual(modelFromItemName('インテル Core Ultra 7 270K BOX'), {category: 'cpu', modelName: 'Core Ultra 7 270K'});
  for (const name of ['ゲーミングPC Ryzen 7 9850X3D RTX 6070', '【中古】GeForce RTX 6070', 'NVIDIA Quadro RTX 5000', 'DDR5 メモリ Ryzen 9000対応', 'RTX 6070 用 ケーブル']) assert.equal(modelFromItemName(name), null, name);
  const mk = (name, price, code) => ({itemCode: code, itemName: name, itemPrice: price, availability: 1});
  const items = [mk('MSI GeForce RTX 6070 12G', 120000, 'a:1'), mk('ASUS RTX6070 12G', 118000, 'b:1'), mk('GIGABYTE GeForce RTX 6070', 125000, 'c:1'), mk('GIGABYTE GeForce RTX 6070', 125000, 'c:1'),
    mk('ZOTAC GeForce RTX 5070 12G', 110000, 'd:1'), mk('PNY RTX 5070', 109000, 'e:1'), mk('Palit RTX 5070', 108000, 'f:1'),
    mk('AMD Ryzen 7 9850X3D BOX', 90000, 'g:1'), mk('AMD Ryzen 7 9850X3D', 91000, 'h:1')];
  const found = discoverNewModels(items, [{category: 'gpu', modelName: 'GeForce RTX 5070'}]);
  assert.deepEqual(found.map(c => [c.modelName, c.listings, c.medianPrice]), [['GeForce RTX 6070', 3, 120000]]);
});

test('a second store adds offers, the cheapest wins, and points are recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const env = {RAKUTEN_APPLICATION_ID: 'a', RAKUTEN_ACCESS_KEY: 'b', RAKUTEN_AFFILIATE_ID: 'c', YAHOO_CLIENT_ID: 'yahoo-secret'};
  const models = [{category: 'gpu', modelName: 'GeForce RTX 5070', referencePrice: 110000}, {category: 'cpu', modelName: 'Ryzen 5 5600', referencePrice: 9800}];
  const fetchImpl = async url => {
    if (url.hostname === 'shopping.yahooapis.jp') {
      assert.equal(url.searchParams.get('appid'), 'yahoo-secret');
      return {ok: true, json: async () => ({hits: url.searchParams.get('query') === 'RTX 5070'
        ? [{code: 'shop_1', name: 'ASUS GeForce RTX 5070 12G', price: 105000, inStock: true, condition: 'new', url: 'https://store.shopping.yahoo.co.jp/shop/1.html', point: {amount: 0, bonusAmount: 0, lyLimitedBonusAmount: 1050}, seller: {name: 'Yショップ'}},
           {code: 'shop_2', name: 'GeForce RTX 5070 12G 中古', price: 70000, inStock: true, condition: 'used', url: 'https://store.shopping.yahoo.co.jp/shop/2.html'}]
        : []})};
    }
    const keyword = url.searchParams.get('keyword');
    return {ok: true, json: async () => ({Items: keyword === 'RTX 5070' ? [item('MSI GeForce RTX 5070 12G', 111000, {pointRate: 5})] : keyword === 'Ryzen 5600' ? [item('AMD Ryzen 5 5600 BOX', 9980)] : []})};
  };
  assert.equal(await main(env, fetchImpl, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: ['x']}), 0);
  const text = fs.readFileSync(output, 'utf8');
  const [gpu, cpu] = JSON.parse(text).products;
  assert.deepEqual([gpu.source, gpu.price, gpu.points], ['Yahoo!ショッピング', 105000, 1050]);
  assert.deepEqual(gpu.offers.map(o => [o.store, o.price, o.points]), [['Yahoo!ショッピング', 105000, 1050], ['楽天市場', 111000, 5550]]);
  assert.deepEqual([cpu.source, cpu.price, cpu.points, cpu.offers.length], ['楽天市場', 9980, 99, 1]);
  assert.ok(!text.includes('yahoo-secret'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'new-products.json'), 'utf8')).candidates, []);
});

test('Yahoo alone is enough, and a Rakuten outage falls back to Yahoo without long waits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const models = ['5070', '5080', '5090', '4060', '4070'].map(n => ({category: 'gpu', modelName: 'GeForce RTX ' + n, referencePrice: 100000}));
  const yahooHit = url => ({ok: true, json: async () => ({hits: [{code: 's_' + url.searchParams.get('query'), name: 'MSI GeForce ' + url.searchParams.get('query') + ' 12G', price: 99000, inStock: true, condition: 'new', url: 'https://store.shopping.yahoo.co.jp/s/1.html'}]})});
  // Yahoo のみ
  let rakutenCalls = 0;
  let code = await main({YAHOO_CLIENT_ID: 'y'}, async url => { if (url.hostname !== 'shopping.yahooapis.jp') { rakutenCalls++; return {ok: false, status: 500}; } return yahooHit(url); }, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: ['q']});
  assert.equal(code, 0);
  assert.equal(rakutenCalls, 0);
  let data = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(data.stores, ['Yahoo!ショッピング']);
  assert.deepEqual(data.products.map(p => [p.source, p.price]), Array(5).fill(['Yahoo!ショッピング', 99000]));
  // 楽天が障害中: 3回で打ち切り、Yahoo の価格で更新する
  rakutenCalls = 0;
  const logs = [];
  code = await main({RAKUTEN_APPLICATION_ID: 'a', RAKUTEN_ACCESS_KEY: 'b', RAKUTEN_AFFILIATE_ID: 'c', YAHOO_CLIENT_ID: 'y'},
    async url => { if (url.hostname !== 'shopping.yahooapis.jp') { rakutenCalls++; return {ok: false, status: 503}; } return yahooHit(url); }, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log: l => logs.push(l), discoveryQueries: []});
  assert.equal(code, 0);
  assert.equal(rakutenCalls, 3);
  data = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual([data.stores, data.products.length], [['Yahoo!ショッピング'], 5]);
  assert.ok(logs.some(l => l.includes('この回は楽天を使いません')));
  // どちらも落ちているときは前回のファイルを残す
  const before = fs.readFileSync(output, 'utf8');
  code = await main({RAKUTEN_APPLICATION_ID: 'a', RAKUTEN_ACCESS_KEY: 'b', RAKUTEN_AFFILIATE_ID: 'c', YAHOO_CLIENT_ID: 'y'}, async () => ({ok: false, status: 503}), {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: []});
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(output, 'utf8'), before);
});

test('Yahoo rate limits are waited out, and a partial run still saves what it got', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const models = ['5070', '5080', '5090', '4060', '4070'].map(n => ({category: 'gpu', modelName: 'GeForce RTX ' + n, referencePrice: 100000}));
  const ok = url => ({ok: true, json: async () => ({hits: [{code: 's_' + url.searchParams.get('query'), name: 'MSI GeForce ' + url.searchParams.get('query') + ' 12G', price: 99000, inStock: true, condition: 'new', url: 'https://store.shopping.yahoo.co.jp/s/1.html'}]})});
  const limited = {ok: false, status: 429, text: async () => '{"Status":429,"Message":"The AppID is denied"}'};
  // 一時的な 429 は待ってやり直し、全件取れる
  let calls = 0;
  let code = await main({YAHOO_CLIENT_ID: 'y'}, async url => (++calls % 3 === 0 ? limited : ok(url)), {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: []});
  assert.equal(code, 0);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).products.length, 5);
  // 途中から 429 が続いても、それまでに取れた分は保存する
  calls = 0;
  fs.rmSync(output);
  code = await main({YAHOO_CLIENT_ID: 'y'}, async url => (++calls <= 2 ? ok(url) : limited), {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: []});
  assert.equal(code, 0);
  const data = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(data.products.length, 2);
  assert.deepEqual(data.stores, ['Yahoo!ショッピング']);
});

test('real bad listings from the first Yahoo run are rejected', () => {
  const {modelSpec: spec, pickItem: pick} = require('../scripts/lib/match');
  const all = ['GeForce RTX 2070', 'GeForce RTX 2060', 'GeForce RTX 2080', 'Radeon RX 5600 XT', 'GeForce GTX 1050', 'GeForce RTX 2080 Ti'];
  const bad = [
    ['GeForce RTX 2070', '互換品＜ 新品 ＞Razer Blade Pro 17 2017 / Blade 17 2E75 Blade GTX1060 i7-7700HQ 2019 RTX 2060 RTX 2070 RTX 2080 RZ09-0220', 8111],
    ['Radeon RX 5600 XT', '並行輸入品 オートバイ 装飾 用ネジキャップカバー ボディ エンジン ボルト KTM 890 ADVENTURE STREETFIGHTER V4 RX 5600XT カワ', 2980],
    ['GeForce GTX 1050', '【並行輸入品】 Deal4GO CPU冷却ファン 交換用 GTX1050グラフィックス Lenovo Y520', 11100],
    ['GeForce RTX 2080 Ti', '【並行輸入品】 PNY GeForce RTX 2080 Ti Blower Graphics Card', 193200],
  ];
  for (const [model, name, price] of bad) {
    const s = spec('gpu', model, all);
    const one = {itemCode: 'x:1', itemName: name, itemPrice: price, availability: 1};
    assert.equal(pick(s, [one, {...one, itemCode: 'x:2'}, {...one, itemCode: 'x:3'}], null, 'gpu').item, undefined, model);
  }
  // 相場より極端に安い怪しい出品は、参考価格があれば外す
  const s = spec('cpu', 'Ryzen 7 9800X3D');
  const mk = (p, c) => ({itemCode: c, itemName: 'AMD Ryzen 7 9800X3D BOX', itemPrice: p, availability: 1});
  assert.equal(pick(s, [mk(59800, 'a'), mk(84800, 'b')], 89800, 'cpu').item.itemPrice, 84800);
  // 正常なグラボ名（3連ファンなど）は通る
  assert.ok(spec('gpu', 'GeForce RTX 5070', ['GeForce RTX 5070']).matches('MSI GeForce RTX 5070 12G GAMING TRIO 3連ファン'));
});

test('Yahoo is searched cheapest-first inside a plausible price range when a reference exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const seen = [];
  const models = [{category: 'gpu', modelName: 'GeForce RTX 5060', referencePrice: 58000}, {category: 'gpu', modelName: 'GeForce RTX 3050', referencePrice: null}];
  await main({YAHOO_CLIENT_ID: 'y'}, async url => { seen.push(Object.fromEntries(url.searchParams)); return {ok: true, json: async () => ({hits: []})}; }, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: []});
  assert.deepEqual([seen[0].sort, seen[0].price_from, seen[0].price_to, seen[0].results], ['+price', '40600', '104400', '50']);
  assert.equal(seen[1].sort, undefined);
  const {modelSpec: spec, pickItem: pick} = require('../scripts/lib/match');
  for (const name of ['箱難あり品 Intel CPU Core i7-14700F BOX', 'AMD Ryzen5 5600 企業向けバルク品']) {
    const model = name.includes('14700F') ? 'Core i7-14700F' : 'Ryzen 5 5600';
    assert.equal(pick(spec('cpu', model), [{itemCode: 'a:1', itemName: name, itemPrice: 30000, availability: 1}], 30000, 'cpu').item, undefined, name);
  }
});

test('Yahoo affiliate parameters are sent only when an ID is configured, and store points are read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const models = [{category: 'gpu', modelName: 'GeForce RTX 5070', referencePrice: 110000}];
  const seen = [];
  const fetchImpl = async url => { seen.push(Object.fromEntries(url.searchParams)); return {ok: true, json: async () => ({hits: [
    {code: 's_1', name: 'MSI GeForce RTX 5070 12G', price: 105000, inStock: true, condition: 'new', url: 'https://ck.jp.ap.valuecommerce.com/servlet/referral?vs=1&vp=2', point: {amount: 0, bonusAmount: 0, lyLimitedBonusAmount: 1050}}]})}; };
  await main({YAHOO_CLIENT_ID: 'y'}, fetchImpl, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: [], affiliate: {}});
  assert.equal(seen[0].affiliate_type, undefined);
  await main({YAHOO_CLIENT_ID: 'y'}, fetchImpl, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: [], affiliate: {yahooValueCommerceId: 'VC-ID'}});
  assert.deepEqual([seen[1].affiliate_type, seen[1].affiliate_id], ['vc', 'VC-ID']);
  const product = JSON.parse(fs.readFileSync(output, 'utf8')).products[0];
  assert.equal(product.points, 1050);
  assert.match(product.url, /^https:\/\/ck\.jp\.ap\.valuecommerce\.com\//);
});

test('price history keeps one point per day for prices fetched in this run only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const models = [{category: 'gpu', modelName: 'GeForce RTX 5070', referencePrice: 110000}, {category: 'gpu', modelName: 'GeForce RTX 5080', referencePrice: 200000}];
  let price = 105000, up = true;
  const fetchImpl = async url => (up || url.searchParams.get('query') !== 'RTX 5080'
    ? {ok: true, json: async () => ({hits: [{code: 's_' + url.searchParams.get('query'), name: 'MSI GeForce ' + url.searchParams.get('query') + ' 16G', price: url.searchParams.get('query') === 'RTX 5070' ? price : 199000, inStock: true, condition: 'new', url: 'https://store.shopping.yahoo.co.jp/s/1.html'}]})}
    : {ok: false, status: 500, text: async () => ''});
  const opts = now => ({skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: [], affiliate: {}, now: new Date(now)});
  await main({YAHOO_CLIENT_ID: 'y'}, fetchImpl, opts('2026-11-13T00:00:00Z'));
  price = 99000;
  await main({YAHOO_CLIENT_ID: 'y'}, fetchImpl, opts('2026-11-13T12:00:00Z'));   // 同じ日は上書き
  up = false;                                                                     // 翌日 5080 は取れず前回分を引き継ぐ
  await main({YAHOO_CLIENT_ID: 'y'}, fetchImpl, opts('2026-11-14T00:00:00Z'));
  const series = JSON.parse(fs.readFileSync(path.join(dir, 'price-history.json'), 'utf8')).series;
  assert.deepEqual(series['gpu|GeForce RTX 5070'], [['2026-11-13', 99000], ['2026-11-14', 99000]]);
  assert.deepEqual(series['gpu|GeForce RTX 5080'], [['2026-11-13', 199000]]);
});

test('an affiliate run that yields no usable links keeps the previous price file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  fs.writeFileSync(output, '{"products":[{"modelName":"keep"}]}');
  const models = [{category: 'gpu', modelName: 'GeForce RTX 5070', referencePrice: 110000}];
  const fetchImpl = async () => ({ok: true, json: async () => ({hits: [{code: 's_1', name: 'MSI GeForce RTX 5070 12G', price: 105000, inStock: true, condition: 'new', url: 'javascript:alert(1)'}]})});
  const logs = [];
  const code = await main({YAHOO_CLIENT_ID: 'y'}, fetchImpl, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log: l => logs.push(l), discoveryQueries: [], affiliate: {yahooValueCommerceId: 'VC'}});
  assert.equal(code, 1);
  assert.match(fs.readFileSync(output, 'utf8'), /keep/);
  assert.ok(logs.some(l => l.includes('リンクの形式を確認')));
});

test('ValueCommerce links returned over http are upgraded to https; other http links are still refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
  const output = path.join(dir, 'rakuten-prices.json');
  const models = [{category: 'gpu', modelName: 'GeForce RTX 5070', referencePrice: 110000}, {category: 'gpu', modelName: 'GeForce RTX 5080', referencePrice: 200000}];
  const fetchImpl = async url => {
    const q = url.searchParams.get('query');
    const link = q === 'RTX 5070' ? 'http://ck.jp.ap.valuecommerce.com/servlet/referral?vs=1&vp=2&vc_url=x' : 'http://example.com/item';
    return {ok: true, json: async () => ({hits: [{code: 's_' + q, name: 'MSI GeForce ' + q + ' 16G', price: q === 'RTX 5070' ? 105000 : 199000, inStock: true, condition: 'new', url: link}]})};
  };
  assert.equal(await main({YAHOO_CLIENT_ID: 'y'}, fetchImpl, {skipRam: true, skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models, output, delayMs: 0, log() {}, discoveryQueries: [], affiliate: {yahooValueCommerceId: 'http://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=2&vc_url='}}), 0);
  const products = JSON.parse(fs.readFileSync(output, 'utf8')).products;
  assert.deepEqual(products.map(p => [p.modelName, p.url.slice(0, 40)]), [['GeForce RTX 5070', 'https://ck.jp.ap.valuecommerce.com/servl']]);
});

test('memory is priced per spec from clearly matching new desktop kits only', async () => {
  const {parseRamTitle, RAM_SPECS, pickRamOffers} = require('../scripts/lib/ram');
  assert.deepEqual(parseRamTitle('Crucial Pro DDR5-6000 32GB(16GBx2) CL36 デスクトップ用'), {type: 'DDR5', speed: 6000, perStick: 16, sticks: 2, cl: 36});
  assert.deepEqual(parseRamTitle('Kingston FURY Beast DDR5 6000MT/s 32GB (2x16GB) KF560C36BBEK2-32'), {type: 'DDR5', speed: 6000, perStick: 16, sticks: 2, cl: 36});
  assert.deepEqual(parseRamTitle('シリコンパワー DDR4-3200 PC4-25600 16GB×2枚'), {type: 'DDR4', speed: 3200, perStick: 16, sticks: 2, cl: null});
  for (const title of ['Crucial DDR5-5600 16GBx2 SO-DIMM ノートPC用', 'Corsair DDR5-6000 16GBx2 CUDIMM', 'ADATA DDR5-4800 / DDR5-5600 対応 16GBx2',
    'Kingston DDR4 3200 8GB 単品', '【中古】G.Skill DDR5-6000 16GBx2', 'DDR5-6000 16GBx2 ECC サーバー用', 'Samsung DDR5-6000 16GB×2 / 32GB×2 選択']) assert.equal(parseRamTitle(title), null, title);

  const spec = RAM_SPECS.find(s => s.label === 'DDR5-6000 32GB（16GB×2）');
  const item = (itemName, itemPrice, shopName) => ({itemCode: 'yahoo:' + itemName.length + itemPrice + shopName, itemName, itemPrice, availability: 1, shopName, itemUrl: 'https://store.shopping.yahoo.co.jp/' + shopName + '/1.html'});
  const offers = pickRamOffers(spec, [
    item('DDR5-6000 16GBx2 SO-DIMM', 9000, 'a'),            // ノート用
    item('DDR5-6000 16GB 単品', 9500, 'b'),                   // 枚数が読めない
    item('DDR5-6000 32GB(16GBx2) ヒートシンク', 1200, 'c'),    // 安すぎる
    item('Crucial Pro DDR5-6000 32GB(16GBx2) CL36', 21000, 'd'),
    item('Crucial Pro DDR5-6000 32GB(16GBx2) CL36', 21500, 'd'), // 同じ店の2件目
    item('G.Skill DDR5-6000 16GB×2枚 CL30', 23000, 'e'),
    item('DDR5-5600 16GBx2', 15000, 'f'),                       // 速度違い
  ]);
  assert.deepEqual(offers.map(o => [o.shopName, o.itemPrice, o.cl]), [['d', 21000, 36], ['e', 23000, 30]]);
  // 1店だけの規格や並行輸入品は載せない
  assert.deepEqual(pickRamOffers(spec, [item('Crucial Pro DDR5-6000 32GB(16GBx2) CL36', 21000, 'd')]), []);
  assert.equal(parseRamTitle('【並行輸入品】TEAMGROUP DDR5-6000 32GB (2 x 16GB)'), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ram-'));
  const output = path.join(dir, 'prices.json');
  const fetchImpl = async url => ({ok: true, json: async () => ({hits: String(url.searchParams.get('query')).startsWith('DDR5-6000') ? [
    {code: 'd_1', name: 'Crucial Pro DDR5-6000 32GB(16GBx2) CL36', price: 21000, inStock: true, condition: 'new', url: 'https://store.shopping.yahoo.co.jp/d/1.html', seller: {name: 'd'}},
    {code: 'e_1', name: 'G.Skill DDR5-6000 16GB×2枚 CL30', price: 23000, inStock: true, condition: 'new', url: 'https://store.shopping.yahoo.co.jp/e/1.html', seller: {name: 'e'}},
  ] : []})});
  const code = await main({YAHOO_CLIENT_ID: 'y'}, fetchImpl, {skipBlender: true, skipParts: true, skipBoardSpecs: true, corrections: NO_FIX, models: [], output, delayMs: 0, log() {}, discoveryQueries: [], affiliate: {}, ramSpecs: [spec, RAM_SPECS.find(s => s.type === 'DDR4')]});
  assert.equal(code, 0);
  const data = JSON.parse(fs.readFileSync(output, 'utf8'));
  const ram = data.products.filter(p => p.category === 'ram');
  assert.deepEqual(ram.map(p => [p.modelName, p.price, p.spec.cl, p.spec.kit]), [['DDR5-6000 32GB（16GB×2）', 21000, 36, '16GB×2']]);
  assert.deepEqual(data.unmatched.filter(u => u.category === 'ram').map(u => u.reason), ['規格が一致する新品キットの出品なし']);
});

test('sheet specs are checked against the committed reference and only real differences are reported', () => {
  const {checkSpecs} = require('../scripts/lib/spec-check');
  const rows = [
    {category: 'cpu', sheetName: 'Ryzen 7 7700', cores: 8, threads: 16, tdp: 105, clockMin: 4.5, clockMax: 5.4, cache: 32},   // 7700X の値が入った行
    {category: 'cpu', sheetName: 'Ryzen 7 7700X', cores: 8, threads: 16, tdp: 105, clockMin: 4.5, clockMax: 5.4, cache: 32},
    {category: 'cpu', sheetName: 'AMD Ryzen 7 7700X3D', cores: 8, threads: 16, tdp: 120, clockMin: 4.0, clockMax: 4.5, cache: 96},
    {category: 'cpu', sheetName: 'Core i9-12900T', cores: 12, threads: 20, tdp: 35, clockMin: 1.4, clockMax: 5.1, cache: 30},
    {category: 'cpu', sheetName: 'Core Ultra 9 285', cores: 24, threads: 24, tdp: 65, clockMin: 2.5, clockMax: 5.6, cache: 36}, // 最大クロックは照合しない世代
    {category: 'cpu', sheetName: 'Ryzen 5 3500G', cores: 4, threads: 8, tdp: 65, clockMin: 4, clockMax: 4.2, cache: 16},
    {category: 'gpu', sheetName: 'GeForce RTX 5080', vram: '16GB', bw: '2063GB/s', tdp: 360},
    {category: 'gpu', sheetName: 'GeForce RTX 4070 Ti SUPER', vram: '16GB', bw: '672GB/s', tdp: 285},
    {category: 'gpu', sheetName: 'Radeon RX 6750 XT', vram: '12GB', bw: '5538MB/s', tdp: 250},
    {category: 'gpu', sheetName: 'Radeon RX 6500 XT 4GB', vram: '4GB', bw: '144GB/s', tdp: 107},   // 照合表にない容量の版は指摘しない
    {category: 'gpu', sheetName: 'Radeon RX 9060 XT 8GB', vram: '8GB', bw: '320GB/s', tdp: 150},
    {category: 'gpu', sheetName: 'GeForce RTX 3060 Ti', vram: '8GB', bw: '448GB/s', tdp: 200},
  ];
  const issues = Object.fromEntries(checkSpecs(rows).map(i => [i.modelName, i.issue]));
  assert.deepEqual(Object.keys(issues).sort(), ['Core i9-12900T', 'GeForce RTX 5080', 'Radeon RX 6750 XT', 'Ryzen 5 3500G', 'Ryzen 7 7700'].sort());
  assert.match(issues['Ryzen 7 7700'], /TDP 105W → 出典 65W.*AMD公式/);
  assert.match(issues['Core i9-12900T'], /コア数 12 → 出典 16/);
  assert.match(issues['GeForce RTX 5080'], /帯域幅 2063GB\/s → 出典 960GB\/s/);
  assert.match(issues['Radeon RX 6750 XT'], /帯域幅 5\.538GB\/s → 出典 432GB\/s/);
  assert.match(issues['Ryzen 5 3500G'], /照合表にない型番/);
});

test('Blender Open Data names map to site models, with sample and laptop filters', () => {
  const {cpuModel, gpuKey, scoresFor} = require('../scripts/lib/blender');
  assert.equal(cpuModel('AMD Ryzen 7 7800X3D 8-Core Processor'), 'Ryzen 7 7800X3D');
  assert.equal(cpuModel('AMD Ryzen 7 PRO 4750G with Radeon Graphics'), 'Ryzen 7 PRO 4750G');
  assert.equal(cpuModel('13th Gen Intel(R) Core(TM) i5-13600K'), 'Core i5-13600K');
  assert.equal(cpuModel('Intel(R) Core(TM) Ultra 7 270K Plus'), 'Core Ultra 7 270K Plus');
  assert.equal(cpuModel('13th Gen Intel Core i3-1315U'), null);              // ノート向け
  assert.equal(cpuModel('AMD Ryzen 7 8845HS w/ Radeon 780M Graphics'), null);
  assert.equal(gpuKey('NVIDIA GeForce RTX 4070 SUPER'), 'GEFORCE RTX 4070 SUPER');
  assert.equal(gpuKey('Intel Arc A750 Graphics'), 'ARC A750');
  assert.equal(gpuKey('NVIDIA GeForce RTX 4070 Laptop GPU'), null);
  assert.equal(gpuKey('AMD Radeon 780M'), null);
  const cpu = scoresFor('cpu', [
    {device: 'AMD Ryzen 7 7800X3D 8-Core Processor', type: 'CPU', score: 293.17, count: 116},
    {device: 'AMD Ryzen 7 7800X3D', type: 'CPU', score: 310, count: 2},          // 測定数が少ない
    {device: 'Intel Core i5-14600', type: 'CPU', score: 300, count: 5},          // 14600K と取り違えない
    {device: 'Intel Core i5-14600K', type: 'CPU', score: 330, count: 40},
  ], ['Ryzen 7 7800X3D', 'Core i5-14600K']);
  assert.deepEqual(Object.entries(cpu).map(([k, v]) => [k, v.score, v.samples]), [['Core i5-14600K', 330, 40], ['Ryzen 7 7800X3D', 293.17, 116]]);
  const gpu = scoresFor('gpu', [
    {device: 'NVIDIA GeForce RTX 4070', type: 'CUDA', score: 3000, count: 50},
    {device: 'NVIDIA GeForce RTX 4070', type: 'OPTIX', score: 5000, count: 80},  // 速い方式を使う
    {device: 'NVIDIA GeForce RTX 4070 Ti', type: 'OPTIX', score: 6000, count: 80},
    {device: 'NVIDIA TITAN V', type: 'OPTIX', score: 2000, count: 9},
  ], ['GeForce RTX 4070', 'NVIDIA TITAN V']);
  assert.deepEqual(Object.entries(gpu).map(([k, v]) => [k, v.score, v.computeType]), [['GeForce RTX 4070', 5000, 'OPTIX'], ['NVIDIA TITAN V', 2000, 'OPTIX']]);
});

test('product pages show only known values, skip empty products and escape names', () => {
  const {buildData, productPage, slug} = require('../scripts/build-pages');
  const now = new Date('2026-11-14T00:00:00Z');
  const rows = [
    {category: 'cpu', name: 'Ryzen 7 7800X3D', maker: 'AMD', score: 34000, cores: 8, threads: 16, clockMin: 4.2, clockMax: 5, cache: 96, tdp: 120, socket: 'AM5'},
    {category: 'cpu', name: 'Ryzen 5 7600X', maker: 'AMD', score: 28000, cores: 6, threads: 12},
    {category: 'cpu', name: 'Core i5-14600', maker: 'Intel', score: 0},                      // スコアも価格もない
    {category: 'cpu', name: 'Core Ultra 7 270K Plus', maker: 'Intel', score: 0},             // Blender だけある
    {category: 'gpu', name: '<script>x</script>', maker: 'Other', score: 1000},
  ];
  const prices = [{category: 'cpu', modelName: 'Ryzen 7 7800X3D', status: 'ok', price: 53280, fetchedAt: '2026-11-13T11:00:00Z', url: 'https://store.shopping.yahoo.co.jp/a/1.html', source: 'Yahoo!ショッピング', shopName: 'A店'},
    {category: 'cpu', modelName: 'Ryzen 5 7600X', status: 'ok', price: 30000, fetchedAt: '2026-10-01T00:00:00Z', url: 'https://x/1'}]; // 古い価格は使わない
  const blender = {cpu: {blenderVersion: '4.5.0', scores: {'Core Ultra 7 270K Plus': {score: 611.1, samples: 20}}}};
  const data = buildData(rows, prices, blender, now);
  assert.deepEqual(data.cpu.map(x => x.name), ['Ryzen 7 7800X3D', 'Ryzen 5 7600X', 'Core Ultra 7 270K Plus']);
  assert.equal(data.cpu[1].offer, null);
  const html = productPage(data.cpu[0], data.cpu, '2026/11/14');
  assert.match(html, /<title>Ryzen 7 7800X3D の最安値と性能/);
  assert.match(html, /¥53,280/);
  assert.match(html, /rel="sponsored noopener"/);
  assert.match(html, /2製品中 1 位/);
  assert.match(html, /href="\/p\/ryzen-5-7600x.html"/);
  assert.match(productPage(data.cpu[2], data.cpu, '2026/11/14'), /Blender Benchmark（Blender 4.5.0）<\/th><td>611.1（1製品中 1 位・測定 20 件/);
  const evil = productPage(data.gpu[0], data.gpu, '2026/11/14');
  assert.ok(!evil.includes('<script>x'));
  assert.equal(slug('GeForce RTX 4070 Ti SUPER'), 'geforce-rtx-4070-ti-super');
});

test('PSU and SSD listings are read strictly and grouped by maker with the 2-shop rule', () => {
  const {parsePsu, parseSsd, pickByMaker, PSU_SPECS, SSD_SPECS} = require('../scripts/lib/parts');
  assert.deepEqual(parsePsu('Corsair RM850e (2025) 850W 80PLUS GOLD ATX3.1 電源ユニット'), {watts: 850, rating: 'Gold', maker: 'Corsair', atx3: true});
  assert.deepEqual(parsePsu('MSI MAG A850GL PCIE5 850W 80PLUS Gold ATX3.1 12V-2x6 600W対応 電源ユニット'), {watts: 850, rating: 'Gold', maker: 'MSI', atx3: true});
  assert.equal(parsePsu('ノーブランド 電源ユニット 650W 80PLUS BRONZE ATX').maker, 'その他');
  for (const t of ['SilverStone SX750 SFX 750W 80PLUS Platinum 電源', '12V-2x6 ケーブル 600W 電源用', 'Antec NE850G 850W GOLD',
    '電源ユニット 750W 850W 80PLUS GOLD 選べる', '【中古】Corsair RM850x 850W 80PLUS GOLD 電源', 'Seasonic Corsair 850W 80PLUS Gold 電源']) assert.equal(parsePsu(t), null, t);
  assert.deepEqual(parseSsd('Samsung 990 PRO 2TB PCIe 4.0 NVMe M.2 SSD'), {type: 'Gen4', capacity: 2000, maker: 'Samsung'});
  assert.deepEqual(parseSsd('WD_BLACK SN850X 2TB NVMe M.2 2280 PCIe Gen4 SSD'), {type: 'Gen4', capacity: 2000, maker: 'WD'});
  assert.deepEqual(parseSsd('Samsung 870 EVO 1TB SATA 2.5インチ 内蔵 SSD'), {type: 'SATA', capacity: 1000, maker: 'Samsung'});
  assert.equal(parseSsd('Hanye 2TB NVMe Gen4 SSD M.2 2280').maker, 'その他');
  for (const t of ['Crucial X9 1TB ポータブルSSD USB-C', 'Samsung 990 PRO 1TB 2TB 4TB 選べる NVMe Gen4', 'WD Blue SN5000 500GB NVMe Gen4 M.2 2230 SSD',
    'Crucial P3 Plus 1TB NVMe M.2 SSD', 'Samsung 990 EVO Plus 8TB NVMe Gen4 SSD']) assert.equal(parseSsd(t), null, t);
  const spec = PSU_SPECS.find(s => s.key === '850W Gold');
  const it = (name, price, shop) => ({itemCode: shop + price, itemName: name, itemPrice: price, availability: 1, shopName: shop});
  const picks = pickByMaker(spec, [
    it('Corsair RM850e 850W 80PLUS GOLD 電源ユニット', 15800, 'a'), it('Corsair RM850x 850W 80PLUS GOLD 電源ユニット', 19800, 'b'),
    it('玄人志向 KRPW-GA850W 850W 80PLUS GOLD 電源', 12800, 'a'),                          // 1店だけ
    it('ノーブランド 電源ユニット 850W 80PLUS GOLD', 6000, 'c'), it('ノーブランド 電源ユニット 850W 80PLUS GOLD', 6500, 'd'),
    it('Corsair 850W 80PLUS GOLD 電源 ケーブルのみ', 3000, 'e'),
    it('Corsair RM750e 750W 80PLUS GOLD 電源ユニット', 13000, 'f'),                        // 容量違い
  ]);
  assert.deepEqual(picks.map(p => [p.maker, p.item.itemPrice, p.shops]), [['その他', 6000, 2], ['Corsair', 15800, 2]]);
  assert.ok(SSD_SPECS.some(s => s.key === 'Gen4 2TB') && PSU_SPECS.length === 15);
});

test('motherboard listings are read by chipset, size and memory without guessing', () => {
  const {parseMb, MB_SPECS} = require('../scripts/lib/parts');
  assert.deepEqual(parseMb('MSI PRO B650M-A WIFI マザーボード Micro ATX AM5 DDR5'), {chipset: 'B650', form: 'mATX', socket: 'AM5', memory: 'DDR5', maker: 'MSI', wifi: true});
  assert.deepEqual(parseMb('ASUS ROG STRIX B650E-F GAMING WIFI ATX マザーボード AM5'), {chipset: 'B650E', form: 'ATX', socket: 'AM5', memory: 'DDR5', maker: 'ASUS', wifi: true});
  assert.deepEqual(parseMb('ASRock B760M Pro RS/D4 Micro ATX マザーボード DDR4'), {chipset: 'B760', form: 'mATX', socket: 'LGA1700', memory: 'DDR4', maker: 'ASRock', wifi: false});
  assert.deepEqual(parseMb('ASRock B650I Lightning WiFi Mini-ITX マザーボード'), {chipset: 'B650', form: 'ITX', socket: 'AM5', memory: 'DDR5', maker: 'ASRock', wifi: true});
  for (const t of ['MSI MAG B760 TOMAHAWK WIFI マザーボード',          // LGA1700 でメモリの種類もサイズも書かれていない
    'MSI B650 / B650M 選べる マザーボード', 'Ryzen 7 7800X3D + B650M マザーボード セット', 'ASRock X870E Taichi E-ATX マザーボード',
    'GIGABYTE B650M AORUS ELITE マザーボード ATX',                       // 型番と表記のサイズが食い違う
    'ASUS PRIME B650M-A マザーボード DDR4']) assert.equal(parseMb(t), null, t); // AM5 なのに DDR4
  assert.equal(MB_SPECS.length, 30);
  assert.ok(MB_SPECS.every(s => s.order >= 0));
});

test('corrections from the sheet exclude items and fix makers, and broken input is ignored', async () => {
  const {toCorrections, parseCsv, loadCorrections} = require('../scripts/lib/corrections');
  assert.deepEqual(parseCsv('"a","b,c"\n"1","x""y"\n'), [['a', 'b,c'], ['1', 'x"y']]);
  const fixTab = '"商品コード","種類","商品名","除外する","正しいメーカー"\n"yahoo:a_1","SSD","x","FALSE","Micron"\n"yahoo:b_1","電源","y","TRUE",""\n"yahoo:c_1","電源","z","FALSE",""\n';
  const listTab = '"種類","商品コード","除外する","正しいメーカー"\n"SSD","yahoo:a_1","TRUE",""\n"SSD","yahoo:d_1","TRUE",""\n';
  const c = toCorrections([fixTab, listTab]);
  assert.deepEqual([[...c.exclude].sort(), [...c.maker]], [['yahoo:b_1', 'yahoo:d_1'], [['yahoo:a_1', 'Micron']]]); // 修正タブが優先
  const {pickByMaker, PSU_SPECS} = require('../scripts/lib/parts');
  const spec = PSU_SPECS.find(s => s.key === '850W Gold');
  const it = (code, name, price, shop) => ({itemCode: code, itemName: name, itemPrice: price, availability: 1, shopName: shop});
  const picks = pickByMaker(spec, [it('x1', 'ノーブランド 電源ユニット 850W 80PLUS GOLD', 9000, 'a'), it('x2', 'ノーブランド 電源ユニット 850W 80PLUS GOLD', 9500, 'b')], new Map([['x1', 'Seasonic'], ['x2', 'Seasonic']]));
  assert.deepEqual(picks.map(p => p.maker), ['Seasonic']);
  // 読めないときは修正なし
  const none = await loadCorrections('1WNmHp843qaR6U8KZIYo-fmSj9JAJErzJjoT_KZil5tA', async () => ({ok: true, text: async () => '<html>login</html>'}));
  assert.deepEqual([none.ok, none.exclude.size], [false, 0]);
  assert.equal((await loadCorrections('bad id', async () => assert.fail('no fetch'))).ok, false);
});

test('per-board specs come from the sheet tab, keyed by a model string of 5+ characters', () => {
  const {toBoardSpecs} = require('../scripts/lib/corrections');
  const csv = '"型番","M.2","背面USB","メモ"\n"PRO B650M-A WIFI","2","8","x"\n"B650","9","9",""\n"TUF GAMING B650-PLUS","",""\n"pro b650m-a wifi","3","3",""\n';
  assert.deepEqual(toBoardSpecs(csv), {columns: ['M.2', '背面USB'], boards: [{model: 'PRO B650M-A WIFI', fields: {'M.2': '2', '背面USB': '8'}}]});
  assert.deepEqual(toBoardSpecs('"名前","M.2"\n"x","1"\n'), {columns: [], boards: []});
});
