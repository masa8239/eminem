'use strict';

const productMap = require('../config/rakuten-products.json');

const API_URL = 'https://openapi.rakuten.co.jp/ichibams/api/ItemSearch/20220601';
const CATEGORIES = new Set(['cpu', 'gpu', 'ram']);

function validateMapping(entries) {
  if (!Array.isArray(entries)) throw new Error('商品対応表は配列で指定してください');
  const seen = new Set();
  return entries.map((entry, index) => {
    const category = String(entry.category || '').toLowerCase();
    const modelName = String(entry.modelName || '').trim();
    const itemCode = String(entry.itemCode || '').trim();
    if (!CATEGORIES.has(category) || !modelName || !itemCode || !itemCode.includes(':')) {
      throw new Error(`商品対応表の ${index + 1} 件目が不正です`);
    }
    const key = `${category}\0${modelName}`;
    if (seen.has(key)) throw new Error(`商品対応表に重複があります: ${category}/${modelName}`);
    seen.add(key);
    return {category, modelName, itemCode};
  });
}

function extractItem(payload, expectedCode) {
  const wrapped = Array.isArray(payload && payload.Items) ? payload.Items : [];
  const items = wrapped.map(value => value && (value.Item || value)).filter(Boolean);
  const item = items.find(value => value.itemCode === expectedCode);
  if (!item || !Number.isFinite(Number(item.itemPrice)) || Number(item.itemPrice) <= 0) {
    throw new Error('確認済み商品コードに一致する商品・価格がありません');
  }
  return {
    price: Number(item.itemPrice),
    url: String(item.affiliateUrl || item.itemUrl || ''),
  };
}

async function fetchProduct(entry, credentials, fetchImpl) {
  const url = new URL(API_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('applicationId', credentials.applicationId);
  url.searchParams.set('affiliateId', credentials.affiliateId);
  url.searchParams.set('itemCode', entry.itemCode);
  const response = await fetchImpl(url, {
    headers: {Authorization: `Bearer ${credentials.accessKey}`},
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error(`楽天API HTTP ${response.status}`);
  return extractItem(await response.json(), entry.itemCode);
}

async function buildResponse(entries, credentials, fetchImpl = fetch) {
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(entries.map(async entry => {
    try {
      const item = await fetchProduct(entry, credentials, fetchImpl);
      return {...entry, ...item, status: 'ok', fetchedAt: checkedAt, source: '楽天市場'};
    } catch (error) {
      return {...entry, status: 'error', checkedAt, error: error instanceof Error ? error.message : '取得失敗'};
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
module.exports._test = {validateMapping, extractItem, fetchProduct, buildResponse};
