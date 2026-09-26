const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fflate = require('fflate');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function loadCurrentBuilder() {
  const source = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('  function xmlEscape(value)');
  const end = source.indexOf('  async function exportPpt()', start);
  assert.ok(start >= 0 && end > start, '应能定位当前 PPTX 构建函数');
  return new Function('window', `${source.slice(start, end)}\nreturn buildPptx;`)({ fflate });
}

test('PPTX 包含完整的单页图片演示结构', () => {
  const buildPptx = loadCurrentBuilder();
  const bytes = buildPptx([{ filename: 'page_01.png', ext: 'png', bytes: new Uint8Array(PNG) }]);
  const files = fflate.unzipSync(bytes);
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slides/slide1.xml',
    'ppt/slides/_rels/slide1.xml.rels',
    'ppt/media/image1.png',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/theme/theme1.xml',
  ]) assert.ok(files[required], `缺少 ${required}`);
  assert.equal(Buffer.compare(Buffer.from(files['ppt/media/image1.png']), PNG), 0);
  assert.match(fflate.strFromU8(files['ppt/presentation.xml']), /screen16x9/);
  assert.match(fflate.strFromU8(files['ppt/slides/slide1.xml']), /cx="12192000" cy="6858000"/);
});

test('PPTX 可被 LibreOffice 打开并转换', t => {
  const probe = spawnSync('soffice', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('当前环境未安装 LibreOffice');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppter-pptx-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const buildPptx = loadCurrentBuilder();
  const pptx = path.join(tempDir, 'ppter-test.pptx');
  fs.writeFileSync(pptx, buildPptx([{ filename: 'page_01.png', ext: 'png', bytes: new Uint8Array(PNG) }]));
  const converted = spawnSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, pptx], { encoding: 'utf8', timeout: 30000 });
  assert.equal(converted.status, 0, `${converted.stdout}\n${converted.stderr}`);
  assert.ok(fs.statSync(path.join(tempDir, 'ppter-test.pdf')).size > 0);
});
