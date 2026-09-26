const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const packageJson = require('./package.json');
const promptTemplates = require('./public/prompt-templates');

const ROOT_DIR = __dirname;
const DATA_DIR = path.resolve(process.env.PPTER_DATA_DIR || path.join(ROOT_DIR, 'data'));
const ASSETS_DIR = path.resolve(process.env.PPTER_ASSETS_DIR || path.join(ROOT_DIR, 'assets'));
const DOWNLOADS_DIR = path.resolve(process.env.PPTER_DOWNLOADS_DIR || path.join(ROOT_DIR, 'ppt_images'));
const PROJECT_FILE = path.join(DATA_DIR, 'project.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TASK_RESULTS_FILE = path.join(DATA_DIR, 'task-results.json');
const REFERENCES_FILE = path.join(DATA_DIR, 'references.json');
const REFERENCES_DIR = path.join(ASSETS_DIR, 'references');
const APIMART_API_BASE = (process.env.APIMART_API_BASE || 'https://api.apimart.ai').replace(/\/$/, '');
const APIMART_DOCS_URL = 'https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/official';
const TEXT_DOCS_URL = 'https://docs.apimart.ai/cn/api-reference/texts/openai/responses';
const APIMART_ACCOUNT_URL = 'https://apimart.ai/zh';
const MODEL = 'gpt-image-2-official';
const TEXT_MODELS = new Set(promptTemplates.TEXT_MODELS);
const DEFAULT_TEXT_MODEL = promptTemplates.DEFAULT_TEXT_MODEL;
const REQUEST_TTL_MS = Number(process.env.REQUEST_TTL_MS || 30 * 60 * 1000);
const APIMART_MAX_RETRIES = Number(process.env.APIMART_MAX_RETRIES ?? 3);
const APIMART_RETRY_DELAY_MS = Number(process.env.APIMART_RETRY_DELAY_MS ?? 500);
const APIMART_TIMEOUT_MS = Number(process.env.APIMART_TIMEOUT_MS ?? 120000);
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const ALLOWED_REFERENCE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`读取 JSON 失败: ${path.basename(file)} - ${error.message}`);
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function ensureRuntimeFiles() {
  ensureDir(DATA_DIR);
  ensureDir(ASSETS_DIR);
  ensureDir(REFERENCES_DIR);
  ensureDir(DOWNLOADS_DIR);
  if (!fs.existsSync(PROJECT_FILE)) {
    writeJson(PROJECT_FILE, {
      version: packageJson.version,
      savedAt: new Date().toISOString(),
      meta: { name: '', reviewRequired: false, source: 'web', promptCount: 0, mode: 'ppt' },
      settings: {
        globalPrefix: '',
        stylePreset: 'consulting',
        globalParams: { size: '16:9', resolution: '1k', quality: 'auto', n: 1, output_format: 'png' },
        autoDownload: true,
        nextId: 1,
      },
      rows: [],
    });
  }
  if (!fs.existsSync(PROJECTS_FILE)) writeJson(PROJECTS_FILE, []);
  if (!fs.existsSync(TASK_RESULTS_FILE)) writeJson(TASK_RESULTS_FILE, { version: 2, updatedAt: null, tasks: {}, requests: {} });
  if (!fs.existsSync(REFERENCES_FILE)) writeJson(REFERENCES_FILE, { version: 1, references: {} });
}

ensureRuntimeFiles();

const savedConfig = readJson(CONFIG_FILE, {});
let runtimeApiKey = String(process.env.APIMART_API_KEY || process.env.API_KEY || savedConfig.imageApiKey || savedConfig.apiKey || '').trim();

function saveConfig() {
  writeJson(CONFIG_FILE, {
    imageApiBase: 'https://api.apimart.ai',
    imageApiKey: runtimeApiKey,
    imageProvider: 'apimart',
    imageModel: MODEL,
    imageSize: '16:9',
    savedAt: new Date().toISOString(),
  });
}

function loadTaskStore() {
  const value = readJson(TASK_RESULTS_FILE, { version: 2, tasks: {}, requests: {} });
  return {
    version: 2,
    updatedAt: value.updatedAt || null,
    tasks: value.tasks && typeof value.tasks === 'object' ? value.tasks : {},
    requests: value.requests && typeof value.requests === 'object' ? value.requests : {},
  };
}

let taskStore = loadTaskStore();

function saveTaskStore() {
  taskStore.updatedAt = new Date().toISOString();
  writeJson(TASK_RESULTS_FILE, taskStore);
}

function setTask(taskId, updates) {
  const current = taskStore.tasks[taskId] || { taskId, createdAt: new Date().toISOString() };
  taskStore.tasks[taskId] = { ...current, ...updates, taskId, updatedAt: new Date().toISOString() };
  saveTaskStore();
  return taskStore.tasks[taskId];
}

