const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ppter-server-test-'));
const received = { generations: [], uploads: [], responses: [] };
let mockBase = '';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const mockServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/uploads/images') {
    const body = await readBody(req);
    received.uploads.push({ authorization: req.headers.authorization, contentType: req.headers['content-type'], size: body.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 200, data: [{ url: 'https://cdn.example.test/reference.png' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/images/generations') {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    received.generations.push({ authorization: req.headers.authorization, body });
    const statusMatch = body.prompt.match(/error-(401|402|429|500)/);
    if (statusMatch) {
      res.statusCode = Number(statusMatch[1]);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'raw upstream message' } }));
      return;
    }
    if (body.prompt.includes('network-error')) {
      req.socket.destroy();
      return;
    }
    const taskId = body.prompt.includes('recover') ? 'task-recover' : body.prompt.includes('failed-task') ? 'task-failed' : 'task-array';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 200, data: [{ task_id: taskId, status: 'submitted' }] }));
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/tasks/')) {
    const taskId = decodeURIComponent(req.url.split('/').pop());
    res.setHeader('Content-Type', 'application/json');
    if (taskId === 'task-failed') {
      res.end(JSON.stringify({ data: { id: taskId, status: 'failed', fail_reason: '内容不符合要求' } }));
      return;
    }
    res.end(JSON.stringify({
      code: 200,
      data: {
        id: taskId,
        status: 'completed',
        progress: 100,
        output: { data: [{ image_url: `${mockBase}/generated.png` }] },
      },
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/responses') {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    received.responses.push({ authorization: req.headers.authorization, body });
    const serialized = JSON.stringify(body);
    res.setHeader('Content-Type', 'application/json');
    if (serialized.includes('empty-reply')) {
      res.end(JSON.stringify({ code: 200, data: { choices: [{ message: { content: '   ' } }] } }));
      return;
    }
    const text = serialized.includes('最终分页图片提示词')
      ? '页面类型：封面\n标题：开源发布\n<!-- PAGE -->\n页面类型：总结页\n标题：下一步'
      : '请补充受众和页数。';
    res.end(JSON.stringify({
      code: 200,
      data: {
        model: body.model,
        choices: [{ message: { role: 'assistant', content: text } }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      },
    }));
    return;
  }
  if (req.method === 'GET' && req.url === '/generated.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(PNG);
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

let appServer;
let appBase;
let serverModule;

test.before(async () => {
  const mockPort = await listen(mockServer);
  mockBase = `http://127.0.0.1:${mockPort}`;
  process.env.PPTER_DATA_DIR = path.join(tempRoot, 'data');
  process.env.PPTER_ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.PPTER_DOWNLOADS_DIR = path.join(tempRoot, 'downloads');
  process.env.APIMART_API_BASE = mockBase;
  process.env.APIMART_MAX_RETRIES = '0';
  delete process.env.APIMART_API_KEY;
  delete process.env.API_KEY;
  serverModule = require('../server');
  const started = serverModule.startServer({ port: 0, host: '127.0.0.1' });
  appServer = started.server;
  if (!appServer.listening) await new Promise(resolve => appServer.once('listening', resolve));
  appBase = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  await close(appServer);
  await close(mockServer);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function api(url, options = {}) {
  const response = await fetch(`${appBase}${url}`, options);
  const data = await response.json();
  return { response, data };
}

function json(body, method = 'POST') {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

test('配置接口只返回状态，不泄露 Key', async () => {
  const key = 'apimart-test-secret-key-123456';
  let result = await api('/api/config');
  assert.deepEqual(result.data, { success: true, configured: false });
  result = await api('/api/config', json({ apiKey: key }));
  assert.equal(result.response.status, 200);
  result = await api('/api/config');
  assert.deepEqual(result.data, { success: true, configured: true });
  assert.doesNotMatch(JSON.stringify(result.data), new RegExp(key));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempRoot, 'data', 'config.json'), 'utf8')).imageApiKey, key);
});

test('PPT 项目可以创建、保存、切换并出现在左侧列表数据中', async () => {
  const initial = await api('/api/projects');
  assert.equal(initial.response.status, 200);
  assert.ok(initial.data.projects.length >= 1);

  const created = await api('/api/projects', json({ name: '季度发布会' }));
  assert.equal(created.response.status, 201);
  assert.equal(created.data.project.meta.name, '季度发布会');
  const projectId = created.data.project.id;

  const saved = await api(`/api/projects/${projectId}`, json({
    ...created.data.project,
    meta: { ...created.data.project.meta, name: '季度发布会 2026' },
    rows: [{ id: 1, prompt: '封面页', status: 'completed' }],
  }, 'PUT'));
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.project.pageCount, 1);
  assert.equal(saved.data.project.completedCount, 1);

  const activated = await api(`/api/projects/${projectId}/activate`, json({}));
  assert.equal(activated.data.project.meta.name, '季度发布会 2026');
  const current = await api('/api/project');
  assert.equal(current.data.meta.id, projectId);

  const list = await api('/api/projects');
  assert.ok(list.data.projects.some(project => project.id === projectId && project.name === '季度发布会 2026'));
});

test('参考图由后端代理上传并兼容数组响应', async () => {
  const result = await api('/api/reference-images', json({
    name: 'reference.png',
    mime: 'image/png',
    dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
  }));
  assert.equal(result.response.status, 200);
  assert.ok(result.data.reference.id);
  assert.match(result.data.reference.previewUrl, /^\/assets\/references\//);
  assert.equal(received.uploads[0].authorization, 'Bearer apimart-test-secret-key-123456');
  assert.match(received.uploads[0].contentType, /^multipart\/form-data;/);

  const mismatch = await api('/api/reference-images', json({
    name: 'bad.png',
    mime: 'image/png',
    dataUrl: `data:image/jpeg;base64,${PNG.toString('base64')}`,
  }));
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.data.code, 'REFERENCE_TYPE_MISMATCH');
});

test('提交参数被固定，轮询兼容对象结果并保存本地图片', async () => {
  const referenceStore = JSON.parse(fs.readFileSync(path.join(tempRoot, 'data', 'references.json'), 'utf8'));
  const referenceId = Object.keys(referenceStore.references)[0];
  const submitted = await api('/api/generate', json({
    params: { model: 'other-model', prompt: 'normal-generation', size: '1:1', resolution: '2k', quality: 'high', n: 9, output_format: 'jpeg' },
    referenceIds: [referenceId],
    rowId: 3,
    pageNumber: 2,
    project: '测试项目',
    idempotencyKey: 'integration-normal',
  }));
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.data.taskId, 'task-array');
  const upstream = received.generations.at(-1);
  assert.deepEqual({
    model: upstream.body.model,
    size: upstream.body.size,
    resolution: upstream.body.resolution,
    quality: upstream.body.quality,
    n: upstream.body.n,
    output_format: upstream.body.output_format,
  }, { model: 'gpt-image-2-official', size: '16:9', resolution: '2k', quality: 'auto', n: 1, output_format: 'png' });
  assert.deepEqual(upstream.body.image_urls, ['https://cdn.example.test/reference.png']);

  const polled = await api('/api/task-status', json({ taskId: 'task-array', pageNumber: 2, project: '测试项目' }));
  assert.equal(polled.data.task.status, 'completed');
  assert.match(polled.data.task.resultUrl, /^\/ppt_images\//);
  const savedFiles = fs.readdirSync(path.join(tempRoot, 'downloads'), { recursive: true });
  assert.ok(savedFiles.some(file => String(file).endsWith('.png')));
});

test('未完成任务可自动恢复，失败任务会归一化', async () => {
  const submitted = await api('/api/generate', json({
    params: { prompt: 'recover-this-task' },
    idempotencyKey: 'integration-recover',
  }));
  assert.equal(submitted.data.taskId, 'task-recover');
  const recovered = await api('/api/recover-tasks');
  assert.ok(recovered.data.tasks.some(task => task.taskId === 'task-recover'));

  await api('/api/generate', json({ params: { prompt: 'failed-task' }, idempotencyKey: 'integration-failed' }));
  const failed = await api('/api/task-status', json({ taskId: 'task-failed' }));
  assert.equal(failed.data.task.status, 'failed');
  assert.equal(failed.data.task.error, '内容不符合要求');
});

for (const [status, code, message] of [
  [401, 'API_KEY_INVALID', 'API Key 无效'],
  [402, 'APIMART_BALANCE_INSUFFICIENT', '余额不足'],
  [429, 'APIMART_RATE_LIMIT', '请求过于频繁'],
  [500, 'APIMART_SERVICE_ERROR', '服务暂时异常'],
]) {
  test(`APIMart ${status} 返回标准化提示`, async () => {
    const result = await api('/api/generate', json({ params: { prompt: `error-${status}` }, force: true }));
    assert.equal(result.response.status, status);
    assert.equal(result.data.code, code);
    assert.match(result.data.error, new RegExp(message));
    assert.equal(result.data.docsUrl, 'https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/official');
    assert.equal(result.data.actionUrl, 'https://apimart.ai/zh');
  });
}

test('网络断开返回可重试提示', async () => {
  const result = await api('/api/generate', json({ params: { prompt: 'network-error' }, force: true }));
  assert.equal(result.response.status, 502);
  assert.equal(result.data.code, 'APIMART_UNREACHABLE');
  assert.equal(result.data.retryable, true);
});

test('响应归一化函数兼容数组与对象', () => {
  assert.equal(serverModule.normalizeSubmission({ data: [{ task_id: 'a' }] }).taskId, 'a');
  assert.equal(serverModule.normalizeSubmission({ data: { id: 'b' } }).taskId, 'b');
  assert.deepEqual(serverModule.resultUrls({ data: [{ url: ['https://a.test/1.png', 'https://a.test/2.png'] }] }), ['https://a.test/1.png', 'https://a.test/2.png']);
  assert.equal(serverModule.normalizeUpload({ data: { image_url: 'https://a.test/ref.png' } }).url, 'https://a.test/ref.png');
  assert.equal(serverModule.extractResponseText({
    code: 200,
    data: { choices: [{ message: { content: '直接文本' } }] },
  }), '直接文本');
  assert.equal(serverModule.extractResponseText({
    choices: [{ message: { content: [{ type: 'output_text', text: '分段' }] } }],
  }), '分段');
  assert.equal(serverModule.extractResponseText({ data: { output_text: '输出文本' } }), '输出文本');
});

test('提示词对话走 Responses 接口且不回传 Key', async () => {
  const key = 'apimart-test-secret-key-123456';
  await api('/api/config', { method: 'DELETE' });
  const missing = await api('/api/prompt-chat', json({ messages: [{ role: 'user', content: '做一套介绍' }] }));
  assert.equal(missing.response.status, 400);
  assert.equal(missing.data.code, 'API_KEY_MISSING');
  await api('/api/config', json({ apiKey: key }));

  const empty = await api('/api/prompt-chat', json({ messages: [{ role: 'user', content: '   ' }] }));
  assert.equal(empty.response.status, 400);
  assert.equal(empty.data.code, 'PROMPT_INTENT_EMPTY');

  const chat = await api('/api/prompt-chat', json({
    model: 'not-a-model',
    messages: [{ role: 'user', content: '做一套 8 页的管理层介绍' }],
  }));
  assert.equal(chat.response.status, 200);
  assert.equal(chat.data.content, '请补充受众和页数。');
  assert.equal(chat.data.model, 'gpt-5.2-pro');
  assert.equal(chat.data.usage.total_tokens, 18);
  assert.doesNotMatch(JSON.stringify(chat.data), new RegExp(key));
  const upstream = received.responses.at(-1);
  assert.equal(upstream.authorization, `Bearer ${key}`);
  assert.equal(upstream.body.model, 'gpt-5.2-pro');
  assert.equal(upstream.body.stream, false);
  assert.equal(upstream.body.tools, undefined);
  assert.equal(upstream.body.input[0].role, 'system');
  assert.equal(upstream.body.input[0].content[0].type, 'input_text');
  assert.match(upstream.body.input[0].content[0].text, /视觉策划师/);

  const finalized = await api('/api/prompt-chat', json({
    model: 'qwen3.8-max',
    finalize: true,
    messages: [
      { role: 'user', content: '8页管理层安全介绍' },
      { role: 'assistant', content: '受众已经明确。' },
    ],
  }));
  assert.match(finalized.data.content, /<!-- PAGE -->/);
  const finalInput = received.responses.at(-1).body.input;
  assert.equal(received.responses.at(-1).body.model, 'qwen3.8-max');
  assert.equal(finalInput[1].role, 'user');
  assert.equal(finalInput[2].role, 'assistant');
  assert.equal(finalInput.at(-1).role, 'user');
  assert.match(finalInput.at(-1).content[0].text, /最终分页图片提示词/);

  const blank = await api('/api/prompt-chat', json({ messages: [{ role: 'user', content: 'empty-reply' }] }));
  assert.equal(blank.response.status, 502);
  assert.equal(blank.data.code, 'APIMART_EMPTY_RESPONSE');
  assert.equal(blank.data.docsUrl, 'https://docs.apimart.ai/cn/api-reference/texts/openai/responses');
});

test('可以删除历史项目，并只删除该项目引用的本地图片', async () => {
  const downloads = process.env.PPTER_DOWNLOADS_DIR;
  const imageDir = path.join(downloads, '2026-09-26', 'to-delete');
  fs.mkdirSync(imageDir, { recursive: true });
  const image = path.join(imageDir, 'page.png');
  fs.writeFileSync(image, PNG);
  const shared = path.join(downloads, 'shared-keep.png');
  fs.writeFileSync(shared, PNG);
  const outside = path.join(tempRoot, 'outside-keep.txt');
  fs.writeFileSync(outside, 'keep');

  const removed = await api('/api/projects', json({ name: '待删除项目' }));
  const removedId = removed.data.project.id;
  const kept = await api('/api/projects', json({ name: '保留项目' }));
  const keptId = kept.data.project.id;
  await api(`/api/projects/${keptId}`, json({
    ...kept.data.project,
    rows: [{ id: 1, prompt: '保留', status: 'completed', resultUrl: '/ppt_images/shared-keep.png' }],
  }, 'PUT'));
  await api(`/api/projects/${removedId}`, json({
    ...removed.data.project,
    rows: [{
      id: 1,
      prompt: '封面',
      status: 'completed',
      resultUrl: '/ppt_images/2026-09-26/to-delete/page.png',
      result: { images: [{ local_url: '/ppt_images/../../outside-keep.txt' }] },
    }],
  }, 'PUT'));
  await api(`/api/projects/${removedId}/activate`, json({}));

  const deleted = await api(`/api/projects/${removedId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.data.projects.some(project => project.id === removedId), false);
  assert.equal(deleted.data.activeProjectId, keptId);
  assert.equal(fs.existsSync(image), false);
  assert.equal(fs.existsSync(shared), true);
  assert.equal(fs.existsSync(outside), true);
  const current = await api('/api/project');
  assert.equal(current.data.meta.id, keptId);

  const missing = await api('/api/projects/does-not-exist', { method: 'DELETE' });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.data.code, 'PROJECT_NOT_FOUND');
});

test('删掉最后一个历史项目后会留下一条空白项目', async () => {
  let list = await api('/api/projects');
  let guard = 0;
  while (list.data.projects.length && guard < 20) {
    const id = list.data.projects[0].id;
    const deleted = await api(`/api/projects/${id}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    assert.ok(deleted.data.projects.length >= 1);
    if (!deleted.data.projects.some(project => project.id === id)) {
      const replacement = deleted.data.projects.length === 1 && deleted.data.projects[0].pageCount === 0;
      if (replacement) {
        list = deleted;
        break;
      }
    }
    list = deleted;
    guard += 1;
  }
  assert.equal(list.data.projects.length, 1);
  assert.equal(list.data.projects[0].pageCount, 0);
  const current = await api('/api/project');
  assert.equal(current.data.meta.id, list.data.activeProjectId);
  assert.deepEqual(current.data.rows, []);
});
