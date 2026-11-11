'use strict';

// 楽天市場から CPU / GPU の価格を自動取得して data/rakuten-prices.json に保存する。
// GitHub Actions から1日1回実行する想定（.github/workflows/update-prices.yml）。
// 認証情報・リクエストURL・例外の詳細は出力しない。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {searchItems, responseItems, SITE_ORIGIN, PriceError} = require('../api/rakuten-prices')._test;
const {modelSpec, pickItem} = require('./lib/match');
const {nameIssue} = require('./lib/audit');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'rakuten-prices.json');
const AUDIT_OUTPUT = path.join(ROOT, 'data', 'sheet-audit.json');
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
      JSON.parse(run(`JSON.stringify(__rows.map(${parser}).filter(r=>r&&r.name&&r.score>0))`)).forEach(item => {
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
  return list;
}

function safeUrl(item) {
  try {
    const url = new URL(item.affiliateUrl || item.itemUrl);
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
  if (missing.length && !auditOnly) { log(`認証情報が未設定です: ${missing.join(', ')}`); return 1; }

  const credentials = {applicationId: env[names[0]], accessKey: env[names[1]], affiliateId: env[names[2]], origin: env.RAKUTEN_SITE_ORIGIN || SITE_ORIGIN};
  const models = options.models || await loadModels(fetchImpl);
  const byCategory = category => models.filter(model => model.category === category).map(model => model.modelName);
  const previous = new Map(readPrevious(output).map(product => [`${product.category}\0${product.modelName}`, product]));
  const fetchedAt = now.toISOString();
  const origins = [credentials.origin, ...FALLBACK_ORIGINS.filter(origin => origin !== credentials.origin)];

  const products = [], unmatched = [];
  const searchCache = new Map();
  let apiErrors = 0, attempted = 0, first = true;
  for (const model of auditOnly ? [] : models) {
    const spec = modelSpec(model.category, model.modelName, byCategory(model.category));
    if (!spec) { unmatched.push({category: model.category, modelName: model.modelName, reason: '型番を判定できないモデル名'}); continue; }
    let items = searchCache.get(spec.keyword) || null;
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
      searchCache.set(spec.keyword, items);
    } catch (error) {
      apiErrors++;
      const kept = previous.get(`${model.category}\0${model.modelName}`);
      const reason = error instanceof PriceError ? error.message : '楽天APIへの接続に失敗';
      if (kept && kept.status === 'ok' && now - new Date(kept.fetchedAt) < KEEP_PREVIOUS_MS) products.push(kept);
      else unmatched.push({category: model.category, modelName: model.modelName, reason});
      first = false;
      continue;
    }
    first = false;
    const picked = pickItem(spec, items, model.referencePrice);
    const url = picked.item && safeUrl(picked.item);
    if (!picked.item || !url) {
      unmatched.push({category: model.category, modelName: model.modelName, reason: picked.reason || '商品リンクが不正'});
      continue;
    }
    products.push({
      category: model.category, modelName: model.modelName, status: 'ok', source: '楽天市場',
      price: picked.item.itemPrice, url, fetchedAt,
      itemCode: picked.item.itemCode, itemName: picked.item.itemName,
      shopName: typeof picked.item.shopName === 'string' ? picked.item.shopName : '',
    });
  }

  if (!auditOnly) log(`対象 ${models.length} モデル / 取得 ${products.length} / 未取得 ${unmatched.length} / API失敗 ${apiErrors}`);
  // APIの障害時は前回のファイルを壊さない
  if (attempted && apiErrors > Math.max(3, attempted * 0.3)) {
    log('楽天APIの失敗が多いため、今回は価格ファイルを更新しません');
    return 1;
  }
  fs.mkdirSync(path.dirname(output), {recursive: true});
  if (!auditOnly) fs.writeFileSync(output, JSON.stringify({checkedAt: fetchedAt, source: '楽天市場', products, unmatched}, null, 1) + '\n');

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
  const auditFile = options.auditOutput || (options.output ? output.replace(/[^/\\]+$/, 'sheet-audit.json') : AUDIT_OUTPUT);
  // 内容が変わったときだけ書き換える（毎日の無意味な更新を避ける）
  let unchanged = false;
  try { unchanged = JSON.stringify(JSON.parse(fs.readFileSync(auditFile, 'utf8')).issues) === JSON.stringify(issues); } catch { /* 初回 */ }
  if (!unchanged) fs.writeFileSync(auditFile, JSON.stringify({checkedAt: fetchedAt, issues}, null, 1) + '\n');
  log(`スプレッドシートの要確認: モデル名 ${issues.filter(i => i.type === 'name').length} 件 / 重複 ${issues.filter(i => i.type === 'duplicate').length} 件 / 価格 ${issues.filter(i => i.type === 'price').length} 件`);
  return 0;
}

if (require.main === module) main(process.env, fetch, {auditOnly: process.argv.includes('--audit-only')}).then(code => { process.exitCode = code; }).catch(() => {
  console.error('価格更新に失敗しました'); process.exitCode = 1;
});
module.exports = {main, loadModels};
