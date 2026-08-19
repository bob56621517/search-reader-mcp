'use strict';
// HTTP seam 契约测试共享脚手架:临时数据目录 + testConfig。
// catalog/read/search 三个 HTTP seam 文件共用,消除脚手架复制(Duplicated Code)。
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../dist/config.js');

/** 每个测试文件独立临时目录(pid + 前缀;node --test 各文件独立进程,互不冲突) */
function makeTmpDir(prefix) {
  return path.join(os.tmpdir(), `srm-${prefix}-${process.pid}`);
}

/** testConfig:固定 BOCHA_API_KEY + 隔离数据目录,env 可覆盖 */
function makeTestConfig(tmpDir, overrides = {}) {
  return loadConfig({ BOCHA_API_KEY: 'test-key', SEARCH_READER_MCP_DATA: tmpDir, ...overrides });
}

module.exports = { makeTmpDir, makeTestConfig };
