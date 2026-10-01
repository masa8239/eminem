'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/rakuten-prices');
const {validateMapping, responseItems, extractItem, fetchProduct, buildResponse} = handler._test;

// Synthetic fixtures only; never register these codes.
const entry = {category:'cpu',modelName:'Verified model',itemCode:'test-shop:fixture',itemName:'新品 Verified model boxed',condition:'new'};
const credentials = {applicationId:'test-app',accessKey:'test-access',affiliateId:'test-affiliate'};
const item = {itemCode:entry.itemCode,itemName:entry.itemName,itemPrice:12345,availability:1,itemUrl:'https://example.test/item'};
const payload = value => ({items:[value]});
const response = value => ({ok:true,json:async()=>value});

test('mapping requires API code, exact item name and reviewed new condition',()=>{
  assert.deepEqual(validateMapping([entry]),[entry]);
  for(const bad of [null,{...entry,itemCode:'invented'},{...entry,itemCode:':empty'},{...entry,itemName:''},{...entry,condition:'used'},{...entry,condition:undefined}]) assert.throws(()=>validateMapping([bad]),/不正/);
  assert.throws(()=>validateMapping([entry,entry]),/重複/);
});
test('JSON v2 accepts documented items and observed Items responses',()=>{
  assert.deepEqual(responseItems(payload(item)),[item]);
  assert.deepEqual(responseItems({Items:[item]}),[item]);
  assert.deepEqual(responseItems({Items:[{Item:item}]}),[item]);
  assert.deepEqual(responseItems({items:[]}),[]);
  for(const bad of [null,{}, {items:{}},{error:'wrong_parameter',items:[item]}]) assert.throws(()=>responseItems(bad),/形式/);
});
test('exact API code AND name required, including listing changes',()=>{
  assert.deepEqual(extractItem(payload(item),entry),{price:12345,url:item.itemUrl});
  for(const changed of [{...item,itemCode:'other:fixture'},{...item,itemName:'別製品'},{...item,itemName:'中古 '+entry.itemName},{...item,itemName:undefined}]) assert.throws(()=>extractItem(payload(changed),entry),/一致/);
  assert.throws(()=>extractItem({items:[item,item]},entry),/一致/);
  assert.throws(()=>extractItem({items:[]},entry),/一致/);
});
test('invalid yen values and unavailable items are rejected',()=>{
  for(const price of [0,-1,NaN,Infinity,1.5,true,null,'12345',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>extractItem(payload({...item,itemPrice:price}),entry),/価格/);
  for(const availability of [0,undefined]) assert.throws(()=>extractItem(payload({...item,availability}),entry),/購入可能/);
});
test('HTTPS links required; affiliate URL preferred',()=>{
  assert.equal(extractItem(payload({...item,affiliateUrl:'https://example.test/affiliate'}),entry).url,'https://example.test/affiliate');
  for(const url of ['', 'javascript:alert(1)','http://example.test','https://user:password@example.test']) assert.throws(()=>extractItem(payload({...item,itemUrl:url}),entry),/リンク/);
});
test('current endpoint, accessKey header, JSON v2 and itemCode are sent',async()=>{
  const result=await fetchProduct(entry,credentials,async(url,options)=>{
    assert.equal(url.origin+url.pathname,'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701');
    for(const [key,value] of Object.entries({format:'json',formatVersion:'2',applicationId:credentials.applicationId,affiliateId:credentials.affiliateId,itemCode:entry.itemCode,availability:'1'})) assert.equal(url.searchParams.get(key),value);
    assert.equal(url.searchParams.has('accessKey'),false);
    assert.equal(options.headers.accessKey,credentials.accessKey);
    assert.equal(options.headers.Origin,'https://eminem-zfet.vercel.app');
    assert.equal(options.headers.Authorization,undefined);
    assert.equal(options.redirect,'error');
    assert.ok(options.signal instanceof AbortSignal);
    return response(payload(item));
  });
  assert.equal(result.price,12345);
});
test('partial failure preserves successful prices',async()=>{
  const entries=[entry,{...entry,modelName:'Failed model',itemCode:'test-shop:failed'}];
  const result=await buildResponse(entries,credentials,async url=>{
    if(url.searchParams.get('itemCode')==='test-shop:failed') throw Error('network down');
    return response(payload(item));
  });
  assert.equal(result.products[0].status,'ok');
  assert.ok(result.products[0].fetchedAt);
  assert.equal(result.products[1].status,'error');
  assert.equal(result.products[1].fetchedAt,undefined);
  assert.equal(result.products[1].price,undefined);
});
test('HTTP errors expose only status and do not read upstream error bodies',async()=>{
  for(const status of [400,401,403,429,500,503]) {
    const result=await buildResponse([entry],credentials,async()=>({ok:false,status,json:async()=>{throw Error('must not read error body');}}));
    assert.equal(result.products[0].error,`楽天API HTTP ${status}`);
    assert.equal(result.products[0].fetchedAt,undefined);
  }
});
test('fetch and JSON errors cannot leak credentials to the public response',async()=>{
  const sensitive=Object.values(credentials).join(' ');
  for(const fetchImpl of [async()=>{throw Error(sensitive);},async()=>({ok:true,json:async()=>{throw Error(sensitive);}}),async()=>response({error:sensitive})]) {
    const result=await buildResponse([entry],credentials,fetchImpl);
    assert.equal(result.products[0].status,'error');
    for(const value of Object.values(credentials)) assert.equal(JSON.stringify(result).includes(value),false);
  }
});
test('empty verified mapping does not fabricate products or require credentials',async()=>{
  let code,body;
  const res={setHeader(){},status(value){code=value;return this;},json(value){body=value;return this;}};
  await handler({method:'GET'},res);
  assert.equal(code,200);
  assert.deepEqual(body.products,[]);
});
