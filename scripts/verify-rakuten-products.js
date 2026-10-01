'use strict';

// Read-only candidate search; never writes the mapping.
const {searchItems, responseItems} = require('../api/rakuten-prices')._test;
const targets = [
  {category:'cpu',modelName:'Ryzen 9 9950X3D',keyword:'9950X3D'},
  {category:'gpu',modelName:'GeForce RTX 5090',keyword:'GeForce RTX 5090'},
];
function publicItemUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'item.rakuten.co.jp' || url.username || url.password) return null;
    return url.origin + url.pathname;
  } catch { return null; }
}
async function main(env = process.env, fetchImpl = fetch, write = console.log) {
  const names = ['RAKUTEN_APPLICATION_ID','RAKUTEN_ACCESS_KEY','RAKUTEN_AFFILIATE_ID'];
  const missing = names.filter(name => !env[name]);
  if (missing.length) {
    write(JSON.stringify({status:'not_verified',reason:'認証環境変数が未設定',missing,models:targets.map(t=>t.modelName)}));
    return 1;
  }
  // Evidence searches omit affiliateId so returned links cannot contain it.
  const credentials = {applicationId:env[names[0]],accessKey:env[names[1]]};
  const redact = value => names.map(name=>env[name]).reduce((text,secret)=>text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]'),String(value || ''));
  let failed = false;
  for(const target of targets) {
    try {
      const items = responseItems(await searchItems({keyword:target.keyword,hits:10},credentials,fetchImpl));
      write(JSON.stringify({category:target.category,modelName:target.modelName,status:'requires_manual_review',candidates:items.map(item=>({
        itemCode:redact(item.itemCode),itemName:redact(item.itemName),itemCaption:redact(item.itemCaption),
        itemPrice:Number.isSafeInteger(item.itemPrice) && item.itemPrice > 0 ? item.itemPrice : null,
        availability:item.availability === 1 ? 1 : 0,
        itemUrl:redact(publicItemUrl(item.itemUrl)),
      }))}));
    } catch {
      failed = true;
      // Native errors may contain request URLs or credentials. Never print them.
      write(JSON.stringify({modelName:target.modelName,status:'not_verified',reason:'楽天API照会失敗（接続・認証・応答形式を確認）'}));
    }
  }
  return failed ? 1 : 0;
}
if (require.main === module) main().then(code=>{process.exitCode=code;}).catch(()=>{
  console.error('商品照合に失敗しました'); process.exitCode=1;
});
module.exports = {main};
