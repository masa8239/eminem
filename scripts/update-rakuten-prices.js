'use strict';

// 楽天市場から CPU / GPU の価格を自動取得して data/rakuten-prices.json に保存する。
// GitHub Actions から1日1回実行する想定（.github/workflows/update-prices.yml）。
// 認証情報・リクエストURL・例外の詳細は出力しない。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {searchItems, responseItems, SITE_ORIGIN, PriceError} = require('../api/rakuten-prices')._test;
const {modelSpec, pickItem, discoverNewModels, PRICE_FLOOR} = require('./lib/match');
const {searchYahoo, rakutenPoints} = require('./lib/stores');
const {nameIssue} = require('./lib/audit');
const {RAM_SPECS, ramQueries, pickRamOffers} = require('./lib/ram');
const {checkSpecs} = require('./lib/spec-check');
const {fetchBlenderScores} = require('./lib/blender');
const {PSU_SPECS, SSD_SPECS, MB_SPECS, pickByMaker} = require('./lib/parts');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'rakuten-prices.json');
const AUDIT_OUTPUT = path.join(ROOT, 'data', 'sheet-audit.json');
const NEW_OUTPUT = path.join(ROOT, 'data', 'new-products.json');
const HISTORY_OUTPUT = path.join(ROOT, 'data', 'price-history.json');
const BLENDER_OUTPUT = path.join(ROOT, 'data', 'blender-scores.json');
const HISTORY_DAYS = 180;

function readAffiliateConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'affiliate.json'), 'utf8')); } catch { return {}; }
}
// 新着を探すための追加検索（新しい順）
const DISCOVERY_QUERIES = ['GeForce RTX グラフィックボード', 'Radeon RX グラフィックボード', 'Ryzen CPU BOX', 'Core Ultra CPU BOX'];
const FALLBACK_ORIGINS = ['https://eminem-zfet.vercel.app'];
const KEEP_PREVIOUS_MS = 6 * 24 * 60 * 60 * 1000;

// index.html の内蔵データとパーサーをそのまま使い、サイトと同じモデル名・参考価格を得る
function siteContext() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const elements = new Map();
  const document = {addEventListener() {}, getElementById(id) {
    if (!elements.has(id)) elements.set(id, {value: '', innerHTML: '', textContent: '', style: {}});
    return elements.get(id);
  }};
  const context = vm.createContext({document, window: {addEventListener() {}}, localStorage: {getItem() { return null; }}, URL, URLSearchParams, console});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1].split('// ===== INIT =====')[0], context);
  return {context, run: code => vm.runInContext(code, context)};
}

async function loadModels(fetchImpl) {
  const {context, run} = siteContext();
  const models = new Map();
  const sheetRows = [];
  const specRows = []; // スコアの有無に関係なく、シートの全行（仕様の照合用）
  const add = (category, item) => {
    if (!item || typeof item.name !== 'string' || !item.name.trim()) return;
    const key = `${category}\0${item.name}`;
    const price = Number.isSafeInteger(item.price) && item.price > 0 ? item.price : null;
    // シートの有効な価格を優先し、なければ内蔵データの価格を参考価格にする
    if (!models.has(key) || (price && !models.get(key).fromSheet)) {
      models.set(key, {category, modelName: item.name, referencePrice: price ?? models.get(key)?.referencePrice ?? null, fromSheet: models.get(key)?.fromSheet || false});
    }
  };
  JSON.parse(run('JSON.stringify(FALLBACK_CPU)')).forEach(item => add('cpu', item));
  JSON.parse(run('JSON.stringify(FALLBACK_GPU)')).forEach(item => add('gpu', item));
  for (const [category, urlName, parser] of [['cpu', 'CPU_GAS_URL', 'parseCpuRow'], ['gpu', 'GPU_GAS_URL', 'parseGpuRow']]) {
    try {
      const response = await fetchImpl(run(urlName), {signal: AbortSignal.timeout(20000)});
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('bad payload');
      context.__rows = rows;
      JSON.parse(run(`JSON.stringify(__rows.map(${parser}).filter(r=>r&&r.name&&isStandalone('${category}',r.name)))`)).forEach(item => specRows.push({...item, category}));
      JSON.parse(run(`JSON.stringify(__rows.map(${parser}).filter(r=>r&&r.name&&isStandalone('${category}',r.name)))`)).forEach(item => {
        const key = `${category}\0${item.name}`;
        const price = Number.isSafeInteger(item.price) && item.price > 0 ? item.price : null;
        sheetRows.push({category, sheetName: item.sheetName || item.name, modelName: item.name, priceValid: price !== null});
        if (models.get(key)?.fromSheet) return; // 同名の行は最初（シート上で上）の1件を使う
        const builtin = models.get(key)?.referencePrice ?? null;
        models.set(key, {category, modelName: item.name, referencePrice: price ?? builtin, fromSheet: true, sheetPriceValid: price !== null});
      });
    } catch {
      console.log(`${category}: スプレッドシートを取得できなかったため内蔵データのモデル名を使います`);
    }
  }
  const list = [...models.values()];
  list.sheetRows = sheetRows;
  list.specRows = specRows;
  return list;
}

