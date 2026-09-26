const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../scripts/codex-cli.js');

test('manifest 只公布精简命令和固定图片参数', () => {
  const result = spawnSync(process.execPath, [cli, 'manifest'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.deepEqual(manifest.commands, ['health', 'config get|set|clear', 'batch', 'generate', 'task', 'manifest']);
  assert.deepEqual(manifest.image, { provider: 'APIMart', model: 'gpt-image-2-official', size: '16:9', resolution: '1k', quality: 'auto', n: 1 });
  assert.doesNotMatch(result.stdout, /markdown|assets|history|arbitrary/i);
});

test('help 不再出现 Markdown、素材查询或任意 API 命令', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\bmd\b|assets|history|api-call/i);
  assert.match(result.stdout, /health[\s\S]*config[\s\S]*batch[\s\S]*generate[\s\S]*task[\s\S]*manifest/);
});
