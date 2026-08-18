'use strict';
// 纯逻辑测试:read uri 分类与指令文本(ADR-0010)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { classifyUri, toAbsolutePath, renderUnsupportedPathText } = require('../dist/local-file.js');

const WIN = process.platform === 'win32';

test('classifyUri:http(s):// → http', () => {
  assert.equal(classifyUri('http://example.com/a?b=1'), 'http');
  assert.equal(classifyUri('  https://example.com/page  '), 'http');
});

test('classifyUri:绝对 OS 路径 → file', () => {
  const abs = WIN ? 'C:\\Users\\me\\doc.pdf' : '/home/me/doc.pdf';
  assert.equal(classifyUri(abs), 'file');
});

test('classifyUri:file:/// 绝对 URI → file', () => {
  const fileUri = WIN ? 'file:///C:/Users/me/doc.pdf' : 'file:///home/me/doc.pdf';
  assert.equal(classifyUri(fileUri), 'file');
});

test('classifyUri:相对路径 → relative,不解析', () => {
  assert.equal(classifyUri('doc.pdf'), 'relative');
  assert.equal(classifyUri('docs/readme.md'), 'relative');
});

test('classifyUri:其他 scheme / 空 → invalid', () => {
  assert.equal(classifyUri('ftp://example.com/x'), 'invalid');
  assert.equal(classifyUri('data:text/plain,hi'), 'invalid');
  assert.equal(classifyUri(''), 'invalid');
  assert.equal(classifyUri('   '), 'invalid');
});

test('toAbsolutePath:file:/// 转 OS 绝对路径,绝对路径原样', () => {
  if (WIN) {
    assert.equal(toAbsolutePath('file:///C:/Users/me/doc.pdf'), 'C:\\Users\\me\\doc.pdf');
  } else {
    assert.equal(toAbsolutePath('file:///home/me/doc.pdf'), '/home/me/doc.pdf');
  }
  const abs = WIN ? 'C:\\Users\\me\\doc.pdf' : '/home/me/doc.pdf';
  assert.equal(toAbsolutePath(abs), abs);
});

test('renderUnsupportedPathText:相对路径与无法识别给出指令文本(ADR-0010)', () => {
  const rel = renderUnsupportedPathText('doc.pdf', 'relative');
  assert.match(rel, /read 工具无法解析该地址\("doc\.pdf"\)/);
  assert.match(rel, /相对路径无法确定基准目录/);
  assert.match(rel, /本地文件绝对 OS 路径/);
  const inv = renderUnsupportedPathText('ftp://x', 'invalid');
  assert.match(inv, /无法识别的资源地址/);
});

test('toAbsolutePath:platform 无关的相对路径不应被当作绝对', () => {
  assert.equal(classifyUri('file://relative/x.pdf'), 'invalid');
});
