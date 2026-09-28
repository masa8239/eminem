'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function app() {
  const elements = new Map();
  const document = {addEventListener(){},getElementById(id){
    if (!elements.has(id)) elements.set(id,{value:'',innerHTML:'',textContent:'',style:{}});
    return elements.get(id);
  }};
  const context = vm.createContext({document,window:{addEventListener(){}},localStorage:{getItem(){return null;}},URL,URLSearchParams,console});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1].split('// ===== INIT =====')[0],context);
  return {run: code=>vm.runInContext(code,context),document,context};
}

test('explicit yen and man-yen retain their units, decimals and grouping',()=>{
  const {run}=app();
  for(const [value,unit,expected] of [[98000,'円',98000],['98,000','円',98000],['￥９８，０００',null,98000],['9.8万円',null,98000],[9.8,'万円',98000],['19.99万円',null,199900],['98000円',null,98000]]) {
    assert.equal(run(`parsePrice(${JSON.stringify(value)},${JSON.stringify(unit)})`),expected);
  }
  assert.equal(run("sheetPrice({'価格（万円）':9.8})"),98000);
  assert.equal(run("fmtPrice(sheetPrice({'価格':'9.8万円'}))"),'¥98,000');
  assert.equal(run("sheetPrice({'価格(円)':549800})"),549800);
});

test('unknown, malformed, conflicting, fractional and suspicious prices are excluded',()=>{
  const {run}=app();
  for(const value of [null,'',0,-98000,'-98,000円','不明','約9.8万円','9.8万円〜','9,80円','98abc','Infinity','1e5',true,[],{},91,98,87.9,'9.8万円']) {
    assert.equal(run(`sheetPrice({'価格(円)':${JSON.stringify(value)}})`),null,JSON.stringify(value));
  }
  assert.equal(run("sheetPrice({'価格':98000})"),null);
  assert.equal(run("sheetPrice({'価格(円)':0,'価格':'9.8万円'})"),null);
  for(const price of ['null','NaN','Infinity','-1','0','"98000"','true']) {
    assert.equal(run(`costPerformance({price:${price},score:30070})`),null);
    assert.equal(run(`fmtPrice(${price})`),'価格不明');
  }
});

test('actual sheet response reproduces 5080/9070 XT bug without inventing a price',()=>{
  const {run,context}=app();
  context.rows=require('./fixtures/gpu-price-source.json').rows;
  run('gpuData=rows.map(parseGpuRow)');
  assert.equal(run('gpuData[0].price'),549800);
  assert.equal(run('gpuData[1].price'),null);
  assert.equal(run('gpuData[2].price'),null);
  assert.equal(run('gpuData[3].price'),null);
  assert.equal(run('gpuData[2].cospa'),null);
  assert.equal(run("gpuData[2].badge.includes('コスパ')"),false);
  assert.match(run('renderPrice(gpuData[2])'),/価格不明/);
});

test('CPU GPU RAM rendering and cost sorting exclude unknown prices in either direction',()=>{
  const {run,document}=app();
  for(const cat of ['cpu','gpu','ram']) {
    const parser={cpu:'parseCpuRow',gpu:'parseGpuRow',ram:'parseRamRow'}[cat];
    run(`${cat}Data=[${parser}({'CPU名':'unknown','GPU名':'unknown','製品名':'unknown','スコア':30070,'速度':6000,'容量':32,'価格(円)':98}),${parser}({'CPU名':'valid','GPU名':'valid','製品名':'valid','スコア':30070,'速度':6000,'容量':32,'価格':'9.8万円'})]`);
    const render={cpu:'renderCpuTable',gpu:'renderGpuTable',ram:'renderRamTable'}[cat];
    run(`${render}()`);
    assert.match(document.getElementById(cat+'-table-body').innerHTML,/価格不明/);
    assert.doesNotMatch(document.getElementById(cat+'-table-body').innerHTML,/¥98<|Infinity|NaN|¥—/);
    for(const dir of [1,-1]) {
      run(`${cat}SortKey='cospa';${cat}SortDir=${dir};${render}()`);
      assert.doesNotMatch(document.getElementById(cat+'-table-body').innerHTML,/unknown/);
      assert.match(document.getElementById(cat+'-table-body').innerHTML,/valid/);
      assert.equal(run(`sortParts(${cat}Data,'price',${dir})[1].name`),'unknown');
    }
  }
});

test('empty price sets and yen conversion do not create bogus cost badges',()=>{
  const {run}=app();
  assert.equal(run("parseGpuRow({'GPU名':'test','スコア':30070,'価格':'9.8万円'}).cospa"),30070/98000);
  assert.equal(run("parseCpuRow({'CPU名':'test','スコア':30070,'価格(円)':''}).cospa"),null);
  assert.equal(run("parseRamRow({'製品名':'test','速度':6000,'容量':32,'価格(円)':''}).badge.includes('コスパ')"),false);
  assert.equal(run("sortParts([{price:null,score:1}],'cospa',1).length"),0);
});

test('empty CPU results clear all previously rendered tabs',()=>{
  const {run,document}=app();
  run('renderCpuTable(); cpuData=[]; renderCpuTable()');
  for(const id of ['cpu-table-body','cpu-single-body','cpu-cospa-body']) {
    assert.match(document.getElementById(id).innerHTML,/条件に一致するCPUがありません/);
  }
});

test('Rakuten yen is not multiplied and invalid successful payload is not labelled current',async()=>{
  const {run,context}=app();
  context.AbortSignal=AbortSignal;
  run("gpuData=[parseGpuRow({'GPU名':'verified','スコア':30070,'価格(円)':98})]");
  context.fetch=async()=>({json:async()=>({products:[{category:'gpu',modelName:'verified',status:'ok',price:98000,fetchedAt:'2026-09-29T00:00:00Z',url:'https://example.test'}]})});
  await run('loadRakutenPrices()');
  assert.equal(run('gpuData[0].price'),98000);
  assert.match(run('renderPrice(gpuData[0])'),/¥98,000/);
  assert.match(run('renderPrice(gpuData[0])'),/取得元: 楽天市場/);
  context.fetch=async()=>({json:async()=>({products:[{category:'gpu',modelName:'verified',status:'ok',price:-1}]})});
  await run('loadRakutenPrices()');
  assert.equal(run('gpuData[0].rakuten.status'),'error');
  assert.match(run('renderPrice(gpuData[0])'),/最新扱いではありません/);
});
