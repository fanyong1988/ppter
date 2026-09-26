const test = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync } = require('fflate');

const { ALLOWLIST, PACKAGE_ROOT, assertSafe, buildArchive } = require('../scripts/create-share-package');

test('分享允许清单不包含私人数据且包含完整启动程序', () => {
  const joined = ALLOWLIST.join('\n');
  assert.doesNotMatch(joined, /(^|\/)(data|assets|ppt_images|attachments|node_modules)(\/|$)/);
  assert.doesNotMatch(joined, /AGENTS\.md|CLAUDE\.md|server\.log/);
  for (const required of ['start-server.bat', 'start-server.command', 'start-server.sh', 'scripts/start.js', 'scripts/create-share-package.js', '提示词模板与示例.md', 'help.html', 'public/prompt-templates.js', 'LICENSE', 'config.example.json']) {
    assert.ok(ALLOWLIST.includes(required), `${required} 应在分享包中`);
  }
});

test('疑似 API Key 会阻止打包', () => {
  assert.throws(() => assertSafe('unsafe.txt', Buffer.from('APIMART_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456')), /疑似密钥/);
  assert.throws(() => assertSafe('unsafe.json', Buffer.from('{"apiKey":"apimart_live_abcdefghijklmnopqrstuvwxyz"}')), /疑似密钥/);
});

test('生成的 ZIP 只包含允许清单', () => {
  const files = Object.keys(unzipSync(buildArchive())).sort();
  const expected = ALLOWLIST.map(file => `${PACKAGE_ROOT}/${file}`).sort();
  assert.deepEqual(files, expected);
});
