#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const PromptParser = require('../public/prompt-parser');
const packageJson = require('../package.json');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_PORT = Number(process.env.PORT || 17890);
const DEFAULT_SERVER = process.env.PPTER_SERVER || `http://127.0.0.1:${DEFAULT_PORT}`;
const MODEL = 'gpt-image-2-official';
const STYLES = {
  consulting: '专业咨询报告风格，16:9 横版商务演示视觉，白色留白充足，深蓝、黑灰与少量强调色，信息层级清楚，图表与结构图简洁，适合正式汇报，避免装饰堆叠',
  minimal: '极简产品发布会风格，16:9 横版，浅色背景，大面积留白，黑白灰为主，单一高饱和强调色，主体聚焦，精致光影，避免拥挤和无关装饰',
  tech: '现代科技企业宣传风格，16:9 横版，蓝白与深灰配色，清晰网格，适度数据与科技元素，专业可信，画面整洁，适合产品方案和企业介绍',
  warm: '温暖商业插画风格，16:9 横版，明亮柔和，人物与场景自然，色彩丰富但克制，亲和可信，适合品牌故事和企业文化，避免幼稚卡通感',
  custom: '',
};
const STYLE_ALIASES = { mckinsey: 'consulting', apple: 'minimal' };
const BOOLEAN_OPTIONS = new Set(['json', 'help', 'h', 'version', 'no-start', 'open', 'wait', 'download', 'stdin', 'append', 'no-review', 'force', '2k', '4k', 'refresh']);

function setOption(options, key, value) {
  if (options[key] === undefined) options[key] = value;
  else if (Array.isArray(options[key])) options[key].push(value);
  else options[key] = [options[key], value];
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-h') { options.help = true; continue; }
    if (arg === '-j') { options.json = true; continue; }
    if (!arg.startsWith('--')) { options._.push(arg); continue; }
    const raw = arg.slice(2);
    const separator = raw.indexOf('=');
    if (separator >= 0) {
      setOption(options, raw.slice(0, separator), raw.slice(separator + 1));
      continue;
    }
    if (BOOLEAN_OPTIONS.has(raw)) {
      setOption(options, raw, true);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) setOption(options, raw, true);
    else { setOption(options, raw, next); index++; }
  }
  return options;
}

function printHelp() {
  console.log(`ppter ppt CLI v${packageJson.version}

用法:
  node scripts/codex-cli.js <command> [options]

命令:
  health                         检查并按需启动本地服务
  config get|set|clear           查看状态、保存或清空 APIMart Key
  batch [options]                将分页提示词写入网页等待人工确认
  generate [options]             生成一张图片，可等待并下载
  task <taskId> [--refresh]      查看任务缓存或刷新状态
  manifest                       输出机器可读的能力清单

批量导入:
  node scripts/codex-cli.js batch --file prompts.txt --name "宣传手册" --open
  node scripts/codex-cli.js batch --json-file prompts.json --style tech --2k --open --json
  type prompts.txt | node scripts/codex-cli.js batch --stdin --open

单图生成:
  node scripts/codex-cli.js generate --prompt "16:9 科技企业产品架构页" --wait --download

通用选项:
  --server <url>                 默认 ${DEFAULT_SERVER}
  --json                         输出稳定 JSON
  --no-start                     服务未启动时直接失败
  --api-key <key>                本次命令临时使用的 Key
  --2k / --4k                    调整清晰度，默认 1K
`);
}

function serverUrl(options) {
  return String(options.server || DEFAULT_SERVER).replace(/\/$/, '');
}

async function requestJson(server, method, apiPath, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${server}${apiPath}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!response.ok || data.success === false) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = data.code;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function serviceHealthy(server, timeoutMs = 1500) {
  try {
    await requestJson(server, 'GET', '/api/health', undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function ensureServer(options) {
  const server = serverUrl(options);
  if (await serviceHealthy(server)) return { server, started: false };
  if (options['no-start']) throw new Error(`本地服务未启动: ${server}`);
  const url = new URL(server);
  const port = Number(url.port || 17890);
  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port), HOST: url.hostname },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await serviceHealthy(server)) return { server, started: true, pid: child.pid };
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error('本地服务启动超时，请双击启动器查看错误信息');
}

function output(options, value, human) {
  if (options.json) console.log(JSON.stringify(value, null, 2));
  else human(value);
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'darwin') { command = 'open'; args = [url]; }
  else if (process.platform === 'win32') { command = 'cmd'; args = ['/c', 'start', '', url]; }
  else { command = 'xdg-open'; args = [url]; }
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error || result.status !== 0) throw result.error || new Error('无法自动打开浏览器');
}

function readText(file) {
  const resolved = path.resolve(String(file || ''));
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  return fs.readFileSync(resolved, 'utf8');
}

