'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {modelSpec, pickItem, parseGpu, parseCpu} = require('../scripts/lib/match');
const {main} = require('../scripts/update-rakuten-prices');

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
  const code = await main(env, fetchImpl, {models, output, delayMs: 0, log: line => logs.push(line), now: new Date('2026-11-11T00:00:00Z'), discoveryQueries: []});
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
  const code = await main(env, async () => ({ok: false, status: 503}), {models, output, delayMs: 0, log() {}});
  assert.equal(code, 1);
  assert.match(fs.readFileSync(output, 'utf8'), /"price":1/);
  assert.equal(await main({}, async () => assert.fail('no network without credentials'), {models, output, log() {}}), 1);
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
  assert.equal(await main(env, fetchImpl, {models, output, delayMs: 0, log() {}, discoveryQueries: []}), 0);
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
  assert.deepEqual([parsed[0].name, parsed[0].sheetName, parsed[0].maker, parsed[0].dlss], ['Radeon RX 6700 XT', 'GeForce RTX 6700 XT', 'AMD', 'FSR 2']);
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
        ? [{code: 'shop_1', name: 'ASUS GeForce RTX 5070 12G', price: 105000, inStock: true, condition: 'new', url: 'https://store.shopping.yahoo.co.jp/shop/1.html', point: {amount: 1050}, seller: {name: 'Yショップ'}},
           {code: 'shop_2', name: 'GeForce RTX 5070 12G 中古', price: 70000, inStock: true, condition: 'used', url: 'https://store.shopping.yahoo.co.jp/shop/2.html'}]
        : []})};
    }
    const keyword = url.searchParams.get('keyword');
    return {ok: true, json: async () => ({Items: keyword === 'RTX 5070' ? [item('MSI GeForce RTX 5070 12G', 111000, {pointRate: 5})] : keyword === 'Ryzen 5600' ? [item('AMD Ryzen 5 5600 BOX', 9980)] : []})};
  };
  assert.equal(await main(env, fetchImpl, {models, output, delayMs: 0, log() {}, discoveryQueries: ['x']}), 0);
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
  let code = await main({YAHOO_CLIENT_ID: 'y'}, async url => { if (url.hostname !== 'shopping.yahooapis.jp') { rakutenCalls++; return {ok: false, status: 500}; } return yahooHit(url); }, {models, output, delayMs: 0, log() {}, discoveryQueries: ['q']});
  assert.equal(code, 0);
  assert.equal(rakutenCalls, 0);
  let data = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(data.stores, ['Yahoo!ショッピング']);
  assert.deepEqual(data.products.map(p => [p.source, p.price]), Array(5).fill(['Yahoo!ショッピング', 99000]));
  // 楽天が障害中: 3回で打ち切り、Yahoo の価格で更新する
  rakutenCalls = 0;
  const logs = [];
  code = await main({RAKUTEN_APPLICATION_ID: 'a', RAKUTEN_ACCESS_KEY: 'b', RAKUTEN_AFFILIATE_ID: 'c', YAHOO_CLIENT_ID: 'y'},
    async url => { if (url.hostname !== 'shopping.yahooapis.jp') { rakutenCalls++; return {ok: false, status: 503}; } return yahooHit(url); }, {models, output, delayMs: 0, log: l => logs.push(l), discoveryQueries: []});
  assert.equal(code, 0);
  assert.equal(rakutenCalls, 3);
  data = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual([data.stores, data.products.length], [['Yahoo!ショッピング'], 5]);
  assert.ok(logs.some(l => l.includes('この回は楽天を使いません')));
  // どちらも落ちているときは前回のファイルを残す
  const before = fs.readFileSync(output, 'utf8');
  code = await main({RAKUTEN_APPLICATION_ID: 'a', RAKUTEN_ACCESS_KEY: 'b', RAKUTEN_AFFILIATE_ID: 'c', YAHOO_CLIENT_ID: 'y'}, async () => ({ok: false, status: 503}), {models, output, delayMs: 0, log() {}, discoveryQueries: []});
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
  let code = await main({YAHOO_CLIENT_ID: 'y'}, async url => (++calls % 3 === 0 ? limited : ok(url)), {models, output, delayMs: 0, log() {}, discoveryQueries: []});
  assert.equal(code, 0);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).products.length, 5);
  // 途中から 429 が続いても、それまでに取れた分は保存する
  calls = 0;
  fs.rmSync(output);
  code = await main({YAHOO_CLIENT_ID: 'y'}, async url => (++calls <= 2 ? ok(url) : limited), {models, output, delayMs: 0, log() {}, discoveryQueries: []});
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
  await main({YAHOO_CLIENT_ID: 'y'}, async url => { seen.push(Object.fromEntries(url.searchParams)); return {ok: true, json: async () => ({hits: []})}; }, {models, output, delayMs: 0, log() {}, discoveryQueries: []});
  assert.deepEqual([seen[0].sort, seen[0].price_from, seen[0].price_to, seen[0].results], ['+price', '40600', '104400', '50']);
  assert.equal(seen[1].sort, undefined);
  const {modelSpec: spec, pickItem: pick} = require('../scripts/lib/match');
  for (const name of ['箱難あり品 Intel CPU Core i7-14700F BOX', 'AMD Ryzen5 5600 企業向けバルク品']) {
    const model = name.includes('14700F') ? 'Core i7-14700F' : 'Ryzen 5 5600';
    assert.equal(pick(spec('cpu', model), [{itemCode: 'a:1', itemName: name, itemPrice: 30000, availability: 1}], 30000, 'cpu').item, undefined, name);
  }
});
