'use strict';

// 楽天市場以外のストアの検索と、ストアごとの違いを吸収する処理。
// 返す商品は match.js の pickItem がそのまま扱える形（itemCode / itemName / itemPrice / availability）にそろえる。

const YAHOO_URL = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';

// Yahoo!ショッピング 商品検索API（v3）。Client ID だけで使える。
// 注意: 実際のAPI応答ではまだ動作確認していない（応答の形は公開仕様に基づく）。
// range: {from, to} を渡すと、その価格帯を安い順に検索する（付属品など安すぎる出品は範囲で除ける）
async function searchYahoo(keyword, appid, fetchImpl = fetch, range = null) {
  const url = new URL(YAHOO_URL);
  url.searchParams.set('appid', appid);
  url.searchParams.set('query', keyword);
  url.searchParams.set('results', range ? '50' : '30');
  if (range) {
    url.searchParams.set('sort', '+price');
    url.searchParams.set('price_from', String(range.from));
    if (range.to) url.searchParams.set('price_to', String(range.to));
  }
  url.searchParams.set('in_stock', 'true');
  url.searchParams.set('condition', 'new');
  const response = await fetchImpl(url, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(7000), redirect: 'error'});
  // 失敗の理由をログに出す（appid は伏せる）
  const hide = text => String(text || '').split(appid).join('[appid]').slice(0, 200);
  if (!response.ok) {
    let detail = '';
    try { const body = await response.text(); try { const j = JSON.parse(body); detail = (j.Error && (j.Error.Message || j.Error.message)) || j.message || body; } catch { detail = body; } } catch { /* 本文なし */ }
    const error = new Error(hide(`Yahoo API HTTP ${response.status}${detail ? ': ' + detail : ''}`));
    error.status = response.status;
    throw error;
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Yahoo API: JSONを読めませんでした'); }
  if (!payload || !Array.isArray(payload.hits)) throw new Error(hide('Yahoo API: 想定外の応答（キー: ' + Object.keys(payload || {}).join(', ') + '）'));
  return payload.hits.filter(hit => hit && typeof hit === 'object' && (hit.condition === undefined || hit.condition === 'new')).map(hit => ({
    itemCode: typeof hit.code === 'string' ? 'yahoo:' + hit.code : '',
    itemName: typeof hit.name === 'string' ? hit.name : '',
    itemPrice: hit.price,
    availability: hit.inStock === false ? 0 : 1,
    itemUrl: hit.url,
    shopName: hit.seller && typeof hit.seller.name === 'string' ? hit.seller.name : '',
    points: hit.point && Number.isSafeInteger(hit.point.amount) && hit.point.amount > 0 ? hit.point.amount : 0,
  })).filter(item => item.itemCode !== 'yahoo:');
}

// 楽天: ポイント倍率（通常1倍 = 1%）から付与ポイントを概算する
function rakutenPoints(item) {
  const rate = Number(item.pointRate);
  return Math.floor(item.itemPrice * (Number.isFinite(rate) && rate >= 1 && rate <= 50 ? rate : 1) / 100);
}

module.exports = {searchYahoo, rakutenPoints, YAHOO_URL};