function normalizePromptItems(value) {
  const raw = Array.isArray(value) ? value : value?.prompts || value?.pages || value?.rows || [];
  if (!Array.isArray(raw)) throw new Error('JSON 必须是数组或包含 prompts/pages/rows 数组');
  return raw.map((item, index) => typeof item === 'string'
    ? { title: `第 ${index + 1} 页`, prompt: item.trim() }
    : { title: item?.title || item?.name || `第 ${index + 1} 页`, prompt: String(item?.prompt || item?.content || item?.text || '').trim() })
    .filter(item => item.prompt);
}

function batchPrompts(args, options) {
  if (options['json-file'] && options['json-file'] !== true) return normalizePromptItems(JSON.parse(readText(options['json-file'])));
  if (options.prompt) {
    const values = Array.isArray(options.prompt) ? options.prompt : [options.prompt];
    return values.map((prompt, index) => ({ title: `第 ${index + 1} 页`, prompt: String(prompt) }));
  }
  let text;
  if (options.stdin) text = fs.readFileSync(0, 'utf8');
  else {
    const file = options.file || args[0];
    if (!file || file === true) throw new Error('请使用 --file、--json-file、--stdin 或 --prompt 提供提示词');
    text = readText(file);
  }
  if (String(options.format || '').toLowerCase() === 'json' || /^[\s]*[\[{]/.test(text)) {
    try { return normalizePromptItems(JSON.parse(text)); } catch { /* 使用文本解析 */ }
  }
  return PromptParser.parse(text);
}

function resolution(options) {
  if (options['4k']) return '4k';
  if (options['2k']) return '2k';
  return ['1k', '2k', '4k'].includes(options.resolution) ? options.resolution : '1k';
}

function styleSettings(options) {
  const requested = String(options.style || 'consulting');
  const style = STYLE_ALIASES[requested] || (STYLES[requested] !== undefined ? requested : 'custom');
  const prefix = options.prefix && options.prefix !== true ? String(options.prefix) : STYLES[style];
  return {
    globalPrefix: prefix,
    stylePreset: style,
    globalParams: { size: '16:9', resolution: resolution(options), quality: 'auto', n: 1, output_format: 'png' },
    autoDownload: true,
  };
}

async function waitForReview(server) {
  const deadline = Date.now() + 24 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const data = await requestJson(server, 'GET', '/api/project/status');
    if (!data.meta?.reviewRequired) return data;
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw new Error('等待人工确认超时');
}

async function handleHealth(options) {
  const status = await ensureServer(options);
  const health = await requestJson(status.server, 'GET', '/api/health');
  output(options, { ...health, ...status }, data => console.log(`ppter ppt v${data.version} ${data.started ? '已启动' : '正在运行'}: ${data.server}`));
}

async function handleConfig(args, options) {
  const { server } = await ensureServer(options);
  const action = args[0] || 'get';
  if (action === 'get') {
    const data = await requestJson(server, 'GET', '/api/config');
    output(options, data, value => console.log(value.configured ? 'APIMart Key 已配置' : '尚未配置 APIMart Key'));
    return;
  }
  if (action === 'clear') {
    const data = await requestJson(server, 'DELETE', '/api/config');
    output(options, data, () => console.log('APIMart Key 已清空'));
    return;
  }
  if (action === 'set') {
    const apiKey = options['api-key'] || options['image-api-key'] || process.env.APIMART_API_KEY;
    if (!apiKey || apiKey === true) throw new Error('请使用 --api-key 提供 APIMart Key');
    const data = await requestJson(server, 'POST', '/api/config', { apiKey });
    output(options, data, () => console.log('APIMart Key 已保存到本机'));
    return;
  }
  throw new Error(`未知 config 操作: ${action}`);
}

async function handleBatch(args, options) {
  const prompts = batchPrompts(args, options);
  if (!prompts.length) throw new Error('没有解析到有效提示词');
  const { server, started } = await ensureServer(options);
  const data = await requestJson(server, 'POST', '/api/project/import-prompts', {
    name: options.name && options.name !== true ? String(options.name) : undefined,
    prompts,
    settings: styleSettings(options),
    append: Boolean(options.append),
    reviewRequired: !options['no-review'],
    source: options.source && options.source !== true ? String(options.source) : 'cli',
  });
  const url = `${server}/?review=1`;
  if (options.open) openBrowser(url);
  const review = options.wait ? await waitForReview(server) : null;
  const result = { success: true, server, started, promptCount: prompts.length, url, opened: Boolean(options.open), review, project: data.project };
  output(options, result, value => {
    console.log(`已导入 ${value.promptCount} 页提示词`);
    console.log(`页面: ${value.url}`);
    if (!value.opened) console.log('使用 --open 可自动打开浏览器');
  });
}

function taskImageUrl(task) {
  if (task?.resultUrl) return task.resultUrl;
  const value = task?.result?.images?.[0]?.local_url || task?.result?.images?.[0]?.url;
  return Array.isArray(value) ? value[0] : value || null;
}

async function pollTask(server, taskId, body) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const data = await requestJson(server, 'POST', '/api/task-status', { taskId, ...body }, 180000);
    const task = data.task || data;
    if (task.status === 'completed') return task;
    if (task.status === 'failed') throw new Error(task.error || '生成失败');
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw new Error('等待生成结果超时');
}

async function handleGenerate(options) {
  const { server } = await ensureServer(options);
  let prompt = options.prompt && options.prompt !== true ? String(options.prompt) : '';
  if (!prompt && options['prompt-file'] && options['prompt-file'] !== true) prompt = readText(options['prompt-file']);
  if (!prompt.trim()) throw new Error('请使用 --prompt 或 --prompt-file 提供提示词');
  const submitted = await requestJson(server, 'POST', '/api/generate', {
    apiKey: options['api-key'] && options['api-key'] !== true ? options['api-key'] : undefined,
    params: { model: MODEL, prompt, size: '16:9', resolution: resolution(options), quality: 'auto', n: 1, output_format: 'png' },
    idempotencyKey: options['idempotency-key'],
    rowId: options['row-id'] || 'cli',
    pageNumber: options.page,
    force: Boolean(options.force),
    project: options.project || 'cli',
  });
  let task = null;
  let imageUrl = submitted.imageUrl || null;
  if (options.wait || options.download || options.output) {
    task = submitted.completed
      ? await requestJson(server, 'GET', `/api/task-result/${encodeURIComponent(submitted.taskId)}`).then(value => value.task)
      : await pollTask(server, submitted.taskId, { apiKey: options['api-key'], project: options.project || 'cli', pageNumber: options.page });
    imageUrl = taskImageUrl(task);
  }
  let asset = null;
  let outputFile = null;
  if (options.download && imageUrl) {
    asset = await requestJson(server, 'POST', '/api/download', { url: imageUrl, filename: options.filename || 'generated-image', project: options.project || 'cli' }, 180000);
  }
  if (options.output && imageUrl) {
    const finalUrl = imageUrl.startsWith('/') ? `${server}${imageUrl}` : imageUrl;
    const response = await fetch(finalUrl);
    if (!response.ok) throw new Error(`图片下载失败: HTTP ${response.status}`);
    const target = path.resolve(String(options.output));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    outputFile = target;
  }
  const result = { success: true, server, submitted, task, imageUrl, asset, outputFile };
  output(options, result, value => {
    console.log(`任务 ID: ${value.submitted.taskId}`);
    if (value.imageUrl) console.log(`图片: ${value.imageUrl}`);
    if (value.asset?.path) console.log(`已保存: ${value.asset.path}`);
    if (value.outputFile) console.log(`已输出: ${value.outputFile}`);
  });
}

async function handleTask(args, options) {
  const taskId = args[0];
  if (!taskId) throw new Error('缺少 taskId');
  const { server } = await ensureServer(options);
  const data = options.refresh
    ? await requestJson(server, 'POST', '/api/task-status', { taskId, apiKey: options['api-key'], project: options.project || 'cli' }, 180000)
    : await requestJson(server, 'GET', `/api/task-result/${encodeURIComponent(taskId)}`);
  output(options, data, value => {
    const task = value.task || value;
    console.log(`任务 ID: ${task.taskId || taskId}`);
    console.log(`状态: ${task.status || 'unknown'}`);
    if (taskImageUrl(task)) console.log(`图片: ${taskImageUrl(task)}`);
    if (task.error) console.log(`错误: ${task.error}`);
  });
}

function handleManifest() {
  console.log(JSON.stringify({
    success: true,
    name: 'ppter-cli',
    version: packageJson.version,
    defaultServer: DEFAULT_SERVER,
    image: { provider: 'APIMart', model: MODEL, size: '16:9', resolution: '1k', quality: 'auto', n: 1 },
    commands: ['health', 'config get|set|clear', 'batch', 'generate', 'task', 'manifest'],
    promptFormat: { separator: '<!-- PAGE -->', fields: ['页面类型', '标题', '核心观点', '关键信息', '构图', '色彩', '可见文字', '避免项'] },
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];
  const args = options._.slice(1);
  if (options.version) { console.log(packageJson.version); return; }
  if (!command || options.help) { printHelp(); return; }
  switch (command) {
    case 'health': await handleHealth(options); break;
    case 'config': await handleConfig(args, options); break;
    case 'batch': await handleBatch(args, options); break;
    case 'generate': await handleGenerate(options); break;
    case 'task': await handleTask(args, options); break;
    case 'manifest': handleManifest(); break;
    default: throw new Error(`未知命令: ${command}`);
  }
}

main().catch(error => {
  const options = parseArgs(process.argv.slice(2));
  if (options.json) console.error(JSON.stringify({ success: false, error: error.message, code: error.code || '' }, null, 2));
  else console.error(`错误: ${error.message}`);
  process.exitCode = 1;
});
