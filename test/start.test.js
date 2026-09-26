const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const http = require('node:http');

const { dependenciesInstalled, findFreePort, health, nodeVersionSupported, portIsFree } = require('../scripts/start');

test('Node.js 版本检测要求 18 或更高', () => {
  assert.equal(nodeVersionSupported('16.20.2'), false);
  assert.equal(nodeVersionSupported('18.0.0'), true);
  assert.equal(nodeVersionSupported('22.12.0'), true);
});

test('必要依赖已安装', () => {
  assert.equal(dependenciesInstalled(), true);
});

test('端口冲突时寻找后续空闲端口', async t => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => occupied.close());
  const start = occupied.address().port;
  assert.equal(await portIsFree(start), false);
  const selected = await findFreePort(start);
  assert.notEqual(selected, start);
  assert.equal(await portIsFree(selected), true);
});

test('健康检查不会把普通 HTTP 200 服务误认成 PPTER', async t => {
  const ordinary = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    ordinary.once('error', reject);
    ordinary.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => ordinary.close());
  assert.equal(await health(ordinary.address().port), false);
});
