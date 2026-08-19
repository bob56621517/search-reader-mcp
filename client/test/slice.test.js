'use strict';
// 纯逻辑测试:read 结果本地切片(与 server sliceText 契约一致)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sliceText, DEFAULT_READ_LENGTH } = require('../dist/slice.js');

test('sliceText:全文不足时不截断、不加提示', () => {
  assert.equal(sliceText('hello', 0, 5000), 'hello');
});

test('sliceText:完整切片返回 [skip, skip+length)(覆盖到全文末尾不截断)', () => {
  assert.equal(sliceText('abcdefghij', 2, 8), 'cdefghij');
});

test('sliceText:截断时尾部追加提示(含全文长度与区间)', () => {
  const full = 'x'.repeat(100);
  const out = sliceText(full, 0, 10);
  assert.ok(out.startsWith('xxxxxxxxxx'));
  assert.match(out, /\[内容已截断:全文约 100 字符,当前返回 0-10/);
});

test('sliceText:skip 续读', () => {
  const full = 'x'.repeat(100);
  const out = sliceText(full, 90, 20);
  assert.equal(out, 'x'.repeat(10)); // 90+20=110 > 100,不足截断
});

test('DEFAULT_READ_LENGTH 为 5000(契约常量)', () => {
  assert.equal(DEFAULT_READ_LENGTH, 5000);
});
