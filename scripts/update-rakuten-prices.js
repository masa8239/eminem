'use strict';

// 楽天市場から CPU / GPU の価格を自動取得して data/rakuten-prices.json に保存する。
// GitHub Actions から1日1回実行する想定（.github/workflows/update-prices.yml）。
// 認証情報・リクエストURL・例外の詳細は出力しない。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {searchItems, responseItems, SITE_ORIGIN, PriceError} = require('../api/rakuten-prices')._test;
const {modelSpec, pickItem, pickImportItem, isImportListing, rejectReason, discoverNewModels, PRICE_FLOOR, median} = require('./lib/match');
const {searchYahoo, rakutenPoints} = require('./lib/stores');
const {nameIssue} = require('./lib/audit');
const {RAM_SPECS, ramQueries, pickRamOffers} = require('./lib/ram');
const {checkSpecs} = require('./lib/spec-check');
const {fetchBlenderScores} = require('./lib/blender');
const {PSU_SPECS, SSD_SPECS, MB_SPECS, pickByMaker} = require('./lib/parts');
const {loadCorrections} = require('./lib/corrections');
const {loadSheetParts, pickForProduct} = require('./lib/sheet-parts');
const {FIXED_PARTS, CANDIDATE_PARTS, pickFixedPart} = require('./lib/fixed-parts');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'rakuten-prices.json');
const AUDIT_OUTPUT = path.join(ROOT, 'data', 'sheet-audit.json');
const NEW_OUTPUT = path.join(ROOT, 'data', 'new-products.json');
const HISTORY_OUTPUT = path.join(ROOT, 'data', 'price-history.json');
const BLENDER_OUTPUT = path.join(ROOT, 'data', 'blender-scores.json');
const MB_SPECS_OUTPUT = path.join(ROOT, 'data', 'mb-specs.json');
const SHEET_PARTS_OUTPUT = path.join(ROOT, 'data', 'sheet-parts.json');
const HISTORY_DAYS = 180;
const IMPORT_SHOPS_FILE = path.join(ROOT, 'config', 'import-shops.json');
// 海外取り寄せの店（config/import-shops.json）。読めないときは空（取り寄せ品の扱いをしないだけで、価格更新は止めない）
// 店の商品名でよく使われる別の書き方（検索の言葉）。出品が1件も一致しなかったときだけ使う
function alternateKeyword(category, modelName, keyword) {
  const name = String(modelName || '');
  let alt = '';
  if (category === 'cpu') {
    const intel = name.match(/^Core i[3579]-(\d{4,5}[A-Z]*)$/);
    const ryzen = name.match(/^Ryzen [3579] (\d{4}[A-Z0-9]*)$/);
    alt = intel ? intel[1] : ryzen ? `Ryzen ${ryzen[1]}` : '';
  } else if (category === 'gpu') {
    alt = String(keyword || '').replace(/\s+/g, '');
  }
  return alt && alt !== keyword ? alt : '';
}
function readImportShops(file = IMPORT_SHOPS_FILE) {
  try { return new Set((JSON.parse(fs.readFileSync(file, 'utf8')).shops || []).map(shop => shop && shop.name).filter(name => typeof name === 'string' && name)); }
  catch { return new Set(); }
}
const STOCK_WARN_DAYS = 5; // この回数続けて新品が見つからない製品に注意を付ける

function readSheetsConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'sheets.json'), 'utf8')); } catch { return {}; }
}
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
        sheetRows.push({category, sheetName: item.sheetName || item.name, modelName: item.name, priceValid: price !== null, discontinued: Boolean(item.discontinued)});
        if (models.get(key)?.fromSheet) return; // 同名の行は最初（シート上で上）の1件を使う
        const builtin = models.get(key)?.referencePrice ?? null;
        models.set(key, {category, modelName: item.name, referencePrice: price ?? builtin, fromSheet: true, sheetPriceValid: price !== null, discontinued: Boolean(item.discontinued)});
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
  // シートで人が入れた修正（除外する商品・正しいメーカー）
  const corrections = options.corrections || (auditOnly ? {exclude: new Set(), maker: new Map()} : await loadCorrections(readSheetsConfig().correctionsSpreadsheetId, fetchImpl));
  if (corrections.ok) log(`シートの修正: 除外 ${corrections.exclude.size} 件 / メーカー修正 ${corrections.maker.size} 件`);
  const importShops = options.importShops || readImportShops();
  // 原因調査用: 同じ出品をまとめ、型番が合う出品を先に、安い順に最大12件
  const seenWithReasons = (spec, items) => {
    const uniq = [...new Map((items || []).filter(Boolean).map(x => [x.itemCode || x.itemName, x])).values()];
    const rows = uniq.map(x => ({price: x.itemPrice, shop: x.shopName || '', name: String(x.itemName || '').slice(0, 100),
      why: corrections.exclude.has(x.itemCode) ? 'シートで除外' : (rejectReason(spec, x) || (importShops.has(x.shopName) ? '取り寄せの店（普通の店で見つからないときだけ使う）' : '使える出品（価格帯・店の数のルールで見送り）'))}));
    const rank = r => r.why.startsWith('型番が違う') ? 1 : 0;
    return rows.sort((a, b) => rank(a) - rank(b) || a.price - b.price).slice(0, 12);
  };
  const notExcluded = items => (items || []).filter(item => !corrections.exclude.has(item.itemCode));
  // CPU・GPU の普通の価格は、取り寄せの店を除いた出品から選ぶ
  const notImport = items => (items || []).filter(item => !importShops.has(item.shopName));
  const byCategory = category => models.filter(model => model.category === category).map(model => model.modelName);
  const previous = new Map(readPrevious(output).map(product => [`${product.category}\0${product.modelName}`, product]));
  // 自動の参考価格: 直近14日の価格の推移（毎日採用した価格）の中央値。3日分以上あるときだけ使う
  let priceHistory = {series: {}};
  try { priceHistory = JSON.parse(fs.readFileSync(options.historyOutput || (options.output ? output.replace(/[^/\\]+$/, 'price-history.json') : HISTORY_OUTPUT), 'utf8')); } catch { /* 初回 */ }
  const autoReference = (category, modelName) => {
    const since = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const prices = ((priceHistory.series || {})[`${category}|${modelName}`] || []).filter(p => p[0] >= since && Number.isSafeInteger(p[1])).map(p => p[1]);
    return prices.length >= 3 ? Math.round(median(prices)) : 0;
  };
  const fetchedAt = now.toISOString();
  const origins = [credentials.origin, ...FALLBACK_ORIGINS.filter(origin => origin !== credentials.origin)];

  const products = [], unmatched = [];
  const trialGenres = new Map(); // 試しの取り方: 今の方法で採用できた GPU の出品の売り場（ジャンル）の数
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
    const cacheKey = range ? `${keyword}\0${range.from}\0${range.to}\0${range.start || 1}\0${range.results || 50}\0${range.sort || ''}\0${range.genre || ''}` : keyword;
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
    // シートで「販売終了」にした製品は価格を探さない
    if (model.discontinued) { unmatched.push({category: model.category, modelName: model.modelName, reason: '販売終了（シートで指定）'}); continue; }
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
    const picked = pickItem(spec, notExcluded(items), model.referencePrice, model.category);
    const url = picked.item && safeUrl(picked.item);
    if (picked.item && url) offers.push({
      store: '楽天市場', price: picked.item.itemPrice, points: rakutenPoints(picked.item), url,
      itemCode: picked.item.itemCode, itemName: picked.item.itemName,
      shopName: typeof picked.item.shopName === 'string' ? picked.item.shopName : '',
    });
    // 参考価格があるモデルは、ありえる価格帯に絞って安い順に取る（関連度順だと最安の出品を取りこぼす）。
    // 参考価格は「最近実際に取れた価格」を最優先にする（内蔵の参考価格は古く、相場が上がると範囲から外れて何も見つからない）
    const last = previous.get(`${model.category}\0${model.modelName}`);
    // 取り寄せ品の価格は普通の店の相場ではないので、検索の範囲の基準にしない
    const lastPrice = last && last.status === 'ok' && !last.import && Number.isSafeInteger(last.price) && now - new Date(last.fetchedAt) < 30 * 86400000 ? last.price : 0;
    const ref = lastPrice || (Number.isSafeInteger(model.referencePrice) && model.referencePrice > 0 ? model.referencePrice : 0);
    const range = ref ? {from: Math.max(PRICE_FLOOR[model.category] || 0, Math.round(ref * 0.7)), to: Math.round(ref * 1.8)} : null;
    let yItems = await yahooItems(spec.keyword, range);
    const looked = [...(yItems || [])]; // 原因調査用: 検索で見えた出品（範囲つき・範囲なしの両方）
    let yPicked = yItems && pickItem(spec, notImport(notExcluded(yItems)), ref || null, model.category, ref ? {} : {minShops: 2});
    // 範囲内に見つからないときは、範囲を外して安い順にもう一度探す（相場の中央値から外れた出品は使わない）
    if (yItems && !(yPicked && yPicked.item) && range) {
      const wide = await yahooItems(spec.keyword, {from: PRICE_FLOOR[model.category] || 1, to: 0});
      looked.push(...(wide || []));
      const widePicked = wide && pickItem(spec, notImport(notExcluded(wide)), null, model.category, {minShops: 2});
      // 範囲を外した検索で見つかった候補があるときは、その結果（と見送った理由）を使う
      if (widePicked && (widePicked.item || widePicked.reason !== '一致する新品単品の出品なし')) { yItems = wide; yPicked = widePicked; }
    }
    // 出品が1件も一致しなかったときは、店がよく使う別の書き方（「13600K」「RX7900XTX」など）でもう一度だけ探す。
    // 採用の決まり（取り寄せの店を除く・2店・価格帯）は同じなので、見つかった出品も同じように確かめてから使う
    const altKeyword = alternateKeyword(model.category, model.modelName, spec.keyword);
    let altUsed = null;
    if (yItems && altKeyword && !(yPicked && yPicked.item) && yPicked && yPicked.reason === '一致する新品単品の出品なし') {
      const alt = await yahooItems(altKeyword, null);
      looked.push(...(alt || []));
      const altPicked = alt && pickItem(spec, notImport(notExcluded(alt)), ref || null, model.category, ref ? {} : {minShops: 2});
      if (altPicked && (altPicked.item || altPicked.reason !== '一致する新品単品の出品なし')) { yItems = alt; yPicked = altPicked; altUsed = altKeyword; }
    }
    const yUrl = yPicked && yPicked.item && safeUrl(yPicked.item);
    if (yUrl && model.category === 'gpu' && yPicked.item.genre) trialGenres.set(yPicked.item.genre, (trialGenres.get(yPicked.item.genre) || 0) + 1);
    if (yUrl) offers.push({
      store: 'Yahoo!ショッピング', price: yPicked.item.itemPrice, points: yPicked.item.points || 0, url: yUrl,
      itemCode: yPicked.item.itemCode, itemName: yPicked.item.itemName, shopName: yPicked.item.shopName || '',
    });
    // シート（または内蔵）の参考価格の2倍を超える価格は、在庫処分・転売の高値として採用しない。
    // 相場が本当に上がった製品は、シートの「価格(円)」を今の値段に直せば採用される
    // 上限の基準は、運営者がシートに入れた価格だけ（内蔵の参考価格は古く、正しい価格まで弾いてしまうため）
    // シートの価格がない製品は、直近の価格の中央値（自動の参考価格）を使う
    const staticRef = (model.sheetPriceValid && Number.isSafeInteger(model.referencePrice) && model.referencePrice > 0 ? model.referencePrice : 0)
      || autoReference(model.category, model.modelName);
    let tooHigh = false, overCapFrom = 0;
    if (staticRef) for (let k = offers.length - 1; k >= 0; k--) if (offers[k].price > staticRef * 2) { overCapFrom = overCapFrom ? Math.min(overCapFrom, offers[k].price) : offers[k].price; offers.splice(k, 1); tooHigh = true; }
    if (!offers.length) {
      // 2倍を超える出品しかないとき、基準がシートの価格なら「シートの価格が古い」可能性がある。
      // サイトは古いシートの価格を参考価格として出さず「価格を確認中」にし、要確認リストで直してもらう
      if (tooHigh) {
        const fromSheet = Boolean(model.sheetPriceValid && Number.isSafeInteger(model.referencePrice) && model.referencePrice > 0);
        unmatched.push({category: model.category, modelName: model.modelName, reason: '参考価格（シートの価格か直近の中央値）の2倍を超える出品しかない（在庫処分・転売の可能性）',
          staleReference: true, referenceFrom: fromSheet ? 'sheet' : 'history', reference: staticRef, marketFrom: overCapFrom});
        continue;
      }
      // ストア側の失敗で取れなかったときは、前回の価格を数日間は引き継ぐ
      const kept = previous.get(`${model.category}\0${model.modelName}`);
      const storeFailed = rakutenError || (rakuten.configured && !rakuten.on) || (yahoo.appid && !yItems);
      if (storeFailed && kept && kept.status === 'ok' && now - new Date(kept.fetchedAt) < KEEP_PREVIOUS_MS) { products.push(kept); continue; }
      // 普通の店で見つからないときは、取り寄せの店・並行輸入品の出品を「取り寄せ品」として出す（運営者の決定 2026-11-26）
      const importPicked = yItems && pickImportItem(spec, notExcluded(looked).filter(item => isImportListing(item, importShops)), model.category);
      const importUrl = importPicked && importPicked.item && safeUrl(importPicked.item);
      if (importUrl) {
        const it = importPicked.item;
        products.push({category: model.category, modelName: model.modelName, status: 'ok', import: true, source: 'Yahoo!ショッピング',
          price: it.itemPrice, points: it.points || 0, url: importUrl, fetchedAt, itemCode: it.itemCode, itemName: it.itemName, shopName: it.shopName || '',
          offers: [{store: 'Yahoo!ショッピング', price: it.itemPrice, points: it.points || 0, url: importUrl}]});
        continue;
      }
      unmatched.push({category: model.category, modelName: model.modelName, reason: rakutenError || (yPicked && yPicked.reason) || (rakuten.on ? picked.reason : null) || '一致する新品単品の出品なし',
        // GPU は原因を調べられるように、検索で見えた出品と使わなかった理由を残す（表示には使わない）
        // CPU も 2026-11-27 から（運営者の依頼: API で取れなかった製品を確かめる）
        searched: {keyword: spec.keyword, ...(altKeyword ? {alternate: altKeyword} : {}), range: range ? [range.from, range.to] : null, hits: looked.length}, seen: seenWithReasons(spec, looked)});
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
    const offers = pickRamOffers(spec, notExcluded(items));
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
    const picks = pickByMaker(spec, notExcluded(items), corrections.maker).map(p => ({...p, url: safeUrl(p.item)})).filter(p => p.url);
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
            : {chipset: spec.chipset, form: spec.form, socket: spec.socket, memory: spec.memory, wifi: Boolean(parsed.wifi)})},
      });
    }
  }
  if (!auditOnly && !options.skipParts) log(`電源・SSD・マザーボード: ${partsFound} 件（規格×メーカー）`);

  // ビルダーの CPUクーラー・ケース（決まった製品）: 製品名で検索して、2店以上で売られている新品の最安値を取る
  let fixedFound = 0;
  for (const part of auditOnly || options.skipFixedParts ? [] : (options.fixedParts || [...FIXED_PARTS, ...CANDIDATE_PARTS])) {
    const found = await yahooItems(part.query, {from: part.floor, to: 0});
    const pick = found && pickFixedPart(part, notExcluded(found));
    const url = pick && safeUrl(pick.item);
    if (!url) {
      const kept = previous.get(`${part.category}\0${part.name}`);
      if (!found && kept && kept.status === 'ok' && now - new Date(kept.fetchedAt) < KEEP_PREVIOUS_MS) products.push(kept);
      // 見つからなかった理由を後から確かめられるように、検索で出てきた出品を少しだけ残す（安い順・最大8件）
      else unmatched.push({category: part.category, modelName: part.name, reason: found ? '製品名が一致する新品を2店以上で確認できませんでした' : 'Yahoo!ショッピングに接続できませんでした',
        ...(found ? {seen: [...found].sort((x, y) => x.itemPrice - y.itemPrice).slice(0, 8).map(x => ({price: x.itemPrice, shop: x.shopName || '', name: String(x.itemName || '').slice(0, 100), inStock: x.availability !== 0}))} : {})});
      continue;
    }
    fixedFound++;
    products.push({category: part.category, modelName: part.name, status: 'ok', source: 'Yahoo!ショッピング', price: pick.item.itemPrice, points: pick.item.points || 0, url, fetchedAt,
      itemCode: pick.item.itemCode, itemName: pick.item.itemName, shopName: pick.item.shopName || '', spec: {id: part.id, shops: pick.shops, maxTdp: part.maxTdp ?? null}});
  }
  if (!auditOnly && !options.skipFixedParts) log(`CPUクーラー・ケース: ${(options.fixedParts || FIXED_PARTS).length} 製品のうち ${fixedFound} 製品の最安値を取得`);

  // 運営者がシートで管理する「おすすめ製品」（マザーボード・SSD）。製品名で検索して、その製品の最安値を取る
  let sheetFound = 0;
  const sheetParts = options.sheetParts || (auditOnly || options.skipSheetParts ? {ok: false, mb: [], ssd: []} : await loadSheetParts(readSheetsConfig().correctionsSpreadsheetId, fetchImpl));
  for (const product of [...sheetParts.mb, ...sheetParts.ssd]) {
    const category = product.kind === 'mb' ? 'mbp' : 'ssdp';
    const found = await yahooItems(product.name, {from: product.kind === 'mb' ? 6000 : 2000, to: 0});
    const item = found && pickForProduct(product, notExcluded(found));
    const url = item && safeUrl(item);
    if (!url) {
      const kept = previous.get(`${category}\0${product.name}`);
      if (!found && kept && kept.status === 'ok' && now - new Date(kept.fetchedAt) < KEEP_PREVIOUS_MS) products.push(kept);
      else unmatched.push({category, modelName: product.name, reason: found ? '製品名と仕様が一致する新品の出品なし' : 'Yahoo!ショッピングに接続できませんでした'});
      continue;
    }
    sheetFound++;
    products.push({category, modelName: product.name, status: 'ok', source: 'Yahoo!ショッピング', price: item.itemPrice, points: item.points || 0, url, fetchedAt,
      itemCode: item.itemCode, itemName: item.itemName, shopName: item.shopName || ''});
  }
  if (sheetParts.ok) {
    const file = options.sheetPartsOutput || (options.output ? output.replace(/[^/\\]+$/, 'sheet-parts.json') : SHEET_PARTS_OUTPUT);
    fs.writeFileSync(file, JSON.stringify({checkedAt: fetchedAt, mb: sheetParts.mb, ssd: sheetParts.ssd}, null, 1) + '\n');
    // 自動の一覧（規格別の最安値）にも、シートに入れた板の仕様を出せるように書き出す
    const boards = sheetParts.mb.map(p => {
      const makerWords = new Set(String(p.maker).toUpperCase().split(/\s+/));
      const model = p.name.split(' ').filter(w => !makerWords.has(w.toUpperCase())).join(' ');
      const fields = Object.fromEntries(Object.entries(p.fields).filter(([k]) => !['メーカー', 'チップセット', 'サイズ'].includes(k)));
      return {model, fields};
    }).filter(b => b.model.replace(/[\s_-]/g, '').length >= 5 && Object.keys(b.fields).length);
    const mbFile = options.boardSpecsOutput || (options.output ? output.replace(/[^/\\]+$/, 'mb-specs.json') : MB_SPECS_OUTPUT);
    fs.writeFileSync(mbFile, JSON.stringify({checkedAt: fetchedAt, boards}, null, 1) + '\n');
    log(`シートのおすすめ製品: マザーボード ${sheetParts.mb.length} / SSD ${sheetParts.ssd.length}（価格を取れた ${sheetFound} 件）`);
  }

  if (!auditOnly) log(`対象 ${models.length} モデル / 取得 ${products.length - ramFound - partsFound - sheetFound - fixedFound} / 未取得 ${unmatched.filter(u => !['ram', 'cooler', 'case'].includes(u.category)).length} / API失敗 ${apiErrors}`);
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
        // 取り寄せ品の価格は普通の店の相場ではないので、推移（自動の参考価格のもと）に入れない
        if (product.fetchedAt !== fetchedAt || product.import || !Number.isSafeInteger(product.price)) continue;
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
    if (!row.priceValid && !priced.has(key) && !row.discontinued) {
      issues.push({category: row.category, modelName: row.sheetName, type: 'price', issue: '価格が未入力または不正で、楽天からも取得できていません'});
    }
  }
  // シートの価格(円)が今の相場より大幅に低い（ストアの新品がすべてその2倍を超える）製品
  for (const u of unmatched) {
    if (!u.staleReference || u.referenceFrom !== 'sheet') continue;
    const row = rows.find(r => r.category === u.category && r.modelName === u.modelName);
    if (!row || row.discontinued) continue;
    issues.push({category: u.category, modelName: row.sheetName, type: 'price',
      issue: `「価格(円)」の ${u.reference.toLocaleString('ja-JP')} 円が今の相場より大幅に低い可能性があります。ストアの新品はすべて ${u.marketFrom.toLocaleString('ja-JP')} 円以上で、2倍の上限を超えるため採用していません。相場が上がったなら「価格(円)」を今の値段に直してください（サイトでは「価格を確認中」と表示しています）`});
  }
  // 仕様（コア数・クロック・VRAM など）を照合表と比べる
  issues.push(...checkSpecs(models.specRows || [], options.specReference));
  // 新品の出品が続けて見つからない製品（中古しか売っていない可能性）。最近の取得日のどれにも価格がない行を知らせる
  if (!auditOnly) {
    try {
      const historyFile = options.historyOutput || (options.output ? output.replace(/[^/\\]+$/, 'price-history.json') : HISTORY_OUTPUT);
      const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      const days = [...new Set(Object.values(history.series || {}).flat().map(point => point[0]))].sort();
      const recent = new Set(days.slice(-STOCK_WARN_DAYS));
      if (days.length >= STOCK_WARN_DAYS) {
        const seenRows = new Set();
        for (const row of rows) {
          const key = `${row.category}|${row.modelName}`;
          if (row.discontinued || seenRows.has(key)) continue;
          seenRows.add(key);
          if (!(history.series[key] || []).some(point => recent.has(point[0]))) {
            issues.push({category: row.category, modelName: row.sheetName, type: 'stock', issue: `直近${STOCK_WARN_DAYS}回の価格取得で、新品の出品が見つかりませんでした。中古しか売っていないなら「販売終了」にチェックしてください`});
          }
        }
      }
    } catch { /* 推移がまだないときは知らせない */ }
  }
  const auditFile = options.auditOutput || (options.output ? output.replace(/[^/\\]+$/, 'sheet-audit.json') : AUDIT_OUTPUT);
  // 内容が変わったときだけ書き換える（毎日の無意味な更新を避ける）
  let unchanged = false;
  try { unchanged = JSON.stringify(JSON.parse(fs.readFileSync(auditFile, 'utf8')).issues) === JSON.stringify(issues); } catch { /* 初回 */ }
  if (!unchanged) fs.writeFileSync(auditFile, JSON.stringify({checkedAt: fetchedAt, issues}, null, 1) + '\n');
  log(`スプレッドシートの要確認: モデル名 ${issues.filter(i => i.type === 'name').length} 件 / 重複 ${issues.filter(i => i.type === 'duplicate').length} 件 / 価格 ${issues.filter(i => i.type === 'price').length} 件 / 仕様 ${issues.filter(i => i.type === 'spec').length} 件 / 新品なし ${issues.filter(i => i.type === 'stock').length} 件`);
  // ---- 試しの取り方（GPU）。結果は data/price-trial.json に書くだけで、サイトの表示には使わない ----
  // 本番の価格・履歴・新製品・要確認リストをすべて保存した後に動かす。専用の検索（本番の検索の記録・失敗の回数とは別）で、時間の上限つき
  if (!auditOnly && yahoo.appid && yahoo.failures < 3 && (options.trial ?? !options.output)) {
    try {
      const trial = await runTrial();
      if (trial) {
        fs.writeFileSync(options.trialOutput || path.join(path.dirname(output), 'price-trial.json'), JSON.stringify(trial, null, 1) + '\n');
        log(`試しの取り方（GPU）: 今の方法 ${trial.summary.currentOk} / 試し ${trial.summary.trialOk} 製品（売り場 ${trial.genre ? trial.genre.name + ' ' + trial.genre.id : '絞らない'}${trial.summary.stopped ? '・' + trial.summary.stopped : ''}）`);
      }
    } catch (error) { log(`試しの取り方に失敗: ${String(error && error.message || error).split(yahoo.appid).join('[appid]')}`); }
  }
  async function runTrial() {
    const budgetMs = options.trialBudgetMs ?? 10 * 60 * 1000;
    const started = Date.now();
    let stopped = '';
    // 試し専用の検索。429（問い合わせすぎ）や接続失敗が出たら、その時点で試しをやめる（本番の取得には影響させない）
    const search = async range => {
      if (stopped) return null;
      if (Date.now() - started > budgetMs) { stopped = '時間の上限で途中まで'; return null; }
      await wait(yahooDelay);
      try { return await searchYahoo(range.keyword, yahoo.appid, fetchImpl, range, yahoo.affiliateId); }
      catch (error) { stopped = error && error.status === 429 ? 'Yahoo の問い合わせ上限で途中まで' : 'Yahoo に接続できず途中まで'; return null; }
    };
    const genreTop = [...trialGenres.entries()].sort((a, b) => b[1] - a[1])[0];
    const genreId = genreTop && genreTop[1] >= 3 ? genreTop[0] : '';
    let genreName = '';
    const floor = PRICE_FLOOR.gpu || 0;
    const rows = [];
    for (const model of models.filter(m => m.category === 'gpu' && !m.discontinued)) {
      const spec = modelSpec('gpu', model.modelName, byCategory('gpu'));
      // 今の方法の結果は、この回に取れた価格だけ（前回の価格を引き継いだものは比べない）
      const current = products.find(p => p.category === 'gpu' && p.modelName === model.modelName && p.fetchedAt === fetchedAt && !p.import);
      const row = {modelName: model.modelName, current: current ? {price: current.price, shop: current.shopName || ''} : null};
      if (!spec) { rows.push({...row, trial: {reason: '型番を判定できないモデル名'}}); continue; }
      if (stopped) { rows.push({...row, trial: {reason: '未実施（' + stopped + '）'}}); continue; }
      // 売り場で絞って関連の高い順に2ページ。一致する出品がなければ、絞らずにもう1ページ
      const pages = async genre => {
        const out = [];
        for (const start of [1, 51]) {
          const page = await search({keyword: spec.keyword, from: floor, to: 0, start, results: 50, sort: '-score', genre});
          if (!page) return out.length ? out : null;
          out.push(...page);
          if (page.length < 50) break;
        }
        return out;
      };
      let looked = await pages(genreId);
      let usedGenre = genreId;
      if (looked && genreId && !looked.some(x => !rejectReason(spec, x))) {
        const wide = await search({keyword: spec.keyword, from: floor, to: 0, start: 1, results: 50, sort: '-score'});
        if (wide) { looked = looked.concat(wide); usedGenre = ''; }
      }
      if (!looked) { rows.push({...row, trial: {reason: 'Yahoo に接続できなかった'}}); continue; }
      for (const x of looked) if (genreId && x.genre === genreId && x.genreName) genreName = x.genreName;
      const uniq = [...new Map(looked.map(x => [x.itemCode, x])).values()].filter(x => !corrections.exclude.has(x.itemCode));
      const matched = uniq.filter(x => !rejectReason(spec, x));
      const staticRef = (model.sheetPriceValid && Number.isSafeInteger(model.referencePrice) && model.referencePrice > 0 ? model.referencePrice : 0)
        || autoReference('gpu', model.modelName);
      const why = {};
      for (const x of uniq) { const r = rejectReason(spec, x); if (r) why[r] = (why[r] || 0) + 1; }
      const genres = {};
      for (const x of matched) if (x.genre) genres[x.genre + ' ' + (x.genreName || '')] = (genres[x.genre + ' ' + (x.genreName || '')] || 0) + 1;
      const base = {hits: uniq.length, matched: matched.length, genre: usedGenre ? 'しぼる' : 'しぼらない', matchedGenres: genres, rejected: why};
      if (!matched.length) { rows.push({...row, trial: {...base, reason: '一致する新品単品の出品なし'}}); continue; }
      const mid = median(matched.map(x => x.itemPrice));
      if (!staticRef && matched.length < 3) { rows.push({...row, trial: {...base, reason: '基準価格なし・一致する出品が3件未満'}}); continue; }
      // 基準価格（シートの価格か直近の中央値）があれば 0.7〜1.8倍、なければ一致した出品の中央値の 0.75〜1.5倍
      const lo = staticRef ? Math.max(floor, staticRef * 0.7) : Math.max(floor, mid * 0.75);
      const hi = staticRef ? staticRef * 1.8 : mid * 1.5;
      const accepted = matched.filter(x => x.itemPrice >= lo && x.itemPrice <= hi).sort((a, b) => a.itemPrice - b.itemPrice);
      if (!accepted.length) { rows.push({...row, trial: {...base, median: mid, reason: '価格が相場から外れている'}}); continue; }
      const near = accepted.filter(x => x.itemPrice <= accepted[0].itemPrice * 1.15);
      const shops = new Set(near.map(x => x.shopName || x.itemCode));
      if (shops.size < 2) { rows.push({...row, trial: {...base, median: mid, reason: '同じ価格帯で売っている店が1つだけ'}}); continue; }
      const best = accepted[0];
      rows.push({...row, trial: {...base, median: mid, price: best.itemPrice, shop: best.shopName || '', shops: shops.size, itemName: String(best.itemName).slice(0, 100), url: safeUrl(best) || ''}});
    }
    const ok = r => r.trial && Number.isSafeInteger(r.trial.price);
    const both = rows.filter(r => r.current && ok(r));
    const diffs = both.map(r => Math.round((r.trial.price / r.current.price - 1) * 100));
    return {
      checkedAt: fetchedAt,
      method: '売り場で絞り、関連の高い順に2ページ（100件）を見る（一致がなければ絞らずに1ページ）。採用: 基準価格があれば0.7〜1.8倍、なければ一致3件以上で中央値の0.75〜1.5倍。同じ価格帯に2店以上',
      genre: genreId ? {id: genreId, name: genreName} : null,
      summary: {models: rows.length, currentOk: rows.filter(r => r.current).length, trialOk: rows.filter(ok).length,
        onlyTrial: rows.filter(r => !r.current && ok(r)).length, onlyCurrent: rows.filter(r => r.current && !ok(r)).length,
        both: both.length, priceDiffMedianPct: diffs.length ? median(diffs) : null, priceDiffOver10Pct: diffs.filter(d => Math.abs(d) > 10).length,
        ...(stopped ? {stopped} : {})},
      models: rows,
    };
  }
  return 0;
}

if (require.main === module) main(process.env, fetch, {auditOnly: process.argv.includes('--audit-only')}).then(code => { process.exitCode = code; }).catch(() => {
  console.error('価格更新に失敗しました'); process.exitCode = 1;
});
module.exports = {main, loadModels};
