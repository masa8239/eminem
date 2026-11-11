'use strict';

// 楽天市場以外のストアの検索と、ストアごとの違いを吸収する処理。
// 返す商品は match.js の pickItem がそのまま扱える形（itemCode / itemName / itemPrice / availability）にそろえる。

const YAHOO_URL = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';

// Yahoo!ショッピング 商品検索API（v3）。Client ID だけで使える。
// 注意: 実際のAPI応答ではまだ動作確認していない（応答の形は公開仕様に基づく）。
async function searchYahoo(keyword, appid, fetchImpl = fetch) {
  const url = new URL(YAHOO_URL);
  url.searchParams.set('appid', appid);
  url.searchParams.set('query', keyword);
  url.searchParams.set('results', '30');
  url.searchParams.set('in_stock', 'true');
  url.searchParams.set('condition', 'new');
  const response = await fetchImpl(url, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(7000), redirect: 'error'});
  if (!response.ok) throw new Error('Yahoo API HTTP error');
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.hits)) throw new Error('Yahoo API response');
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