function sanitizeFilename(name, fallback = 'file') {
  const cleaned = String(name || fallback)
    .replace(/\.[^/.]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || fallback;
}

function uniquePath(dir, base, ext) {
  let name = `${base}${ext}`;
  let index = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${base}_${index++}${ext}`;
  return { name, file: path.join(dir, name) };
}

function dateKey(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function projectDownloadDir(project) {
  const dir = path.join(DOWNLOADS_DIR, dateKey(), sanitizeFilename(project, 'default'));
  ensureDir(dir);
  return dir;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, maxRetries = APIMART_MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(APIMART_TIMEOUT_MS) });
      if ((response.status >= 500 || response.status === 429) && attempt < maxRetries) {
        await delay(APIMART_RETRY_DELAY_MS * (2 ** attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;
      await delay(APIMART_RETRY_DELAY_MS * (2 ** attempt));
    }
  }
  const error = new Error(lastError?.message || '无法连接 APIMart');
  error.isNetworkError = true;
  throw error;
}

async function readResponseData(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text || `HTTP ${response.status}` };
  }
}

function upstreamMessage(data, fallback) {
  if (typeof data?.error === 'string') return data.error;
  return data?.error?.message || data?.message || data?.msg || data?.detail || fallback;
}

function createApiError(status, data, sourceError) {
  const network = sourceError?.isNetworkError || sourceError?.name === 'AbortError';
  const upstreamStatus = Number(data?.code);
  const normalizedStatus = Number(status) >= 400
    ? Number(status)
    : (upstreamStatus >= 400 ? upstreamStatus : 502);
  const mapping = network
    ? { status: 502, code: 'APIMART_UNREACHABLE', message: '暂时无法连接 APIMart，请检查网络后重试', retryable: true }
    : {
      400: { code: 'APIMART_INVALID_REQUEST', message: '生成参数不符合 APIMart 要求，请检查提示词或参考图', retryable: false },
      401: { code: 'API_KEY_INVALID', message: 'API Key 无效或已失效，请重新配置', retryable: false },
      402: { code: 'APIMART_BALANCE_INSUFFICIENT', message: 'APIMart 余额不足，请充值后重试', retryable: false },
      403: { code: 'APIMART_ACCESS_DENIED', message: '当前 Key 无权使用 GPT Image 2 官方渠道', retryable: false },
      413: { code: 'REFERENCE_TOO_LARGE', message: '参考图超过 APIMart 允许的 20MB', retryable: false },
      429: { code: 'APIMART_RATE_LIMIT', message: '请求过于频繁，请稍后重试', retryable: true },
    }[normalizedStatus] || (normalizedStatus >= 500
      ? { code: 'APIMART_SERVICE_ERROR', message: 'APIMart 服务暂时异常，请稍后重试', retryable: true }
      : { code: 'APIMART_ERROR', message: 'APIMart 请求失败', retryable: false });
  const error = new Error(mapping.message);
  error.status = mapping.status || normalizedStatus;
  error.code = mapping.code;
  error.retryable = mapping.retryable;
  error.actionUrl = APIMART_ACCOUNT_URL;
  error.docsUrl = APIMART_DOCS_URL;
  return error;
}

function sendError(res, error) {
  const status = Number(error.status) || 500;
  res.status(status).json({
    success: false,
    error: error.message || '服务器内部错误',
    code: error.code || 'INTERNAL_ERROR',
    retryable: Boolean(error.retryable),
    ...(error.actionUrl ? { actionUrl: error.actionUrl } : {}),
    docsUrl: error.docsUrl || APIMART_DOCS_URL,
  });
}

function requireApiKey() {
  if (runtimeApiKey) return runtimeApiKey;
  const error = new Error('请先配置 APIMart API Key');
  error.status = 400;
  error.code = 'API_KEY_MISSING';
  error.actionUrl = APIMART_ACCOUNT_URL;
  error.docsUrl = APIMART_DOCS_URL;
  throw error;
}

function createTextApiError(status, data, sourceError) {
  const error = createApiError(status, data, sourceError);
  error.docsUrl = TEXT_DOCS_URL;
  if (error.code === 'APIMART_ACCESS_DENIED') error.message = '当前 Key 无权使用该文本模型';
  if (error.code === 'APIMART_INVALID_REQUEST') error.message = '对话内容不符合 APIMart 要求，请缩短或调整后重试';
  return error;
}

function normalizeChatMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: String(item?.content || '').trim().slice(0, 20000),
  })).filter(item => item.content).slice(-30);
}

function normalizeConversation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
  return {
    model: TEXT_MODELS.has(source.model) ? source.model : DEFAULT_TEXT_MODEL,
    messages: messages.map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: String(item?.content || '').trim().slice(0, 20000),
      createdAt: item?.createdAt || null,
      finalized: Boolean(item?.finalized),
    })).filter(item => item.content).slice(-30),
  };
}

function contentText(value) {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value.map(block => {
    if (typeof block === 'string') return block;
    return block?.text || block?.content || '';
  }).filter(Boolean).join('\n').trim();
}

function extractResponseText(data) {
  const payload = data?.data && !Array.isArray(data.data) ? data.data : (data || {});
  const choice = payload?.choices?.[0] || data?.choices?.[0];
  const fromMessage = contentText(choice?.message?.content);
  if (fromMessage) return fromMessage;
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  if (Array.isArray(payload.output)) {
    const fromOutput = payload.output.flatMap(item => item?.content || []).map(block => block?.text || '').join('\n').trim();
    if (fromOutput) return fromOutput;
  }
  return '';
}

function publicUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
  };
}

function blankProject(name = '未命名 PPT') {
  const now = new Date().toISOString();
  const projectName = String(name || '未命名 PPT').trim() || '未命名 PPT';
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    meta: {
      name: projectName,
      source: 'web',
      reviewRequired: false,
      reviewedAt: null,
      createdAt: now,
    },
    settings: {
      globalPrefix: '',
      stylePreset: 'consulting',
      globalParams: { size: '16:9', resolution: '1k', quality: 'auto', n: 1, output_format: 'png' },
      autoDownload: true,
      nextId: 1,
    },
    conversation: { model: DEFAULT_TEXT_MODEL, messages: [] },
    rows: [],
  };
}

function isInsideDir(filePath, root) {
  const resolved = path.resolve(filePath);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

function localImagePathFromUrl(url) {
  const value = String(url || '');
  if (!value.startsWith('/ppt_images/')) return '';
  let relative = '';
  try {
    relative = value.slice('/ppt_images/'.length).split('/').map(part => decodeURIComponent(part)).join(path.sep);
  } catch {
    return '';
  }
  if (!relative || relative.split(path.sep).includes('..')) return '';
  const resolved = path.resolve(DOWNLOADS_DIR, relative);
  if (!isInsideDir(resolved, DOWNLOADS_DIR) || resolved === path.resolve(DOWNLOADS_DIR)) return '';
  return resolved;
}

function projectLocalImagePaths(project) {
  const paths = new Set();
  for (const row of project?.rows || []) {
    const candidates = [];
    if (row?.resultUrl) candidates.push(row.resultUrl);
    for (const image of row?.result?.images || []) {
      const value = image?.local_url || image?.url;
      if (Array.isArray(value)) candidates.push(...value);
      else if (value) candidates.push(value);
    }
    for (const candidate of candidates) {
      const filePath = localImagePathFromUrl(candidate);
      if (filePath) paths.add(filePath);
    }
  }
  return Array.from(paths);
}

function removeEmptyParents(filePath) {
  let dir = path.dirname(filePath);
  const root = path.resolve(DOWNLOADS_DIR);
  while (isInsideDir(dir, root) && dir !== root) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      break;
    }
    if (entries.length) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function responsePayload(data) {
  return Array.isArray(data?.data) ? data.data[0] : (data?.data || data || {});
}

function normalizeSubmission(data) {
  const payload = responsePayload(data);
  return {
    taskId: payload.task_id || payload.taskId || payload.id || data?.task_id || data?.taskId || data?.id || null,
    status: String(payload.status || data?.status || 'submitted').toLowerCase(),
    raw: payload,
  };
}

function normalizeTask(data) {
  const payload = responsePayload(data);
  const result = payload.result || payload.output || data?.result || data?.output || null;
  return {
    taskId: payload.task_id || payload.taskId || payload.id || data?.task_id || data?.taskId || data?.id || null,
    status: String(payload.status || data?.status || 'processing').toLowerCase(),
    progress: Number(payload.progress ?? data?.progress ?? 0),
    result,
    cost: payload.cost ?? data?.cost ?? null,
    error: payload.error || payload.fail_reason || data?.error || data?.fail_reason || null,
    createdAt: payload.created || data?.created || null,
    completedAt: payload.completed || data?.completed || null,
  };
}

function resultUrls(result) {
  const urls = [];
  const seen = new Set();
  function visit(value) {
    if (!value || seen.has(value)) return;
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value) || value.startsWith('/ppt_images/')) urls.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    ['url', 'image_url', 'imageUrl', 'urls', 'images', 'data', 'output', 'outputs'].forEach(key => visit(value[key]));
  }
  visit(result);
  return Array.from(new Set(urls));
}

function normalizeUpload(data) {
  const payload = responsePayload(data);
  return { url: resultUrls(payload)[0] || resultUrls(data)[0] || null, raw: payload };
}

function requestKeyFor(body, params) {
  if (body.idempotencyKey) {
    return crypto.createHash('sha256').update(`explicit:${body.idempotencyKey}`).digest('hex');
  }
  return crypto.createHash('sha256').update(JSON.stringify({
    prompt: params.prompt,
    resolution: params.resolution,
    references: body.referenceIds || params.image_urls || [],
    rowId: body.rowId || '',
    pageNumber: body.pageNumber || '',
  })).digest('hex');
}

function loadReferences() {
  const store = readJson(REFERENCES_FILE, { version: 1, references: {} });
  if (!store.references || typeof store.references !== 'object') store.references = {};
  return store;
}

async function uploadReferenceBuffer(buffer, name, mime, apiKey) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), name);
  let response;
  try {
    response = await fetchWithRetry(`${APIMART_API_BASE}/v1/uploads/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (error) {
    throw createApiError(502, {}, error);
  }
  const data = await readResponseData(response);
  const upload = normalizeUpload(data);
  if (!response.ok || !upload.url) throw createApiError(response.status || 502, data);
  return upload;
}

async function resolveReferenceUrls(referenceIds, apiKey) {
  if (!Array.isArray(referenceIds) || !referenceIds.length) return [];
  const store = loadReferences();
  const urls = [];
  let changed = false;
  for (const id of referenceIds.slice(0, 16)) {
    const reference = store.references[id];
    if (!reference) {
      const error = new Error(`参考图不存在或已被移动: ${id}`);
      error.status = 400;
      error.code = 'REFERENCE_NOT_FOUND';
      throw error;
    }
    const stillValid = reference.remoteUrl && Number(reference.expiresAt || 0) > Date.now() + 5 * 60 * 1000;
    if (stillValid) {
      urls.push(reference.remoteUrl);
      continue;
    }
    if (!fs.existsSync(reference.filePath)) {
      const error = new Error(`参考图本地文件不存在: ${reference.name}`);
      error.status = 400;
      error.code = 'REFERENCE_NOT_FOUND';
      throw error;
    }
    const upload = await uploadReferenceBuffer(fs.readFileSync(reference.filePath), reference.name, reference.mime, apiKey);
    reference.remoteUrl = upload.url;
    reference.expiresAt = Date.now() + 71 * 60 * 60 * 1000;
    reference.updatedAt = new Date().toISOString();
    urls.push(reference.remoteUrl);
    changed = true;
  }
  if (changed) writeJson(REFERENCES_FILE, store);
  return urls;
}

function localAssetUrl(filePath, root, mount) {
  const relative = path.relative(root, filePath).split(path.sep).map(encodeURIComponent).join('/');
  return `${mount}/${relative}`;
}

async function downloadToLocal(url, filename, project) {
  if (String(url).startsWith('/ppt_images/')) {
    const relative = String(url).slice('/ppt_images/'.length).split('/').map(decodeURIComponent).join(path.sep);
    const existing = path.resolve(DOWNLOADS_DIR, relative);
    if (!existing.startsWith(`${DOWNLOADS_DIR}${path.sep}`) || !fs.existsSync(existing)) {
      throw new Error('本地图片不存在');
    }
    return {
      name: path.basename(existing),
      path: existing,
      url: localAssetUrl(existing, DOWNLOADS_DIR, '/ppt_images'),
      size: fs.statSync(existing).size,
    };
  }
  const targetDir = projectDownloadDir(project);
  const response = await fetch(url, { signal: AbortSignal.timeout(APIMART_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`下载图片失败: HTTP ${response.status}`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const urlPath = (() => {
    try { return new URL(url).pathname; } catch { return ''; }
  })();
  const ext = contentType.includes('jpeg') || /\.jpe?g$/i.test(urlPath)
    ? '.jpg'
    : contentType.includes('webp') || /\.webp$/i.test(urlPath)
      ? '.webp'
      : '.png';
  const base = sanitizeFilename(filename, 'page');
  const target = uniquePath(targetDir, base, ext);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target.file, bytes);
  return {
    name: target.name,
    path: target.file,
    url: localAssetUrl(target.file, DOWNLOADS_DIR, '/ppt_images'),
    size: bytes.length,
  };
}

async function persistTaskResultImages(task, project, pageNumber) {
  const urls = resultUrls(task.result);
  if (!urls.length) return task;
  const images = [];
  for (let index = 0; index < urls.length; index++) {
    const original = task.result.images?.[index] || {};
    try {
      const asset = await downloadToLocal(urls[index], `page_${String(pageNumber || 1).padStart(2, '0')}_${index + 1}`, project);
      images.push({ ...original, remote_url: urls[index], url: [asset.url], local_url: asset.url });
    } catch (error) {
      console.warn(`生成结果本地保存失败: ${error.message}`);
      images.push(original);
    }
  }
  return { ...task, result: { ...task.result, images }, resultUrl: images[0]?.local_url || urls[0] };
}

function defaultProject() {
  return readJson(PROJECT_FILE, { version: packageJson.version, meta: {}, settings: {}, rows: [] });
}

function normalizeProject(project, fallbackId = '') {
  const value = project && typeof project === 'object' ? project : {};
  const id = String(value.meta?.id || value.id || fallbackId || crypto.randomUUID());
  const name = String(value.meta?.name || value.name || value.settings?.projectName || '未命名 PPT').trim() || '未命名 PPT';
  const createdAt = value.createdAt || value.meta?.createdAt || value.savedAt || new Date().toISOString();
  return {
    ...value,
    id,
    createdAt,
    version: packageJson.version,
    meta: {
      ...(value.meta || {}),
      id,
      name,
      createdAt,
      promptCount: Array.isArray(value.rows) ? value.rows.length : 0,
      mode: 'ppt',
    },
    settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
    rows: Array.isArray(value.rows) ? value.rows : [],
    conversation: normalizeConversation(value.conversation),
  };
}

function deleteStoredProject(projectId) {
  const projects = loadProjects();
  const index = projects.findIndex(item => item.id === projectId);
  if (index < 0) return null;
  const removed = projects[index];
  const remaining = projects.filter(item => item.id !== projectId);
  const keepImages = new Set(remaining.flatMap(project => projectLocalImagePaths(project)));
  for (const filePath of projectLocalImagePaths(removed)) {
    if (keepImages.has(filePath)) continue;
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
        removeEmptyParents(filePath);
      }
    } catch (error) {
      console.warn(`删除项目图片失败: ${error.message}`);
    }
  }
  writeJson(PROJECTS_FILE, remaining);
  const active = defaultProject();
  const activeId = String(active.meta?.id || active.id || '');
  if (!remaining.length) {
    const created = saveStoredProject(blankProject());
    return { activeProjectId: created.id, projects: loadProjects() };
  }
  if (activeId === projectId) {
    writeJson(PROJECT_FILE, remaining[0]);
    return { activeProjectId: remaining[0].id, projects: loadProjects() };
  }
  return { activeProjectId: activeId || remaining[0].id, projects: loadProjects() };
}

function loadProjects() {
  const stored = readJson(PROJECTS_FILE, []);
  const projects = Array.isArray(stored) ? stored : (Array.isArray(stored?.projects) ? stored.projects : []);
  return projects.filter(project => project && typeof project === 'object').map(project => normalizeProject(project));
}

function projectSummary(project) {
  const completedCount = project.rows.filter(row => ['completed', 'success', 'succeeded'].includes(String(row.status || '').toLowerCase())).length;
  return {
    id: project.id,
    name: project.meta.name,
    pageCount: project.rows.length,
    completedCount,
    createdAt: project.createdAt,
    updatedAt: project.savedAt || project.createdAt,
  };
}

function saveStoredProject(project, projectId = '') {
  const projects = loadProjects();
  const normalized = normalizeProject({ ...project, savedAt: new Date().toISOString() }, projectId);
  const index = projects.findIndex(item => item.id === normalized.id);
  if (index >= 0) projects[index] = normalized;
  else projects.unshift(normalized);
  writeJson(PROJECTS_FILE, projects);
  writeJson(PROJECT_FILE, normalized);
  return normalized;
}

function bootstrapProjects() {
  const projects = loadProjects();
  const current = defaultProject();
  const currentHasContent = Boolean(current.meta?.name || current.name || (Array.isArray(current.rows) && current.rows.length));
  if (!projects.length) {
    const first = saveStoredProject(current, current.meta?.id || current.id || crypto.randomUUID());
    return { projects: [first], activeProjectId: first.id };
  }
  if (currentHasContent) {
    const currentId = String(current.meta?.id || current.id || '');
    const matched = projects.find(project => project.id === currentId)
      || projects.find(project => project.meta.name === String(current.meta?.name || current.name || '').trim());
    if (!matched) {
      const saved = saveStoredProject(current, currentId || crypto.randomUUID());
      return { projects: [saved, ...projects], activeProjectId: saved.id };
    }
    if (!currentId) writeJson(PROJECT_FILE, matched);
    return { projects: loadProjects(), activeProjectId: matched.id };
  }
  writeJson(PROJECT_FILE, projects[0]);
  return { projects, activeProjectId: projects[0].id };
}

function normalizeImportedPrompts(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((item, index) => typeof item === 'string'
    ? { title: `第 ${index + 1} 页`, prompt: item.trim() }
    : { title: item?.title || `第 ${index + 1} 页`, prompt: String(item?.prompt || item?.content || item?.text || '').trim() })
    .filter(item => item.prompt);
}

function createApp() {
  bootstrapProjects();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '30mb' }));
  app.use(express.static(path.join(ROOT_DIR, 'public'), { index: false }));
  app.use('/assets', express.static(ASSETS_DIR));
  app.use('/ppt_images', express.static(DOWNLOADS_DIR));
  app.use('/vendor/jspdf', express.static(path.join(ROOT_DIR, 'node_modules/jspdf/dist')));
  app.use('/vendor/fflate', express.static(path.join(ROOT_DIR, 'node_modules/fflate/umd')));
  app.use('/vendor/lucide', express.static(path.join(ROOT_DIR, 'node_modules/lucide-static/icons')));

  app.get('/', (req, res) => res.sendFile(path.join(ROOT_DIR, 'index.html')));
  app.get('/index.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'index.html')));
  app.get('/help.html', (req, res) => res.sendFile(path.join(ROOT_DIR, 'help.html')));

  app.get('/api/health', (req, res) => {
    res.json({ success: true, version: packageJson.version, configured: Boolean(runtimeApiKey) });
  });

  app.get('/api/app-info', (req, res) => {
    res.json({
      success: true,
      version: packageJson.version,
      model: MODEL,
      textModel: DEFAULT_TEXT_MODEL,
      imageApiBase: 'https://api.apimart.ai',
      docsUrl: APIMART_DOCS_URL,
      textDocsUrl: TEXT_DOCS_URL,
      accountUrl: APIMART_ACCOUNT_URL,
    });
  });

  app.get('/api/config', (req, res) => {
    res.json({ success: true, configured: Boolean(runtimeApiKey) });
  });

  app.post('/api/config', (req, res) => {
    const apiKey = String(req.body?.apiKey || req.body?.imageApiKey || '').trim();
    if (!apiKey) return sendError(res, Object.assign(new Error('API Key 不能为空'), { status: 400, code: 'API_KEY_MISSING' }));
    runtimeApiKey = apiKey;
    saveConfig();
    res.json({ success: true, configured: true });
  });

  app.delete('/api/config', (req, res) => {
    runtimeApiKey = '';
    saveConfig();
    res.json({ success: true, configured: false });
  });

  app.get('/api/projects', (req, res) => {
    const projects = loadProjects();
    const active = defaultProject();
    res.json({
      success: true,
      activeProjectId: String(active.meta?.id || active.id || projects[0]?.id || ''),
      projects: projects.map(projectSummary),
    });
  });

  app.post('/api/projects', (req, res) => {
    const project = saveStoredProject(blankProject(req.body?.name));
    res.status(201).json({ success: true, project });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const deleted = deleteStoredProject(req.params.id);
    if (!deleted) return sendError(res, Object.assign(new Error('未找到 PPT 项目'), { status: 404, code: 'PROJECT_NOT_FOUND' }));
    res.json({
      success: true,
      activeProjectId: deleted.activeProjectId,
      projects: deleted.projects.map(projectSummary),
    });
  });

  app.post('/api/prompt-chat', async (req, res) => {
    try {
      const apiKey = requireApiKey();
      const model = TEXT_MODELS.has(req.body?.model) ? req.body.model : DEFAULT_TEXT_MODEL;
      const messages = normalizeChatMessages(req.body?.messages);
      if (!messages.length) {
        const error = new Error('请先输入制作意图');
        error.status = 400;
        error.code = 'PROMPT_INTENT_EMPTY';
        throw error;
      }
      const input = [
        { role: 'system', content: [{ type: 'input_text', text: promptTemplates.CONVERSATION_SYSTEM }] },
        ...messages.map(message => ({
          role: message.role,
          content: [{ type: 'input_text', text: message.content }],
        })),
      ];
      if (req.body?.finalize) {
        input.push({
          role: 'user',
          content: [{ type: 'input_text', text: promptTemplates.FINALIZE_INSTRUCTION }],
        });
      }
      let response;
      try {
        response = await fetchWithRetry(`${APIMART_API_BASE}/v1/responses`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, input, stream: false, max_tokens: 8192 }),
        });
      } catch (error) {
        throw createTextApiError(502, {}, error);
      }
      const data = await readResponseData(response);
      if (!response.ok || (data.code !== undefined && ![0, 200].includes(Number(data.code)))) {
        throw createTextApiError(response.status, data);
      }
      const content = extractResponseText(data);
      if (!content) {
        const error = new Error('文本模型没有返回内容，请重试');
        error.status = 502;
        error.code = 'APIMART_EMPTY_RESPONSE';
        error.retryable = true;
        error.docsUrl = TEXT_DOCS_URL;
        throw error;
      }
      const payload = data?.data && !Array.isArray(data.data) ? data.data : data;
      res.json({
        success: true,
        content,
        model: payload?.model || model,
        usage: publicUsage(payload?.usage),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = loadProjects().find(item => item.id === req.params.id);
    if (!project) return sendError(res, Object.assign(new Error('未找到 PPT 项目'), { status: 404, code: 'PROJECT_NOT_FOUND' }));
    res.json({ success: true, project });
  });

  app.put('/api/projects/:id', (req, res) => {
    if (!Array.isArray(req.body?.rows)) {
      return sendError(res, Object.assign(new Error('项目数据缺少 rows 数组'), { status: 400, code: 'INVALID_PROJECT' }));
    }
    const existing = loadProjects().find(project => project.id === req.params.id);
    if (!existing) return sendError(res, Object.assign(new Error('未找到 PPT 项目'), { status: 404, code: 'PROJECT_NOT_FOUND' }));
    const saved = saveStoredProject({ ...existing, ...req.body, id: existing.id, createdAt: existing.createdAt }, existing.id);
    res.json({ success: true, savedAt: saved.savedAt, project: projectSummary(saved) });
  });

  app.post('/api/projects/:id/activate', (req, res) => {
    const project = loadProjects().find(item => item.id === req.params.id);
    if (!project) return sendError(res, Object.assign(new Error('未找到 PPT 项目'), { status: 404, code: 'PROJECT_NOT_FOUND' }));
    writeJson(PROJECT_FILE, project);
    res.json({ success: true, project });
  });

  app.get('/api/project', (req, res) => res.json(defaultProject()));

  app.get('/api/project/status', (req, res) => {
    const project = defaultProject();
    res.json({ success: true, meta: project.meta || {}, savedAt: project.savedAt || null });
  });

  app.put('/api/project', (req, res) => {
    const project = req.body || {};
    if (!Array.isArray(project.rows)) {
      return sendError(res, Object.assign(new Error('项目数据缺少 rows 数组'), { status: 400, code: 'INVALID_PROJECT' }));
    }
    const current = defaultProject();
    const saved = saveStoredProject(project, project.meta?.id || project.id || current.meta?.id || current.id || crypto.randomUUID());
    res.json({ success: true, savedAt: saved.savedAt });
  });

  app.post('/api/project/import-prompts', (req, res) => {
    const prompts = normalizeImportedPrompts(req.body?.prompts);
    if (!prompts.length) {
      return sendError(res, Object.assign(new Error('没有可导入的提示词'), { status: 400, code: 'PROMPTS_EMPTY' }));
    }
    const current = defaultProject();
    const append = Boolean(req.body?.append);
    const existingRows = append && Array.isArray(current.rows) ? current.rows : [];
    let nextId = Math.max(Number(current.settings?.nextId || 1), ...existingRows.map(row => Number(row.id || 0) + 1), 1);
    const newRows = prompts.map(item => ({
      id: nextId++,
      prompt: item.prompt,
      refImages: [],
      maskImage: null,
      settings: {},
      status: 'idle',
      progress: 0,
      taskId: null,
      result: null,
      error: null,
      cost: null,
      isModification: false,
      parentId: null,
    }));
    const incomingSettings = req.body?.settings || {};
    const settings = {
      ...current.settings,
      ...incomingSettings,
      globalParams: {
        size: '16:9',
        resolution: ['1k', '2k', '4k'].includes(incomingSettings.globalParams?.resolution) ? incomingSettings.globalParams.resolution : '1k',
        quality: 'auto',
        n: 1,
        output_format: 'png',
      },
      nextId,
    };
    const currentIsBlank = !current.rows?.length && ['未命名 PPT', ''].includes(String(current.meta?.name || ''));
    const projectId = append || currentIsBlank
      ? String(current.meta?.id || current.id || crypto.randomUUID())
      : crypto.randomUUID();
    const saved = {
      id: projectId,
      createdAt: append ? current.createdAt : new Date().toISOString(),
      version: packageJson.version,
      savedAt: new Date().toISOString(),
      meta: {
        ...(append ? (current.meta || {}) : {}),
        id: projectId,
        name: String(req.body?.name || (append ? current.meta?.name : '') || '未命名 PPT'),
        source: req.body?.source || 'cli',
        importedAt: new Date().toISOString(),
        reviewedAt: null,
        reviewRequired: req.body?.reviewRequired !== false,
        promptCount: existingRows.length + newRows.length,
        mode: 'ppt',
      },
      settings,
      rows: existingRows.concat(newRows),
    };
    const stored = saveStoredProject(saved, projectId);
    res.json({ success: true, project: stored });
  });

  app.post('/api/reference-images', async (req, res) => {
    try {
      const apiKey = requireApiKey();
      const mime = String(req.body?.mime || '').toLowerCase();
      const ext = ALLOWED_REFERENCE_TYPES.get(mime);
      if (!ext) {
        const error = new Error('参考图仅支持 JPEG、PNG、WebP 或 GIF');
        error.status = 400;
        error.code = 'REFERENCE_TYPE_UNSUPPORTED';
        throw error;
      }
      const match = String(req.body?.dataUrl || '').match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (!match) {
        const error = new Error('参考图数据无效');
        error.status = 400;
        error.code = 'REFERENCE_INVALID';
        throw error;
      }
      if (match[1].toLowerCase() !== mime) {
        const error = new Error('参考图类型与文件内容不一致');
        error.status = 400;
        error.code = 'REFERENCE_TYPE_MISMATCH';
        throw error;
      }
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > MAX_REFERENCE_BYTES) {
        const error = new Error('参考图必须小于 20MB');
        error.status = 413;
        error.code = 'REFERENCE_TOO_LARGE';
        throw error;
      }
      const id = crypto.randomUUID();
      const originalName = String(req.body?.name || `reference${ext}`).slice(0, 160);
      const fileName = `${id}${ext}`;
      const filePath = path.join(REFERENCES_DIR, fileName);
      fs.writeFileSync(filePath, buffer);
      let uploaded;
      try {
        uploaded = await uploadReferenceBuffer(buffer, originalName, mime, apiKey);
      } catch (error) {
        fs.unlinkSync(filePath);
        throw error;
      }
      const store = loadReferences();
      const reference = {
        id,
        name: originalName,
        mime,
        filePath,
        previewUrl: `/assets/references/${encodeURIComponent(fileName)}`,
        remoteUrl: uploaded.url,
        expiresAt: Date.now() + 71 * 60 * 60 * 1000,
        createdAt: new Date().toISOString(),
      };
      store.references[id] = reference;
      writeJson(REFERENCES_FILE, store);
      res.json({ success: true, reference: { id, name: reference.name, previewUrl: reference.previewUrl } });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/generate', async (req, res) => {
    try {
      const apiKey = String(req.body?.apiKey || runtimeApiKey || '').trim();
      if (!apiKey) requireApiKey();
      const prompt = String(req.body?.params?.prompt || '').trim();
      if (!prompt) {
        const error = new Error('提示词不能为空');
        error.status = 400;
        error.code = 'PROMPT_EMPTY';
        throw error;
      }
      const resolution = ['1k', '2k', '4k'].includes(req.body?.params?.resolution) ? req.body.params.resolution : '1k';
      const referenceUrls = await resolveReferenceUrls(req.body?.referenceIds, apiKey || runtimeApiKey);
      const legacyUrls = Array.isArray(req.body?.params?.image_urls) ? req.body.params.image_urls.slice(0, 16) : [];
      const params = {
        model: MODEL,
        prompt,
        size: '16:9',
        resolution,
        quality: 'auto',
        n: 1,
        output_format: 'png',
        ...((referenceUrls.length || legacyUrls.length) ? { image_urls: [...referenceUrls, ...legacyUrls].slice(0, 16) } : {}),
      };
      const requestKey = requestKeyFor(req.body || {}, params);
      const existingTaskId = taskStore.requests[requestKey];
      const existing = existingTaskId ? taskStore.tasks[existingTaskId] : null;
      const fresh = existing && Date.now() - new Date(existing.createdAt || 0).getTime() < REQUEST_TTL_MS;
      if (!req.body?.force && fresh) {
        return res.json({
          success: true,
          duplicate: true,
          taskId: existing.taskId,
          status: existing.status,
          completed: existing.status === 'completed',
          imageUrl: existing.resultUrl || null,
        });
      }
      let response;
      try {
        response = await fetchWithRetry(`${APIMART_API_BASE}/v1/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey || runtimeApiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': requestKey,
          },
          body: JSON.stringify(params),
        });
      } catch (error) {
        throw createApiError(502, {}, error);
      }
      const data = await readResponseData(response);
      if (!response.ok || (data.code !== undefined && ![0, 200].includes(Number(data.code)))) throw createApiError(response.status, data);
      const submission = normalizeSubmission(data);
      if (!submission.taskId) {
        const error = new Error('APIMart 未返回任务 ID');
        error.status = 502;
        error.code = 'APIMART_INVALID_RESPONSE';
        error.retryable = true;
        throw error;
      }
      taskStore.requests[requestKey] = submission.taskId;
      setTask(submission.taskId, {
        requestKey,
        status: submission.status || 'submitted',
        progress: 0,
        params: { model: MODEL, size: '16:9', resolution, quality: 'auto', n: 1, output_format: 'png' },
        rowId: req.body?.rowId ?? null,
        pageNumber: req.body?.pageNumber ?? null,
        project: req.body?.project || 'default',
        createdAt: new Date().toISOString(),
      });
      res.json({ success: true, taskId: submission.taskId, status: submission.status || 'submitted' });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/task-status', async (req, res) => {
    try {
      const apiKey = String(req.body?.apiKey || runtimeApiKey || '').trim();
      if (!apiKey) requireApiKey();
      const taskId = String(req.body?.taskId || '').trim();
      if (!taskId) {
        const error = new Error('缺少任务 ID');
        error.status = 400;
        error.code = 'TASK_ID_MISSING';
        throw error;
      }
      const cached = taskStore.tasks[taskId];
      if (cached?.status === 'completed' || cached?.status === 'failed') {
        return res.json({ success: true, task: cached });
      }
      let response;
      try {
        response = await fetchWithRetry(`${APIMART_API_BASE}/v1/tasks/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${apiKey || runtimeApiKey}` },
        });
      } catch (error) {
        throw createApiError(502, {}, error);
      }
      const data = await readResponseData(response);
      if (!response.ok || (data.code !== undefined && ![0, 200].includes(Number(data.code)))) throw createApiError(response.status, data);
      let task = normalizeTask(data);
      task.taskId = task.taskId || taskId;
      const completed = ['completed', 'success', 'succeeded'].includes(task.status);
      const failed = ['failed', 'error', 'cancelled'].includes(task.status);
      if (completed) {
        task.status = 'completed';
        task.progress = 100;
        task = await persistTaskResultImages(task, req.body?.project || cached?.project || 'default', req.body?.pageNumber || cached?.pageNumber || 1);
        task.completedAt = new Date().toISOString();
      } else if (failed) {
        task.status = 'failed';
        task.failedAt = new Date().toISOString();
        task.error = typeof task.error === 'string' ? task.error : upstreamMessage(task.error, '生成失败');
        task.errorInfo = {
          code: 'APIMART_TASK_FAILED',
          retryable: false,
          actionUrl: APIMART_ACCOUNT_URL,
          docsUrl: APIMART_DOCS_URL,
        };
      } else {
        task.status = 'generating';
      }
      const saved = setTask(taskId, { ...task, rowId: req.body?.rowId ?? cached?.rowId ?? null, pageNumber: req.body?.pageNumber ?? cached?.pageNumber ?? null });
      res.json({ success: true, task: saved });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/recover-tasks', (req, res) => {
    const tasks = Object.values(taskStore.tasks).filter(task => ['submitted', 'processing', 'generating', 'in_progress'].includes(task.status));
    res.json({ success: true, total: tasks.length, tasks });
  });

  app.get('/api/task-result/:taskId', (req, res) => {
    const task = taskStore.tasks[req.params.taskId];
    if (!task) return sendError(res, Object.assign(new Error('未找到任务'), { status: 404, code: 'TASK_NOT_FOUND' }));
    res.json({ success: true, task });
  });

  app.post('/api/download', async (req, res) => {
    try {
      if (!req.body?.url) throw Object.assign(new Error('缺少图片 URL'), { status: 400, code: 'URL_MISSING' });
      const asset = await downloadToLocal(req.body.url, req.body.filename || 'image', req.body.project || 'default');
      res.json({ success: true, asset, path: asset.path });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/download-batch', async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
    if (!items.length) return sendError(res, Object.assign(new Error('没有可保存的图片'), { status: 400, code: 'ITEMS_EMPTY' }));
    const results = [];
    for (const item of items) {
      try {
        const asset = await downloadToLocal(item.url, item.filename || 'image', req.body?.project || 'default');
        results.push({ success: true, filename: asset.name, asset });
      } catch (error) {
        results.push({ success: false, filename: item.filename || 'image', error: error.message });
      }
    }
    res.json({
      success: true,
      total: items.length,
      successCount: results.filter(item => item.success).length,
      dir: path.relative(ROOT_DIR, projectDownloadDir(req.body?.project || 'default')),
      results,
    });
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, error: `未找到端点: ${req.method} ${req.path}`, code: 'NOT_FOUND' });
  });

  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return sendError(res, Object.assign(new Error('请求内容过大'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }));
    }
    console.error(`${req.method} ${req.path}: ${error.message}`);
    sendError(res, error);
  });

  return app;
}

function startServer(options = {}) {
  const app = createApp();
  const port = Number(options.port ?? process.env.PORT ?? 17890);
  const host = options.host || process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => {
    const actualPort = server.address().port;
    console.log(`ppter ppt v${packageJson.version} 已启动: http://${host}:${actualPort}/`);
  });
  return { app, server };
}

if (require.main === module) startServer();

module.exports = {
  createApiError,
  createApp,
  extractResponseText,
  normalizeSubmission,
  normalizeTask,
  normalizeUpload,
  resultUrls,
  startServer,
};
