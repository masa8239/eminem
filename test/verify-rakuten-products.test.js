'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {main}=require('../scripts/verify-rakuten-products');
const env={RAKUTEN_APPLICATION_ID:'fixture-app',RAKUTEN_ACCESS_KEY:'fixture-access',RAKUTEN_AFFILIATE_ID:'fixture-affiliate'};

test('verification reports missing credentials without making requests',async()=>{
  const lines=[];
  assert.equal(await main({},async()=>{assert.fail('network must not be called');},line=>lines.push(line)),1);
  const result=JSON.parse(lines[0]);
  assert.equal(result.status,'not_verified');
  assert.deepEqual(result.models,['Ryzen 9 9950X3D','GeForce RTX 5090']);
});
test('candidate searches are read-only, target both models and do not log secrets',async()=>{
  const lines=[],keywords=[];
  const code=await main(env,async(url,options)=>{
    keywords.push(url.searchParams.get('keyword'));
    assert.equal(url.searchParams.has('affiliateId'),false);
    assert.equal(url.searchParams.has('accessKey'),false);
    assert.equal(options.headers.accessKey,env.RAKUTEN_ACCESS_KEY);
    return {ok:true,json:async()=>({items:[{itemCode:'test:fixture',itemName:'synthetic item',itemCaption:Object.values(env).join(' ')}]})};
  },line=>lines.push(line));
  assert.equal(code,0);
  assert.deepEqual(keywords,['Ryzen 9 9950X3D','GeForce RTX 5090']);
  assert.ok(lines.every(line=>JSON.parse(line).status==='requires_manual_review'));
  for(const secret of Object.values(env)) assert.equal(lines.join('').includes(secret),false);
});
test('verification failures suppress native error details for both models',async()=>{
  const lines=[];
  assert.equal(await main(env,async()=>{throw Error(Object.values(env).join(' '));},line=>lines.push(line)),1);
  assert.equal(lines.length,2);
  assert.ok(lines.every(line=>JSON.parse(line).status==='not_verified'));
  for(const secret of Object.values(env)) assert.equal(lines.join('').includes(secret),false);
});
