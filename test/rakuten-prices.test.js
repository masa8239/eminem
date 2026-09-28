'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {validateMapping, extractItem, fetchProduct, buildResponse} = require('../api/rakuten-prices')._test;

const entry = {category: 'cpu', modelName: 'Verified model', itemCode: 'shop:sku'};
const credentials = {applicationId: 'app', accessKey: 'secret', affiliateId: 'affiliate'};

test('mapping requires a category, exact model name, and shop:item code', () => {
  assert.deepEqual(validateMapping([entry]), [entry]);
  assert.throws(() => validateMapping([{category: 'cpu', modelName: 'x', itemCode: 'invented'}]), /不正/);
  assert.throws(() => validateMapping([entry, entry]), /重複/);
});

test('extractItem only accepts an exact item code with a positive price', () => {
  const payload = {Items: [{Item: {itemCode: 'other:sku', itemPrice: 1}}, {Item: {itemCode: 'shop:sku', itemPrice: 12345, affiliateUrl: 'https://example.test/item'}}]};
  assert.deepEqual(extractItem(payload, 'shop:sku'), {price: 12345, url: 'https://example.test/item'});
  assert.throws(() => extractItem(payload, 'missing:sku'), /一致/);
});

test('fetchProduct keeps credentials server-side and sends access key as bearer token', async () => {
  const result = await fetchProduct(entry, credentials, async (url, options) => {
    assert.equal(url.searchParams.get('applicationId'), 'app');
    assert.equal(url.searchParams.get('affiliateId'), 'affiliate');
    assert.equal(url.searchParams.get('itemCode'), 'shop:sku');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    return {ok: true, json: async () => ({Items: [{Item: {itemCode: 'shop:sku', itemPrice: 100, itemUrl: 'https://example.test'}}]})};
  });
  assert.equal(result.price, 100);
});

test('one failed product does not stop successful price results', async () => {
  const entries = [entry, {...entry, modelName: 'Failed model', itemCode: 'shop:failed'}];
  const payload = await buildResponse(entries, credentials, async url => {
    if (url.searchParams.get('itemCode') === 'shop:failed') throw new Error('network down');
    return {ok: true, json: async () => ({Items: [{Item: {itemCode: 'shop:sku', itemPrice: 500, itemUrl: 'https://example.test'}}]})};
  });
  assert.equal(payload.products[0].status, 'ok');
  assert.equal(payload.products[1].status, 'error');
  assert.equal(payload.products[1].fetchedAt, undefined);
});