function safeUrl(item) {
  try {
    const url = new URL(item.affiliateUrl || item.itemUrl);
    // Yahoo!ショッピングのアフィリエイトURL（バリューコマース）は http で返るので https にして使う
    if (url.protocol === 'http:' && /(^|\.)valuecommerce\.com$/.test(url.hostname)) url.protocol = 'https:';
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function readPrevious(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.products) ? data.products : [];
  } catch { return []; }
}

async function main(env = process.env, fetchImpl = fetch, options = {}) {
  const log = options.log || console.log;
  const output = options.output || OUTPUT;
  const delayMs = options.delayMs ?? 1100;
  const now = options.now || new Date();
  const names = ['RAKUTEN_APPLICATION_ID', 'RAKUTEN_ACCESS_KEY', 'RAKUTEN_AFFILIATE_ID'];
  const missing = names.filter(name => !env[name]);
  // auditOnly: 楽天には問い合わせず、スプレッドシートの要確認リストだけ更新する（キー不要）
  const auditOnly = Boolean(options.auditOnly);
  // 楽天のキー3つがそろっていれば楽天を、YAHOO_CLIENT_ID があれば Yahoo!ショッピングを使う。どちらか片方だけでも動く
  const rakuten = {on: !missing.length, configured: !missing.length, failures: 0};
  if (!rakuten.configured && !env.YAHOO_CLIENT_ID && !auditOnly) { log(`ストアの認証情報が未設定です（楽天: ${missing.join(', ')} / Yahoo: YAHOO_CLIENT_ID）`); return 1; }

  const credentials = {applicationId: env[names[0]], accessKey: env[names[1]], affiliateId: env[names[2]], origin: env.RAKUTEN_SITE_ORIGIN || SITE_ORIGIN};
  const models = options.models || await loadModels(fetchImpl);
  const byCategory = category => models.filter(model => model.category === category).map(model => model.modelName);
  const previous = new Map(readPrevious(output).map(product => [`${product.category}\0${product.modelName}`, product]));
  const fetchedAt = now.toISOString();
  const origins = [credentials.origin, ...FALLBACK_ORIGINS.filter(origin => origin !== credentials.origin)];

  const products = [], unmatched = [];
  const searchCache = new Map();
  // Yahoo!ショッピングは Client ID があるときだけ使う。失敗が続いたらその回は使わない
  const affiliate = options.affiliate || readAffiliateConfig();
  const yahoo = {appid: env.YAHOO_CLIENT_ID || '', affiliateId: String(affiliate.yahooValueCommerceId || '').trim(), cache: new Map(), failures: 0, successes: 0};
  // Yahoo は短時間に問い合わせすぎると 429 を返すので、間隔を空け、429 のときは待ってからやり直す
  const yahooDelay = options.yahooDelayMs ?? (delayMs ? 2000 : 0);
  const yahooBackoff = options.yahooBackoffMs ?? (delayMs ? [20000, 60000, 120000] : [0, 0, 0]);
  const wait = ms => ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
  const yahooItems = async (keyword, range = null) => {
    if (!yahoo.appid || yahoo.failures >= 3) return null;
    const cacheKey = range ? `${keyword}\0${range.from}\0${range.to}\0${range.start || 1}\0${range.results || 50}` : keyword;
    if (yahoo.cache.has(cacheKey)) return yahoo.cache.get(cacheKey);
    try {
      await wait(yahooDelay);
      let found;
      for (let attempt = 0; ; attempt++) {
        try { found = await searchYahoo(keyword, yahoo.appid, fetchImpl, range, yahoo.affiliateId); break; }
        catch (error) {
          if (error.status !== 429 || attempt >= yahooBackoff.length) throw error;
          if (attempt === 0) log(`Yahoo!ショッピングの問い合わせ回数の上限に達したため、少し待ってから続けます（${keyword}）`);
          await wait(yahooBackoff[attempt]);
        }
      }
      yahoo.cache.set(cacheKey, found); yahoo.failures = 0; yahoo.successes++;
      return found;
    } catch (error) {
      yahoo.failures++;
      if (yahoo.failures <= 3) log(`Yahoo!ショッピング検索に失敗（${keyword}）: ${String(error && error.message || error).split(yahoo.appid).join('[appid]')}`);
      if (yahoo.failures === 3) log('Yahoo!ショッピングに続けて接続できないため、この回は Yahoo を使いません');
      return null;
    }
  };
  let apiErrors = 0, attempted = 0, first = true;
  log(`使うストア: ${[rakuten.configured && '楽天市場', yahoo.appid && 'Yahoo!ショッピング'].filter(Boolean).join('・') || 'なし'}`);
  for (const model of auditOnly ? [] : models) {
    const spec = modelSpec(model.category, model.modelName, byCategory(model.category));
    if (!spec) { unmatched.push({category: model.category, modelName: model.modelName, reason: '型番を判定できないモデル名'}); continue; }
    let items = rakuten.on ? (searchCache.get(spec.keyword) || null) : [];
    let rakutenError = null;
    if (!items && !first && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (!items) attempted++;
    try {
      if (!items) {
        try {
          items = responseItems(await searchItems({keyword: spec.keyword, hits: 30}, credentials, fetchImpl));
        } catch (error) {
          // 許可サイトの登録が旧URLのままの場合に備え、最初の1回だけ旧URLでも試す
          if (!(first && error instanceof PriceError && /HTTP 403/.test(error.message))) throw error;
          for (const origin of origins.slice(1)) {
            try {
              items = responseItems(await searchItems({keyword: spec.keyword, hits: 30}, {...credentials, origin}, fetchImpl));
              credentials.origin = origin;
              log(`許可サイトが旧URL（${origin}）のままです。楽天のアプリ設定を新しいURLに更新してください`);
              break;
            } catch { /* 次の候補へ */ }
          }
          if (!items) throw error;
        }
      }
      if (rakuten.on) { searchCache.set(spec.keyword, items); rakuten.failures = 0; }
    } catch (error) {
      apiErrors++;
      rakutenError = error instanceof PriceError ? error.message : '楽天APIへの接続に失敗';
      items = [];
      // 続けて失敗したら、この回は楽天を使わない（障害中に全モデルでタイムアウトを待たない）
      if (++rakuten.failures >= 3 && rakuten.on) { rakuten.on = false; log('楽天APIに続けて接続できないため、この回は楽天を使いません'); }
    }
    first = false;
    const offers = [];
    const picked = pickItem(spec, items, model.referencePrice, model.category);
    const url = picked.item && safeUrl(picked.item);
    if (picked.item && url) offers.push({
      store: '楽天市場', price: picked.item.itemPrice, points: rakutenPoints(picked.item), url,
      itemCode: picked.item.itemCode, itemName: picked.item.itemName,
      shopName: typeof picked.item.shopName === 'string' ? picked.item.shopName : '',
    });
    // 参考価格があるモデルは、ありえる価格帯に絞って安い順に取る（関連度順だと最安の出品を取りこぼす）
    const ref = Number.isSafeInteger(model.referencePrice) && model.referencePrice > 0 ? model.referencePrice : 0;
    const range = ref ? {from: Math.max(PRICE_FLOOR[model.category] || 0, Math.round(ref * 0.7)), to: Math.round(ref * 1.8)} : null;
    const yItems = await yahooItems(spec.keyword, range);
    const yPicked = yItems && pickItem(spec, yItems, model.referencePrice, model.category);
    const yUrl = yPicked && yPicked.item && safeUrl(yPicked.item);
    if (yUrl) offers.push({
      store: 'Yahoo!ショッピング', price: yPicked.item.itemPrice, points: yPicked.item.points || 0, url: yUrl,
      itemCode: yPicked.item.itemCode, itemName: yPicked.item.itemName, shopName: yPicked.item.shopName || '',
    });
    if (!offers.length) {
      // ストア側の失敗で取れなかったときは、前回の価格を数日間は引き継ぐ
      const kept = previous.get(`${model.category}\0${model.modelName}`);
      const storeFailed = rakutenError || (rakuten.configured && !rakuten.on) || (yahoo.appid && !yItems);
      if (storeFailed && kept && kept.status === 'ok' && now - new Date(kept.fetchedAt) < KEEP_PREVIOUS_MS) products.push(kept);
      else unmatched.push({category: model.category, modelName: model.modelName, reason: rakutenError || (yItems || rakuten.on ? picked.reason : null) || '一致する新品単品の出品なし'});
      continue;
    }
    // 表示価格は一番安いストア。他ストアの価格も offers に残す
    offers.sort((a, b) => a.price - b.price);
    const best = offers[0];
    products.push({
      category: model.category, modelName: model.modelName, status: 'ok', source: best.store,
      price: best.price, points: best.points, url: best.url, fetchedAt,
      itemCode: best.itemCode, itemName: best.itemName, shopName: best.shopName,
      offers: offers.map(offer => ({store: offer.store, price: offer.price, points: offer.points, url: offer.url})),
    });
  }

  // メモリ: 規格ごとに Yahoo!ショッピングの最安キットを探す（製品名ではなく規格で並べる）
  let ramFound = 0;
  for (const spec of auditOnly || options.skipRam ? [] : (options.ramSpecs || RAM_SPECS)) {
    const items = [];
    let anyResponse = false;
    for (const query of ramQueries(spec)) {
      const found = await yahooItems(query, {from: spec.capacity * 80, to: 0});
      if (found) { anyResponse = true; items.push(...found); }
    }
    const offers = pickRamOffers(spec, items);
    const ramSpec = {type: spec.type, speed: spec.speed, capacity: spec.capacity, kit: `${spec.perStick}GB×${spec.sticks}`};
    if (!offers.length) {
      const kept = previous.get(`ram\0${spec.label}`);
      if (!anyResponse && kept && kept.status === 'ok' && now - new Date(kept.fetchedAt) < KEEP_PREVIOUS_MS) products.push(kept);
      else unmatched.push({category: 'ram', modelName: spec.label, reason: anyResponse ? '規格が一致する新品キットの出品なし' : 'Yahoo!ショッピングに接続できませんでした'});
      continue;
    }
    const rows = offers.map(item => ({item, url: safeUrl(item)})).filter(row => row.url);
    if (!rows.length) { unmatched.push({category: 'ram', modelName: spec.label, reason: '商品ページのURLが不正'}); continue; }
    const best = rows[0].item;
    ramFound++;
    products.push({
      category: 'ram', modelName: spec.label, status: 'ok', source: 'Yahoo!ショッピング',
      price: best.itemPrice, points: best.points || 0, url: rows[0].url, fetchedAt,
      itemCode: best.itemCode, itemName: best.itemName, shopName: best.shopName || '',
      spec: {...ramSpec, cl: best.cl},
      offers: rows.map(({item, url}) => ({store: item.shopName || 'Yahoo!ショッピング', price: item.itemPrice, points: item.points || 0, url, itemName: item.itemName, cl: item.cl})),
    });
  }

  // 電源・SSD・マザーボード: 規格ごとに、メーカー別の最安値を探す（安い順に200件まで見る）
  let partsFound = 0;
  for (const spec of auditOnly || options.skipParts ? [] : (options.partSpecs || [...PSU_SPECS, ...SSD_SPECS, ...MB_SPECS])) {
    const items = [];
    let anyResponse = false;
    for (const query of spec.queries) {
      for (const start of [1, 101]) {
        const found = await yahooItems(query, {from: spec.floor, to: 0, results: 100, start});
        if (found) { anyResponse = true; items.push(...found); }
        if (!found || found.length < 100) break;
      }
    }
    const picks = pickByMaker(spec, items).map(p => ({...p, url: safeUrl(p.item)})).filter(p => p.url);
    if (!picks.length) {
      // 店側の失敗で取れなかったときは、前回の価格を数日間は引き継ぐ
      const kept = [...previous.values()].filter(p => p.category === spec.category && p.spec && p.spec.key === spec.key && p.status === 'ok' && now - new Date(p.fetchedAt) < KEEP_PREVIOUS_MS);
      if (!anyResponse && kept.length) products.push(...kept);
      else unmatched.push({category: spec.category, modelName: spec.label, reason: anyResponse ? '規格が一致する新品を2店以上で確認できませんでした' : 'Yahoo!ショッピングに接続できませんでした'});
      continue;
    }
    for (const p of picks) {
      partsFound++;
      const {parsed} = p.item;
      products.push({
        category: spec.category, modelName: `${spec.label}｜${p.maker}`, status: 'ok', source: 'Yahoo!ショッピング',
        price: p.item.itemPrice, points: p.item.points || 0, url: p.url, fetchedAt,
        itemCode: p.item.itemCode, itemName: p.item.itemName, shopName: p.item.shopName || '',
        spec: {key: spec.key, label: spec.label, order: spec.order, maker: p.maker, shops: p.shops,
          ...(spec.category === 'psu' ? {watts: spec.watts, rating: spec.rating, atx3: Boolean(parsed.atx3)}
            : spec.category === 'ssd' ? {type: spec.type, capacity: spec.capacity}
            : {chipset: spec.chipset, form: spec.form, socket: spec.socket, memory: spec.memory})},
      });
    }
  }
  if (!auditOnly && !options.skipParts) log(`電源・SSD・マザーボード: ${partsFound} 件（規格×メーカー）`);

  if (!auditOnly) log(`対象 ${models.length} モデル / 取得 ${products.length - ramFound - partsFound} / 未取得 ${unmatched.filter(u => u.category !== 'ram').length} / API失敗 ${apiErrors}`);
  if (!auditOnly && !options.skipRam) log(`メモリ: ${(options.ramSpecs || RAM_SPECS).length} 規格のうち ${ramFound} 規格の最安値を取得`);
  // 1件も取れず、どのストアにも接続できなかった回だけは、前回のファイルを壊さない（途中まで取れた分は保存する）
  const rakutenUp = rakuten.configured && rakuten.on, yahooUp = Boolean(yahoo.appid) && yahoo.successes > 0;
  const freshCount = products.filter(product => product.fetchedAt === fetchedAt).length;
  // アフィリエイトIDを入れた回で1件も取れなかったら、リンクの形が想定と違う可能性が高い。前回のファイルを残す
  if (!auditOnly && yahoo.affiliateId && yahooUp && !rakutenUp && freshCount === 0) {
    log('アフィリエイトIDを使った検索で価格が1件も取れませんでした。リンクの形式を確認してください（今回は価格ファイルを更新しません）');
    return 1;
  }
  if (!auditOnly && !rakutenUp && !yahooUp && freshCount === 0) {
    log('どのストアにも接続できなかったため、今回は価格ファイルを更新しません');
    return 1;
  }
  fs.mkdirSync(path.dirname(output), {recursive: true});
  if (!auditOnly) fs.writeFileSync(output, JSON.stringify({checkedAt: fetchedAt, stores: [rakutenUp && '楽天市場', yahooUp && 'Yahoo!ショッピング'].filter(Boolean), products, unmatched}, null, 1) + '\n');

  // 価格の推移: この回に取れた価格だけを1日1点で残す（引き継いだ古い価格は記録しない）。失敗しても価格更新は止めない
  if (!auditOnly) {
    try {
      const historyFile = options.historyOutput || (options.output ? output.replace(/[^/\\]+$/, 'price-history.json') : HISTORY_OUTPUT);
      let history = {series: {}};
      try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch { /* 初回 */ }
      if (!history.series || typeof history.series !== 'object') history.series = {};
      const day = fetchedAt.slice(0, 10);
      for (const product of products) {
        if (product.fetchedAt !== fetchedAt || !Number.isSafeInteger(product.price)) continue;
        const key = `${product.category}|${product.modelName}`;
        const points = (history.series[key] || []).filter(point => point[0] !== day);
        points.push([day, product.price]);
        history.series[key] = points.slice(-HISTORY_DAYS);
      }
      history.updatedAt = fetchedAt;
      fs.writeFileSync(historyFile, JSON.stringify(history) + '\n');
    } catch { log('価格の推移を保存できませんでした（価格の更新は完了しています）'); }
  }

  // 新着候補: 価格取得で見た商品と、新しい順の追加検索から、サイトに未登録の型番を拾う
  if (!auditOnly) {
    const seen = [...searchCache.values(), ...yahoo.cache.values()].flat();
    for (const keyword of options.discoveryQueries || DISCOVERY_QUERIES) {
      try {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (rakuten.on) seen.push(...responseItems(await searchItems({keyword, hits: 30, sort: '-updateTimestamp'}, credentials, fetchImpl)));
        else seen.push(...(await yahooItems(keyword) || []));
      } catch { /* 新着探しの失敗は価格更新に影響させない */ }
    }
    // 型番の規則に合わない名前（例: Ryzen 7 8600G。正しくは Ryzen 5）は、出品名の誤りなので候補にしない
    const candidates = discoverNewModels(seen, models).filter(c => !nameIssue(c.category, c.modelName));
    const newFile = options.newOutput || (options.output ? output.replace(/[^/\\]+$/, 'new-products.json') : NEW_OUTPUT);
    let same = false;
    try { same = JSON.stringify(JSON.parse(fs.readFileSync(newFile, 'utf8')).candidates) === JSON.stringify(candidates); } catch { /* 初回 */ }
    if (!same) fs.writeFileSync(newFile, JSON.stringify({checkedAt: fetchedAt, candidates}, null, 1) + '\n');
    log(`新着候補 ${candidates.length} 件${candidates.length ? ': ' + candidates.slice(0, 8).map(c => c.modelName).join(', ') : ''}`);
  }

  // Blender Benchmark のスコア（公開データ）。取れなかった回は前回のファイルを残す
  if (!auditOnly && !options.skipBlender) {
    try {
      const names = {cpu: [], gpu: []};
      for (const row of models.specRows || models) if (names[row.category]) names[row.category].push(row.name || row.modelName);
      for (const model of models) if (names[model.category]) names[model.category].push(model.modelName);
      for (const key of Object.keys(names)) names[key] = [...new Set(names[key])];
      const blender = await fetchBlenderScores(names, fetchImpl, options.blenderOptions || {});
      if (blender.cpu || blender.gpu) {
        const file = options.blenderOutput || (options.output ? output.replace(/[^/\\]+$/, 'blender-scores.json') : BLENDER_OUTPUT);
        let previousBlender = {};
        try { previousBlender = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 初回 */ }
        const payload = {
          checkedAt: fetchedAt, source: 'https://opendata.blender.org/',
          note: 'Blender Open Data（公開データ・利用制限なし）の中央値。測定数3件以上のみ。GPUは一番速い計算方式の値',
          cpu: blender.cpu || previousBlender.cpu || null, gpu: blender.gpu || previousBlender.gpu || null,
        };
        fs.writeFileSync(file, JSON.stringify(payload, null, 1) + '\n');
        log(`Blender Benchmark: CPU ${Object.keys(payload.cpu?.scores || {}).length} 件（${payload.cpu?.blenderVersion || '-'}）/ GPU ${Object.keys(payload.gpu?.scores || {}).length} 件（${payload.gpu?.blenderVersion || '-'}）`);
      } else log('Blender Benchmark のスコアを取得できませんでした（前回のファイルを残します）');
    } catch { log('Blender Benchmark のスコアを取得できませんでした（前回のファイルを残します）'); }
  }

  // スプレッドシートの要確認リスト（モデル名の誤り・価格の未入力）。シートは書き換えない
  const pricedProducts = auditOnly ? [...previous.values()].filter(product => product.status === 'ok') : products;
  const priced = new Set(pricedProducts.map(product => `${product.category}\0${product.modelName}`));
  const issues = [];
  const rows = models.sheetRows || models.filter(model => model.fromSheet)
    .map(model => ({category: model.category, sheetName: model.modelName, modelName: model.modelName, priceValid: model.sheetPriceValid}));
  const seenNames = new Set();
  for (const row of rows) {
    // modelName はサイト表示用に補正済みの名前、sheetName はシートに書かれている名前
    const name = nameIssue(row.category, row.sheetName);
    // fix: 規則から機械的に決まる正しい名前（あるときだけ）。シート側スクリプトが自動で書き換える
    if (name) issues.push({category: row.category, modelName: row.sheetName, type: 'name', issue: name, ...(row.modelName !== row.sheetName && !nameIssue(row.category, row.modelName) ? {fix: row.modelName} : {})});
    const key = `${row.category}\0${row.modelName}`;
    if (seenNames.has(key)) issues.push({category: row.category, modelName: row.sheetName, type: 'duplicate', issue: `「${row.modelName}」と重複しています（サイトでは1件だけ表示）`});
    seenNames.add(key);
    if (!row.priceValid && !priced.has(key)) {
      issues.push({category: row.category, modelName: row.sheetName, type: 'price', issue: '価格が未入力または不正で、楽天からも取得できていません'});
    }
  }
  // 仕様（コア数・クロック・VRAM など）を照合表と比べる
  issues.push(...checkSpecs(models.specRows || [], options.specReference));
  const auditFile = options.auditOutput || (options.output ? output.replace(/[^/\\]+$/, 'sheet-audit.json') : AUDIT_OUTPUT);
  // 内容が変わったときだけ書き換える（毎日の無意味な更新を避ける）
  let unchanged = false;
  try { unchanged = JSON.stringify(JSON.parse(fs.readFileSync(auditFile, 'utf8')).issues) === JSON.stringify(issues); } catch { /* 初回 */ }
  if (!unchanged) fs.writeFileSync(auditFile, JSON.stringify({checkedAt: fetchedAt, issues}, null, 1) + '\n');
  log(`スプレッドシートの要確認: モデル名 ${issues.filter(i => i.type === 'name').length} 件 / 重複 ${issues.filter(i => i.type === 'duplicate').length} 件 / 価格 ${issues.filter(i => i.type === 'price').length} 件 / 仕様 ${issues.filter(i => i.type === 'spec').length} 件`);
  return 0;
}

if (require.main === module) main(process.env, fetch, {auditOnly: process.argv.includes('--audit-only')}).then(code => { process.exitCode = code; }).catch(() => {
  console.error('価格更新に失敗しました'); process.exitCode = 1;
});
module.exports = {main, loadModels};
