'use strict';

const productMap = require('../config/rakuten-products.json');

// https://webservice.rakuten.co.jp/documentation/ichiba-item-search
const API_URL = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
// Rakuten checks the registered web application's Origin for server-side requests.
const SITE_ORIGIN = 'https://eminem-zfet.vercel.app';
const CATEGORIES = new Set(['cpu', 'gpu', 'ram']);

class PriceError extends Error {}

function validateMapping(entries) {
  if (!Array.isArray(entries)) throw new Error('商品対応表は配列で指定してください');
  const seen = new Set();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`商品対応表の ${index + 1} 件目が不正です`);
    const category = String(entry.category || '').toLowerCase();
    const modelName = String(entry.modelName || '').trim();
    const itemCode = String(entry.itemCode || '').trim();
    const itemName = typeof entry.itemName === 'string' ? entry.itemName.trim() : '';
    if (!CATEGORIES.has(category) || !modelName || !/^[^\s:]+:[^\s:]+$/.test(itemCode) || !itemName || entry.condition !== 'new') {
      throw new Error(`商品対応表の ${index + 1} 件目が不正です`);
    }
    const key = `${category}\0${modelName}`;
    if (seen.has(key)) throw new Error(`商品対応表に重複があります: ${category}/${modelName}`);
    seen.add(key);
    return {category, modelName, itemCode, itemName, condition: 'new'};
  });
}

function responseItems(payload) {
  // The documented v2 example uses `items`; live JSON has also returned `Items`.
  const items = payload && (payload.items || payload.Items);
  if (!payload || payload.error || !Array.isArray(items)) {
    throw new PriceError('楽天APIのレスポンス形式が不正です');
  }
  return items.map(item => item && (item.Item || item)).filter(item => item && typeof item === 'object');
}

function extractItem(payload, entry) {
  const matches = responseItems(payload).filter(value => value.itemCode === entry.itemCode);
  const item = matches.length === 1 ? matches[0] : null;
  if (!item || item.itemName !== entry.itemName) {
    throw new PriceError('確認済み商品コード・商品名に一致する商品がありません');
  }
  if (!Number.isSafeInteger(item.itemPrice) || item.itemPrice <= 0 || item.availability !== 1) {
    throw new PriceError('購入可能な商品の有効な円価格がありません');
  }
  let url;
  try { url = new URL(item.affiliateUrl || item.itemUrl); }
  catch { throw new PriceError('楽天の商品リンクが不正です'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new PriceError('楽天の商品リンクが不正です');
  }
  return {
    price: item.itemPrice,
    url: url.href,
  };
}

async function searchItems(parameters, credentials, fetchImpl = fetch) {
  const url = new URL(API_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatVersion', '2');
  url.searchParams.set('applicationId', credentials.applicationId);
  if (credentials.affiliateId) url.searchParams.set('affiliateId', credentials.affiliateId);
  url.searchParams.set('availability', '1');
  for (const key of ['itemCode', 'keyword', 'hits']) {
    if (parameters[key] !== undefined) url.searchParams.set(key, parameters[key]);
  }
  const response = await fetchImpl(url, {
    headers: {accessKey: credentials.accessKey, Accept: 'application/json', Origin: SITE_ORIGIN},
    signal: AbortSignal.timeout(7000),
    redirect: 'error',
  });
  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : 'error';
    throw new PriceError(`楽天API HTTP ${status}`);
  }
  // Never expose request URLs, response bodies or native fetch/JSON errors.
  let payload;
  try { payload = await response.json(); }
  catch { throw new PriceError('楽天APIのJSONを読み取れませんでした'); }
  responseItems(payload);
  return payload;
}

async function fetchProduct(entry, credentials, fetchImpl = fetch) {
  return extractItem(await searchItems({itemCode: entry.itemCode}, credentials, fetchImpl), entry);
}

async function buildResponse(entries, credentials, fetchImpl = fetch) {
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(entries.map(async entry => {
    try {
      const item = await fetchProduct(entry, credentials, fetchImpl);
      return {...entry, ...item, status: 'ok', fetchedAt: checkedAt, source: '楽天市場'};
    } catch (error) {
      return {...entry, status: 'error', checkedAt, error: error instanceof PriceError ? error.message : '楽天APIへの接続に失敗しました'};
    }
  }));
  return {checkedAt, products: results};
}

async function handler(request, response) {
  response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (request.method !== 'GET') return response.status(405).json({error: 'Method Not Allowed'});

  let entries;
  try { entries = validateMapping(productMap); }
  catch (error) { return response.status(500).json({error: error.message}); }
  if (entries.length === 0) return response.status(200).json({checkedAt: new Date().toISOString(), products: []});

  const credentials = {
    applicationId: process.env.RAKUTEN_APPLICATION_ID,
    accessKey: process.env.RAKUTEN_ACCESS_KEY,
    affiliateId: process.env.RAKUTEN_AFFILIATE_ID,
  };
  if (Object.values(credentials).some(value => !value)) {
    const checkedAt = new Date().toISOString();
    return response.status(503).json({
      error: '楽天APIの認証情報が設定されていません', checkedAt,
      products: entries.map(entry => ({...entry, status: 'error', checkedAt, error: '認証情報未設定'})),
    });
  }
  return response.status(200).json(await buildResponse(entries, credentials));
}

module.exports = handler;
module.exports._test = {validateMapping, responseItems, extractItem, searchItems, fetchProduct, buildResponse};
