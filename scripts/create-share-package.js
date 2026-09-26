#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { zipSync } = require('fflate');
const packageJson = require('../package.json');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'dist');
const PACKAGE_ROOT = `ppter-${packageJson.version}`;
const ALLOWLIST = [
  'package.json',
  'package-lock.json',
  'LICENSE',
  'config.example.json',
  'server.js',
  'index.html',
  'help.html',
  'README.md',
  'CHANGELOG.md',
  '提示词模板与示例.md',
  'start-server.bat',
  'start-server.command',
  'start-server.sh',
  'public/app.js',
  'public/batch-runner.js',
  'public/prompt-parser.js',
  'public/prompt-templates.js',
  'public/styles.css',
  'scripts/start.js',
  'scripts/codex-cli.js',
  'scripts/create-share-package.js',
  'examples/demo-prompts.txt',
];
const EXECUTABLES = new Set(['start-server.command', 'start-server.sh', 'scripts/start.js', 'scripts/codex-cli.js']);
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?:APIMART_API_KEY|API_KEY)\s*=\s*["']?[^\s"']{12,}/gi,
  /(?:api[_ -]?key|access[_ -]?token)["']?\s*[:=]\s*["'](?!YOUR_|你的|<)[A-Za-z0-9._-]{16,}["']/gi,
  /Authorization:\s*Bearer\s+(?!YOUR_API_KEY|<token>)[A-Za-z0-9._-]{16,}/gi,
];

function assertSafe(relativePath, bytes) {
  const text = bytes.toString('utf8');
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) throw new Error(`检测到疑似密钥，已停止打包: ${relativePath}`);
  }
}

function buildArchive() {
  const entries = {};
  for (const relativePath of ALLOWLIST) {
    const absolutePath = path.join(ROOT_DIR, relativePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`分享文件缺失: ${relativePath}`);
    const bytes = fs.readFileSync(absolutePath);
    assertSafe(relativePath, bytes);
    const archivePath = `${PACKAGE_ROOT}/${relativePath.split(path.sep).join('/')}`;
    entries[archivePath] = EXECUTABLES.has(relativePath)
      ? [new Uint8Array(bytes), { os: 3, attrs: 0o100755 << 16 }]
      : new Uint8Array(bytes);
  }
  return zipSync(entries, { level: 9 });
}

function main() {
  const archive = buildArchive();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = path.join(OUTPUT_DIR, `ppter-${packageJson.version}-clean.zip`);
  fs.writeFileSync(output, archive);
  console.log(`干净分享包已生成: ${output}`);
  console.log(`文件数: ${ALLOWLIST.length}`);
  console.log('已排除 data、assets、ppt_images、attachments、node_modules、日志和 Agent 内部文件。');
}

if (require.main === module) main();

module.exports = { ALLOWLIST, PACKAGE_ROOT, assertSafe, buildArchive };
