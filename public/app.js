(function initApp() {
  'use strict';

  const APIMART_DOCS_URL = 'https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/official';
  const APIMART_ACCOUNT_URL = 'https://apimart.ai/zh';
  const STYLE_PRESETS = {
    consulting: '专业咨询报告风格，16:9 横版商务演示视觉，白色留白充足，深蓝、黑灰与少量强调色，信息层级清楚，图表与结构图简洁，适合正式汇报，避免装饰堆叠',
    minimal: '极简产品发布会风格，16:9 横版，浅色背景，大面积留白，黑白灰为主，单一高饱和强调色，主体聚焦，精致光影，避免拥挤和无关装饰',
    tech: '现代科技企业宣传风格，16:9 横版，蓝白与深灰配色，清晰网格，适度数据与科技元素，专业可信，画面整洁，适合产品方案和企业介绍',
    warm: '温暖商业插画风格，16:9 横版，明亮柔和，人物与场景自然，色彩丰富但克制，亲和可信，适合品牌故事和企业文化，避免幼稚卡通感',
    custom: '',
  };

  const state = {
    projects: [],
    currentProjectId: '',
    currentView: 'prompt',
    rows: [],
    conversation: { model: 'gpt-5.2-pro', messages: [] },
    parsedDraftPages: [],
    chatSending: false,
    meta: { name: '', reviewRequired: false, reviewedAt: null },
    settings: { stylePreset: 'consulting', globalPrefix: STYLE_PRESETS.consulting, resolution: '1k' },
    nextId: 1,
    apiConfigured: false,
    parsedPages: [],
    saveTimer: null,
    pollTimers: new Map(),
    batchRunning: false,
    switchingProject: false,
    toastTimer: null,
  };

  const dom = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheDom() {
    [
      'versionBadge', 'projectName', 'saveState', 'projectCount', 'projectList', 'projectSidebar',
      'sidebarBackdrop', 'sidebarToggleBtn', 'sidebarCloseBtn', 'apiSettingsBtn', 'apiStateText', 'newProjectBtn',
      'workflowStep1', 'workflowStep2', 'workflowStep3', 'helpBtn', 'openImportBtn', 'addPageBtn',
      'stylePreset', 'customStyleWrap', 'customStyleInput', 'resolution', 'progressSummary', 'batchGenerateBtn', 'exportImagesBtn',
      'exportPdfBtn', 'exportPptBtn', 'exportSummary', 'reviewNotice', 'confirmReviewBtn', 'pageList',
      'emptyState', 'emptyStateImportBtn', 'emptyStateAddBtn',
      'textModel', 'chatLog', 'chatInput', 'sendChatBtn', 'finalizePromptsBtn', 'promptPreview', 'usePromptsBtn',
      'pastePromptText', 'pasteImportExampleBtn', 'parseAndNextBtn', 'importModal', 'modalPasteText',
      'parsePromptsBtn', 'importPreviewList', 'appendImport',
      'confirmImportBtn', 'apiModal', 'apiKeyInput', 'apiConfigHelp', 'clearApiKeyBtn',
      'saveApiKeyBtn', 'imagePreviewModal', 'imagePreview', 'toast',
    ].forEach(id => { dom[id] = byId(id); });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, type = 'info') {
    clearTimeout(state.toastTimer);
    dom.toast.textContent = message;
    dom.toast.className = `toast show ${type}`;
    state.toastTimer = setTimeout(() => { dom.toast.className = 'toast'; }, 3200);
  }

  function openModal(id) {
    const modal = byId(id);
    if (!modal) return;
    modal.classList.add('open');
    const focusable = modal.querySelector('button, input, textarea, select, a');
    if (focusable) setTimeout(() => focusable.focus(), 0);
  }

  function closeModal(id) {
    const modal = byId(id);
    if (modal) modal.classList.remove('open');
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || `HTTP ${response.status}` };
    }
    if (!response.ok || data.success === false) {
      const error = new Error(data.error || data.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = data.code || '';
      error.actionUrl = data.actionUrl || '';
      error.docsUrl = data.docsUrl || APIMART_DOCS_URL;
      error.retryable = Boolean(data.retryable);
      error.data = data;
      throw error;
    }
    return data;
  }

  function normalizeReference(reference, index) {
    if (typeof reference === 'string') {
      return { id: '', name: `参考图 ${index + 1}`, previewUrl: reference, remoteUrl: reference };
    }
    const url = reference.previewUrl || reference.localUrl || reference.url || reference.remoteUrl || '';
    return {
      id: reference.id || '',
      name: reference.name || `参考图 ${index + 1}`,
      previewUrl: url,
      remoteUrl: reference.remoteUrl || reference.url || '',
    };
  }

  function normalizeRow(row, index) {
    const rawStatus = String(row.status || '').toLowerCase();
    const status = ['completed', 'success', 'succeeded'].includes(rawStatus)
      ? 'completed'
      : ['submitted', 'pending', 'queued'].includes(rawStatus)
        ? 'submitted'
        : ['generating', 'processing', 'in_progress', 'running'].includes(rawStatus)
          ? 'generating'
          : rawStatus === 'failed' || rawStatus === 'error'
            ? 'failed'
            : 'idle';
    return {
      id: Number(row.id) || index + 1,
      prompt: String(row.prompt || row.content || ''),
      refImages: Array.isArray(row.refImages) ? row.refImages.map(normalizeReference) : [],
      settings: row.settings || {},
      status,
      progress: Number(row.progress || 0),
      taskId: row.taskId || null,
      result: row.result || null,
      resultUrl: row.resultUrl || null,
      error: row.error || null,
      errorInfo: row.errorInfo || null,
      cost: row.cost ?? null,
      currentRequestKey: row.currentRequestKey || null,
    };
  }

  function normalizeStyleKey(value) {
    const map = { mckinsey: 'consulting', apple: 'minimal', tech: 'tech', warm: 'warm', custom: 'custom' };
    return STYLE_PRESETS[value] !== undefined ? value : (map[value] || 'consulting');
  }

  function renderProjectList() {
    dom.projectCount.textContent = String(state.projects.length);
    if (!state.projects.length) {
      dom.projectList.innerHTML = '<div class="project-list-empty">还没有 PPT 项目</div>';
      return;
    }
    dom.projectList.innerHTML = state.projects.map(project => {
      const pageCount = Number(project.pageCount || 0);
      const completedCount = Number(project.completedCount || 0);
      const meta = pageCount ? `${completedCount}/${pageCount} 页已完成` : '尚未分页';
      const active = project.id === state.currentProjectId;
      const deleteLocked = state.batchRunning && active;
      const name = project.name || '未命名 PPT';
      return `
        <div class="project-row">
          <button class="project-item ${active ? 'active' : ''}" type="button" data-project-id="${escapeHtml(project.id)}" ${active ? 'aria-current="page"' : ''}>
            <img class="project-item-icon" src="/vendor/lucide/presentation.svg" alt="">
            <span class="project-item-copy">
              <span class="project-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
              <span class="project-item-meta">${meta}</span>
            </span>
          </button>
          <button class="project-delete" type="button" data-delete-project-id="${escapeHtml(project.id)}" aria-label="删除「${escapeHtml(name)}」" ${deleteLocked ? 'disabled' : ''}>
            <img src="/vendor/lucide/trash-2.svg" alt="">
          </button>
        </div>`;
    }).join('');
  }

  function updateCurrentProjectSummary() {
    const project = state.projects.find(item => item.id === state.currentProjectId);
    if (!project) return;
    project.name = dom.projectName.value.trim() || '未命名 PPT';
    project.pageCount = state.rows.length;
    project.completedCount = state.rows.filter(row => row.status === 'completed').length;
    renderProjectList();
  }

  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
  }

  function setWorkspaceView(view, options = {}) {
    if (!['prompt', 'generate', 'export'].includes(view)) return;
    state.currentView = view;
    document.body.dataset.workspaceView = view;
    updateWorkflow();
    if (options.scroll !== false) byId('mainWorkspace')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function applyProjectToControls() {
    dom.projectName.value = state.meta.name;
    dom.stylePreset.value = state.settings.stylePreset;
    dom.customStyleInput.value = state.settings.stylePreset === 'custom' ? state.settings.globalPrefix : '';
    dom.customStyleWrap.classList.toggle('hidden', state.settings.stylePreset !== 'custom');
    dom.resolution.value = state.settings.resolution;
    if (dom.textModel) dom.textModel.value = state.conversation.model;
  }

  function restoreProject(project) {
    if (!project || typeof project !== 'object') return;
    state.currentProjectId = String(project.meta?.id || project.id || state.currentProjectId || '');
    state.rows = Array.isArray(project.rows) ? project.rows.map(normalizeRow) : [];
    state.meta = {
      id: state.currentProjectId,
      name: String(project.meta?.name || project.name || '未命名 PPT'),
      reviewRequired: Boolean(project.meta?.reviewRequired),
      reviewedAt: project.meta?.reviewedAt || null,
      source: project.meta?.source || 'web',
    };
    const stylePreset = normalizeStyleKey(project.settings?.stylePreset);
    const resolution = ['1k', '2k', '4k'].includes(project.settings?.globalParams?.resolution)
      ? project.settings.globalParams.resolution
      : '1k';
    state.settings = {
      stylePreset,
      globalPrefix: String(project.settings?.globalPrefix || STYLE_PRESETS[stylePreset]),
      resolution,
    };
    const maxId = state.rows.reduce((max, row) => Math.max(max, row.id), 0);
    state.nextId = Math.max(Number(project.settings?.nextId || 1), maxId + 1);
    const allowedModels = new Set(['gpt-5.2-pro', 'qwen3.8-max']);
    const storedConversation = project.conversation && typeof project.conversation === 'object' ? project.conversation : {};
    state.conversation = {
      model: allowedModels.has(storedConversation.model) ? storedConversation.model : 'gpt-5.2-pro',
      messages: Array.isArray(storedConversation.messages)
        ? storedConversation.messages.map(message => ({
          role: message?.role === 'assistant' ? 'assistant' : 'user',
          content: String(message?.content || ''),
          createdAt: message?.createdAt || null,
          finalized: Boolean(message?.finalized),
        })).filter(message => message.content).slice(-30)
        : [],
    };
    restoreDraftFromConversation();
    if (dom.chatInput) dom.chatInput.value = '';
  }

  function restoreDraftFromConversation() {
    const finalized = [...state.conversation.messages].reverse().find(message => message.role === 'assistant' && message.finalized);
    state.parsedDraftPages = finalized ? window.PromptParser.parse(finalized.content) : [];
  }

  function serializeProject() {
    return {
      version: '2.1.0',
      savedAt: new Date().toISOString(),
      meta: {
        ...state.meta,
        id: state.currentProjectId,
        name: dom.projectName.value.trim() || '未命名 PPT',
        promptCount: state.rows.length,
        mode: 'ppt',
      },
      settings: {
        globalPrefix: state.settings.globalPrefix,
        stylePreset: state.settings.stylePreset,
        globalParams: {
          size: '16:9',
          resolution: state.settings.resolution,
          quality: 'auto',
          n: 1,
          output_format: 'png',
        },
        autoDownload: true,
        nextId: state.nextId,
      },
      conversation: {
        model: state.conversation.model,
        messages: state.conversation.messages.map(message => ({
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          finalized: Boolean(message.finalized),
        })),
      },
      rows: state.rows.map(row => ({
        id: row.id,
        prompt: row.prompt,
        refImages: row.refImages,
        maskImage: null,
        settings: row.settings || {},
        status: row.status,
        progress: row.progress,
        taskId: row.taskId,
        result: row.result,
        resultUrl: row.resultUrl,
        error: row.error,
        errorInfo: row.errorInfo,
        cost: row.cost,
        isModification: false,
        parentId: null,
        currentRequestKey: row.currentRequestKey,
      })),
    };
  }

  async function saveProjectNow() {
    if (!state.currentProjectId || state.switchingProject) return;
    const projectId = state.currentProjectId;
    clearTimeout(state.saveTimer);
    dom.saveState.textContent = '保存中';
    dom.saveState.className = 'save-state saving';
    try {
      const data = await requestJson(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serializeProject()),
      });
      if (state.currentProjectId === projectId) {
        const summary = state.projects.find(project => project.id === projectId);
        if (summary && data.project) Object.assign(summary, data.project);
        dom.saveState.textContent = '已保存';
        dom.saveState.className = 'save-state';
        renderProjectList();
      }
    } catch (error) {
      console.warn('自动保存失败:', error.message);
      if (state.currentProjectId === projectId) {
        dom.saveState.textContent = '保存失败';
        dom.saveState.className = 'save-state error';
      }
    }
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    dom.saveState.textContent = '待保存';
    dom.saveState.className = 'save-state saving';
    state.saveTimer = setTimeout(saveProjectNow, 450);
  }

  function createRow(prompt = '') {
    return normalizeRow({ id: state.nextId++, prompt, status: 'idle' }, state.rows.length);
  }

  function getRow(rowId) {
    return state.rows.find(row => row.id === Number(rowId));
  }

  function getImageUrls(row) {
    const urls = [];
    if (row.resultUrl) urls.push(row.resultUrl);
    const images = row.result?.images || [];
    for (const image of images) {
      const value = image?.local_url || image?.url;
      if (Array.isArray(value)) urls.push(...value);
      else if (value) urls.push(value);
    }
    return Array.from(new Set(urls.filter(Boolean)));
  }

  function statusLabel(status) {
    return {
      idle: '待生成',
      submitted: '已提交',
      generating: '生成中',
      completed: '已完成',
      failed: '生成失败',
    }[status] || '待生成';
  }

  function rowTitle(row, index) {
    return window.PromptParser.extractTitle(row.prompt, index);
  }

  function renderReferences(row) {
    return row.refImages.map((reference, index) => `
      <span class="reference-chip">
        <img class="preview" src="${escapeHtml(reference.previewUrl || reference.remoteUrl)}" alt="${escapeHtml(reference.name)}">
        <span class="reference-name" title="${escapeHtml(reference.name)}">${escapeHtml(reference.name)}</span>
        <button class="reference-remove" type="button" data-action="remove-reference" data-row-id="${row.id}" data-reference-index="${index}" aria-label="移除参考图">×</button>
      </span>`).join('');
  }

  function renderResult(row) {
    const urls = getImageUrls(row);
    const firstUrl = urls[0];
    if (row.status === 'completed' && firstUrl) {
      return `
        <div class="result-image-wrap">
          <img src="${escapeHtml(firstUrl)}" data-action="preview-image" data-image-url="${escapeHtml(firstUrl)}" alt="生成结果">
        </div>
        <div class="result-controls">
          <button class="btn btn-small btn-secondary" type="button" data-action="download-row" data-row-id="${row.id}">
            <img src="/vendor/lucide/download.svg" alt="">下载
          </button>
          <button class="btn btn-small btn-secondary" type="button" data-action="generate-row" data-row-id="${row.id}" data-force="true">
            <img src="/vendor/lucide/refresh-cw.svg" alt="">重新生成
          </button>
          ${row.cost !== null ? `<span class="cost">$${escapeHtml(Number(row.cost).toFixed(6))}</span>` : ''}
        </div>`;
    }
    if (row.status === 'submitted' || row.status === 'generating') {
      return `<div class="result-empty"><div><strong>${statusLabel(row.status)}</strong><br><span class="preview-meta">${Math.max(0, Math.min(100, row.progress || 0))}%</span></div></div>`;
    }
    return `
      <div class="result-empty"><span>${row.status === 'failed' ? '修改提示词或检查配置后重试' : '生成结果将在这里显示'}</span></div>
      <div class="result-controls">
        <button class="btn btn-small ${row.status === 'failed' ? 'btn-secondary' : 'btn-primary'}" type="button" data-action="generate-row" data-row-id="${row.id}" ${row.prompt.trim() ? '' : 'disabled'}>
          <img src="/vendor/lucide/play.svg" alt="">${row.status === 'failed' ? '重试' : '生成本页'}
        </button>
      </div>`;
  }

  function renderRow(row, index) {
    const busy = row.status === 'submitted' || row.status === 'generating';
    const actionLink = row.errorInfo?.actionUrl
      ? `<a href="${escapeHtml(row.errorInfo.actionUrl)}" target="_blank" rel="noreferrer">前往 APIMart</a>`
      : '';
    const docsLink = row.error
      ? `<a href="${escapeHtml(row.errorInfo?.docsUrl || APIMART_DOCS_URL)}" target="_blank" rel="noreferrer">查看接口文档</a>`
      : '';
    return `
      <article class="page-card ${escapeHtml(row.status)}" data-row-card="${row.id}">
        <div class="page-editor">
          <div class="page-head">
            <span class="page-index">#${index + 1}</span>
            <span class="page-title" data-row-title="${row.id}">${escapeHtml(rowTitle(row, index))}</span>
            <div class="page-actions">
              <button class="icon-btn" type="button" data-action="move-up" data-row-id="${row.id}" aria-label="上移" ${index === 0 ? 'disabled' : ''}><img src="/vendor/lucide/arrow-up.svg" alt=""></button>
              <button class="icon-btn" type="button" data-action="move-down" data-row-id="${row.id}" aria-label="下移" ${index === state.rows.length - 1 ? 'disabled' : ''}><img src="/vendor/lucide/arrow-down.svg" alt=""></button>
              <button class="icon-btn" type="button" data-action="delete-row" data-row-id="${row.id}" aria-label="删除页面" ${busy ? 'disabled' : ''}><img src="/vendor/lucide/trash-2.svg" alt=""></button>
            </div>
          </div>
          <textarea class="textarea prompt-textarea" data-action="edit-prompt" data-row-id="${row.id}" placeholder="输入该页图片提示词...">${escapeHtml(row.prompt)}</textarea>
          <div class="reference-row">
            ${renderReferences(row)}
            <input class="hidden" type="file" id="referenceInput${row.id}" data-action="reference-files" data-row-id="${row.id}" accept="image/jpeg,image/png,image/webp,image/gif" multiple>
            <button class="btn btn-small btn-secondary" type="button" data-action="choose-reference" data-row-id="${row.id}">
              <img src="/vendor/lucide/image-plus.svg" alt="">参考图
            </button>
          </div>
          ${row.error ? `<div class="row-error"><span>${escapeHtml(row.error)}</span><span class="row-error-links">${actionLink}${docsLink}</span></div>` : ''}
        </div>
        <div class="page-result">
          <div class="result-head">
            <strong>生成结果</strong>
            <span class="status-badge ${escapeHtml(row.status)}">${statusLabel(row.status)}</span>
          </div>
          ${renderResult(row)}
        </div>
      </article>`;
  }

  function updateWorkflow() {
    const hasRows = state.rows.length > 0;
    const completed = state.rows.filter(row => row.status === 'completed').length;
    const allCompleted = hasRows && completed === state.rows.length;
    const steps = [
      { element: dom.workflowStep1, view: 'prompt', done: hasRows || state.conversation.messages.length > 0 },
      { element: dom.workflowStep2, view: 'generate', done: allCompleted },
      { element: dom.workflowStep3, view: 'export', done: completed > 0 },
    ];
    steps.forEach(step => {
      step.element.className = `workflow-step${state.currentView === step.view ? ' active' : ''}${step.done ? ' done' : ''}`;
      step.element.setAttribute('aria-current', state.currentView === step.view ? 'step' : 'false');
    });
  }

  function updateSummary() {
    const total = state.rows.length;
    const completed = state.rows.filter(row => row.status === 'completed').length;
    const running = state.rows.filter(row => row.status === 'submitted' || row.status === 'generating').length;
    dom.progressSummary.textContent = running > 0 ? `${completed}/${total} 页完成，${running} 页生成中` : `${completed}/${total} 页已完成`;
    dom.batchGenerateBtn.disabled = total === 0 || state.batchRunning || running > 0;
    const hasCompleted = completed > 0;
    [dom.exportImagesBtn, dom.exportPdfBtn, dom.exportPptBtn].forEach(button => { button.disabled = !hasCompleted; });
    dom.exportSummary.textContent = hasCompleted ? `${completed} 张图片可下载` : '尚无可下载图片';
    dom.reviewNotice.classList.toggle('hidden', !state.meta.reviewRequired);
    updateWorkflow();
  }

  function renderAll() {
    dom.emptyState.classList.toggle('hidden', state.rows.length > 0);
    dom.pageList.classList.toggle('hidden', state.rows.length === 0);
    dom.pageList.innerHTML = state.rows.map(renderRow).join('');
    renderChat();
    renderPromptPreview();
    updateSummary();
    updateCurrentProjectSummary();
  }

  function moveRow(rowId, direction) {
    const index = state.rows.findIndex(row => row.id === Number(rowId));
    const next = index + direction;
    if (index < 0 || next < 0 || next >= state.rows.length) return;
    [state.rows[index], state.rows[next]] = [state.rows[next], state.rows[index]];
    renderAll();
    scheduleSave();
  }

  function removeRow(rowId) {
    const row = getRow(rowId);
    if (!row || row.status === 'submitted' || row.status === 'generating') return;
    state.rows = state.rows.filter(item => item.id !== row.id);
    renderAll();
    scheduleSave();
  }

  function applyStylePreset(value) {
    state.settings.stylePreset = value;
    state.settings.globalPrefix = value === 'custom' ? dom.customStyleInput.value.trim() : (STYLE_PRESETS[value] || '');
    dom.customStyleWrap.classList.toggle('hidden', value !== 'custom');
    scheduleSave();
  }

  function composePrompt(row) {
    const prompt = row.prompt.trim();
    const prefix = state.settings.globalPrefix.trim();
    if (!prefix || prompt.startsWith(prefix)) return prompt;
    return `${prefix}\n\n${prompt}`;
  }

  async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadReferences(rowId, files) {
    const row = getRow(rowId);
    if (!row) return;
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        showToast(`${file.name} 超过 20MB`, 'error');
        continue;
      }
      try {
        showToast(`正在上传 ${file.name}...`);
        const data = await requestJson('/api/reference-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, mime: file.type, dataUrl: await fileToDataUrl(file) }),
        });
        row.refImages.push(normalizeReference(data.reference, row.refImages.length));
      } catch (error) {
        showToast(error.message, 'error');
        if (error.code === 'API_KEY_MISSING') openApiModal();
      }
    }
    renderAll();
    scheduleSave();
  }

  function buildGenerateBody(row, force) {
    const legacyUrls = row.refImages.filter(reference => !reference.id && reference.remoteUrl).map(reference => reference.remoteUrl);
    const referenceIds = row.refImages.filter(reference => reference.id).map(reference => reference.id);
    row.currentRequestKey = `${row.id}-${Date.now()}`;
    return {
      params: {
        model: 'gpt-image-2-official',
        prompt: composePrompt(row),
        size: '16:9',
        resolution: state.settings.resolution,
        quality: 'auto',
        n: 1,
        output_format: 'png',
        ...(legacyUrls.length ? { image_urls: legacyUrls } : {}),
      },
      referenceIds,
      idempotencyKey: row.currentRequestKey,
      rowId: row.id,
      pageNumber: state.rows.indexOf(row) + 1,
      force: Boolean(force),
      project: dom.projectName.value.trim() || 'default',
    };
  }

  async function generateRow(rowId, force = false, fromBatch = false) {
    const row = getRow(rowId);
    if (!row || !row.prompt.trim()) return false;
    if (['submitted', 'generating'].includes(row.status)) return false;
    if (state.batchRunning && !fromBatch) {
      showToast('批量任务进行中，请等待当前批次结束');
      return false;
    }
    if (!state.apiConfigured) {
      openApiModal();
      showToast('请先配置 APIMart API Key', 'error');
      return false;
    }
    row.status = 'submitted';
    row.progress = 1;
    row.error = null;
    row.errorInfo = null;
    renderAll();
    scheduleSave();
    try {
      const data = await requestJson('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildGenerateBody(row, force)),
      });
      row.taskId = data.taskId;
      if (data.completed && data.imageUrl) {
        row.status = 'completed';
        row.progress = 100;
        row.resultUrl = data.imageUrl;
      } else {
        row.status = data.status === 'completed' ? 'completed' : 'generating';
        schedulePoll(row);
      }
      renderAll();
      scheduleSave();
      return true;
    } catch (error) {
      row.status = 'failed';
      row.progress = 0;
      row.error = error.message;
      row.errorInfo = { code: error.code, actionUrl: error.actionUrl, docsUrl: error.docsUrl, retryable: error.retryable };
      renderAll();
      scheduleSave();
      showToast(error.message, 'error');
      return false;
    }
  }

  function applyTask(row, task) {
    const status = String(task?.status || '').toLowerCase();
    if (status === 'completed' || status === 'success' || status === 'succeeded') {
      row.status = 'completed';
      row.progress = 100;
      row.result = task.result || row.result;
      row.resultUrl = task.resultUrl || task.localUrl || row.resultUrl;
      row.cost = task.cost ?? row.cost;
      row.error = null;
      state.pollTimers.delete(row.id);
      return true;
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      row.status = 'failed';
      row.progress = Number(task.progress || 0);
      row.error = task.error || task.fail_reason || '生成失败';
      row.errorInfo = task.errorInfo || null;
      state.pollTimers.delete(row.id);
      return true;
    }
    row.status = 'generating';
    row.progress = Number(task?.progress || Math.min(95, (row.progress || 0) + 5));
    return false;
  }

  async function pollTask(row) {
    if (!row.taskId) return;
    try {
      const data = await requestJson('/api/task-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: row.taskId,
          rowId: row.id,
          pageNumber: state.rows.indexOf(row) + 1,
          project: dom.projectName.value.trim() || 'default',
        }),
      });
      const terminal = applyTask(row, data.task || data.data || data);
      renderAll();
      scheduleSave();
      if (!terminal) schedulePoll(row);
    } catch (error) {
      if (error.retryable || error.status >= 500) {
        row.error = '状态查询暂时失败，正在自动重试';
        renderAll();
        schedulePoll(row, 7000);
        return;
      }
      row.status = 'failed';
      row.error = error.message;
      row.errorInfo = { code: error.code, actionUrl: error.actionUrl, docsUrl: error.docsUrl, retryable: error.retryable };
      state.pollTimers.delete(row.id);
      renderAll();
      scheduleSave();
    }
  }

  function schedulePoll(row, delay = 4000) {
    if (state.pollTimers.has(row.id)) clearTimeout(state.pollTimers.get(row.id));
    const timer = setTimeout(() => {
      state.pollTimers.delete(row.id);
      pollTask(row);
    }, delay);
    state.pollTimers.set(row.id, timer);
  }

  function waitForTerminal(rowId, timeoutMs = 30 * 60 * 1000) {
    return new Promise(resolve => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const row = getRow(rowId);
        if (!row || row.status === 'completed' || row.status === 'failed' || Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          resolve(row?.status || 'missing');
        }
      }, 700);
    });
  }

  async function batchGenerate() {
    if (state.batchRunning) return;
    if (!state.apiConfigured) {
      openApiModal();
      showToast('请先配置 APIMart API Key', 'error');
      return;
    }
    const candidates = state.rows.filter(row => row.prompt.trim() && !['completed', 'submitted', 'generating'].includes(row.status));
    if (!candidates.length) {
      showToast('没有待生成页面');
      return;
    }
    state.batchRunning = true;
    state.meta.reviewRequired = false;
    dom.batchGenerateBtn.innerHTML = '<span class="spinner"></span>批量生成中';
    updateSummary();
    renderProjectList();
    let batchError = null;
    try {
      await window.BatchRunner.runStaggeredBatch(candidates, {
        submit: row => {
          if (getRow(row.id) !== row || ['completed', 'submitted', 'generating'].includes(row.status)) return false;
          return generateRow(row.id, row.status === 'failed', true);
        },
        waitForTerminal: row => waitForTerminal(row.id),
      });
    } catch (error) {
      batchError = error;
    } finally {
      state.batchRunning = false;
      dom.batchGenerateBtn.innerHTML = '<img src="/vendor/lucide/play.svg" alt="">批量生成';
      renderAll();
      scheduleSave();
    }
    showToast(batchError ? `批量任务已中断：${batchError.message || '未知错误'}` : '批量任务已处理完成', batchError ? 'error' : 'success');
  }

  async function resumePendingTasks() {
    const pendingRows = state.rows.filter(row => ['submitted', 'generating'].includes(row.status) && row.taskId);
    if (!pendingRows.length) return;
    try {
      const data = await requestJson('/api/recover-tasks');
      const tasks = data.tasks || [];
      for (const row of pendingRows) {
        const cached = tasks.find(task => task.taskId === row.taskId || Number(task.rowId) === row.id);
        if (cached) {
          const terminal = applyTask(row, cached);
          if (!terminal) schedulePoll(row, 800);
        } else {
          schedulePoll(row, 800);
        }
      }
      renderAll();
    } catch (error) {
      pendingRows.forEach(row => schedulePoll(row, 1600));
    }
  }

  function openImportModal() {
    state.parsedPages = [];
    dom.importPreviewList.innerHTML = '';
    dom.confirmImportBtn.disabled = true;
    dom.appendImport.checked = state.rows.length > 0;
    openModal('importModal');
    setTimeout(() => dom.modalPasteText.focus(), 0);
  }

  function parseImportText(text) {
    state.parsedPages = window.PromptParser.parse(text);
    renderImportPreview();
    dom.confirmImportBtn.disabled = state.parsedPages.length === 0;
    if (!state.parsedPages.length) showToast('没有识别到有效提示词', 'error');
    return state.parsedPages.length > 0;
  }

  function renderImportPreview() {
    dom.importPreviewList.innerHTML = state.parsedPages.map((page, index) => `
      <div class="preview-item">
        <span class="page-index">#${index + 1}</span>
        <strong title="${escapeHtml(page.title)}">${escapeHtml(page.title)}</strong>
        <span class="preview-meta">${page.prompt.length} 字</span>
        <button class="icon-btn" type="button" data-remove-import-page="${index}" aria-label="移除该页"><img src="/vendor/lucide/x.svg" alt=""></button>
      </div>`).join('');
  }

  function importPages(pages, append) {
    if (!pages.length) return;
    const imported = pages.map(page => createRow(page.prompt));
    state.rows = append ? state.rows.concat(imported) : imported;
    state.meta.reviewRequired = false;
    renderAll();
    scheduleSave();
    setWorkspaceView('generate');
    showToast(`已导入 ${imported.length} 个页面`, 'success');
  }

  function confirmImport() {
    if (!state.parsedPages.length) return;
    const pages = state.parsedPages;
    const append = dom.appendImport.checked;
    closeModal('importModal');
    importPages(pages, append);
  }

  function renderChat() {
    if (!dom.chatLog) return;
    const messages = state.conversation.messages;
    if (!messages.length) {
      dom.chatLog.innerHTML = '<div class="chat-empty">写下主题、受众和页数。模型会先追问缺少的信息，再整理成可生图的分页提示词。</div>';
    } else {
      dom.chatLog.innerHTML = messages.map(message => `
        <div class="chat-message ${message.role === 'assistant' ? 'assistant' : 'user'}">
          ${message.finalized ? '<span class="chat-tag">分页提示词</span>' : ''}
          ${escapeHtml(message.content)}
        </div>`).join('');
      dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
    }
    updateChatButtons();
  }

  function updateChatButtons() {
    const busy = state.chatSending;
    const hasDraft = Boolean(dom.chatInput?.value.trim());
    dom.sendChatBtn.disabled = busy;
    dom.finalizePromptsBtn.disabled = busy || (!hasDraft && state.conversation.messages.length === 0);
    dom.sendChatBtn.textContent = busy ? '思考中' : '发送';
  }

  function renderPromptPreview() {
    if (!dom.promptPreview) return;
    const pages = state.parsedDraftPages;
    dom.usePromptsBtn.disabled = pages.length === 0 || state.chatSending;
    if (!pages.length) {
      dom.promptPreview.innerHTML = '<p class="preview-meta">对话完成后，点击「生成详细提示词」查看分页。</p>';
      return;
    }
    dom.promptPreview.innerHTML = `<div class="prompt-preview-list">${pages.map((page, index) => `
      <article class="prompt-preview-item">
        <strong title="${escapeHtml(page.title)}">#${index + 1} ${escapeHtml(page.title)}</strong>
        <span class="preview-meta">${page.prompt.length} 字</span>
      </article>`).join('')}</div>`;
  }

  async function sendChat(finalize) {
    if (state.chatSending) return;
    const draft = dom.chatInput.value.trim();
    if (!finalize && !draft) {
      showToast('请先写下这套 PPT 的意图', 'error');
      return;
    }
    if (finalize && !draft && state.conversation.messages.length === 0) {
      showToast('请先发送意图，再生成详细提示词', 'error');
      return;
    }
    if (!state.apiConfigured) {
      showToast('请先配置 APIMart API Key', 'error');
      openApiModal();
      return;
    }
    if (draft) {
      state.conversation.messages.push({ role: 'user', content: draft, createdAt: new Date().toISOString() });
      dom.chatInput.value = '';
    }
    state.chatSending = true;
    renderChat();
    renderPromptPreview();
    scheduleSave();
    try {
      const data = await requestJson('/api/prompt-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.conversation.model,
          finalize: Boolean(finalize),
          messages: state.conversation.messages.map(message => ({ role: message.role, content: message.content })),
        }),
      });
      state.conversation.messages.push({
        role: 'assistant',
        content: data.content,
        createdAt: new Date().toISOString(),
        finalized: Boolean(finalize),
      });
      if (finalize) {
        restoreDraftFromConversation();
        if (!state.parsedDraftPages.length) showToast('没有识别到分页提示词，可以继续对话后重试', 'error');
      }
      scheduleSave();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      state.chatSending = false;
      renderChat();
      renderPromptPreview();
      updateWorkflow();
    }
  }

  function useDraftPrompts() {
    if (!state.parsedDraftPages.length) {
      showToast('请先生成详细提示词', 'error');
      return;
    }
    if (state.rows.length && !window.confirm('用这组提示词替换当前页面？')) return;
    importPages(state.parsedDraftPages, false);
  }

  function parseAndNext() {
    const text = dom.pastePromptText.value;
    if (!text.trim()) {
      showToast('请先粘贴已有的分页提示词', 'error');
      return;
    }
    const pages = window.PromptParser.parse(text);
    if (!pages.length) {
      showToast('没有识别到有效提示词，请检查格式后重试', 'error');
      return;
    }
    if (state.rows.length && !window.confirm('用这些提示词替换当前页面？')) return;
    importPages(pages, false);
  }

  function importExample() {
    const pages = window.PromptParser.parse(window.PPTER_TEMPLATES?.EXAMPLE_PROMPTS || '');
    if (!pages.length) return;
    if (state.rows.length && !window.confirm('用三页示范替换当前页面？')) return;
    importPages(pages, false);
  }

  function openApiModal() {
    dom.apiKeyInput.value = '';
    dom.apiKeyInput.placeholder = state.apiConfigured ? '输入新 Key 可替换当前配置' : '输入 APIMart API Key';
    dom.apiConfigHelp.textContent = state.apiConfigured
      ? '当前电脑已保存 Key。这里不会显示原始内容。同一把 Key 用于写提示词和生成图片。'
      : '同一把 Key 用于写提示词和生成图片。图片模型固定为 GPT Image 2 官方渠道。';
    dom.clearApiKeyBtn.classList.toggle('hidden', !state.apiConfigured);
    openModal('apiModal');
  }

  function updateApiState() {
    dom.apiSettingsBtn.classList.toggle('configured', state.apiConfigured);
    dom.apiStateText.textContent = state.apiConfigured ? 'APIMart 已配置' : '配置 APIMart';
  }

  async function loadConfig() {
    try {
      const data = await requestJson('/api/config');
      state.apiConfigured = Boolean(data.configured);
    } catch {
      state.apiConfigured = false;
    }
    updateApiState();
  }

  async function saveApiKey() {
    const apiKey = dom.apiKeyInput.value.trim();
    if (!apiKey) {
      showToast('请输入 API Key', 'error');
      return;
    }
    dom.saveApiKeyBtn.disabled = true;
    try {
      await requestJson('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      state.apiConfigured = true;
      updateApiState();
      closeModal('apiModal');
      showToast('API Key 已保存在本机', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      dom.saveApiKeyBtn.disabled = false;
    }
  }

  async function clearApiKey() {
    try {
      await requestJson('/api/config', { method: 'DELETE' });
      state.apiConfigured = false;
      updateApiState();
      closeModal('apiModal');
      showToast('本机 API Key 已清空', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function completedItems() {
    return state.rows.flatMap((row, index) => {
      const url = getImageUrls(row)[0];
      return row.status === 'completed' && url
        ? [{ url, filename: `page_${String(index + 1).padStart(2, '0')}.png` }]
        : [];
    });
  }

  async function saveImagesLocally(items) {
    return requestJson('/api/download-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, project: dom.projectName.value.trim() || 'default' }),
    });
  }

  function saveBlob(blob, filename) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function prepareExportImages(items) {
    const saved = await saveImagesLocally(items);
    const sources = (saved.results || []).map((result, index) => result.success && result.asset?.url
      ? { url: result.asset.url, filename: result.filename }
      : items[index]).filter(Boolean);
    const loaded = [];
    for (const item of sources) {
      const response = await fetch(item.url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const dimensions = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = reject;
        image.src = dataUrl;
      });
      const mime = blob.type || 'image/png';
      const ext = mime.includes('jpeg') ? 'jpg' : 'png';
      loaded.push({ ...item, blob, bytes, dataUrl, ...dimensions, ext, mime });
    }
    return loaded;
  }

  async function exportImages() {
    const items = completedItems();
    if (!items.length) return;
    try {
      const images = await prepareExportImages(items);
      const files = {};
      images.forEach((image, index) => { files[`ppt_images/page_${String(index + 1).padStart(2, '0')}.${image.ext}`] = image.bytes; });
      const zipped = window.fflate.zipSync(files);
      saveBlob(new Blob([zipped], { type: 'application/zip' }), `${safeProjectName()}-images.zip`);
      showToast(`已导出 ${images.length} 张图片`, 'success');
    } catch (error) {
      showToast(`图片包导出失败：${error.message}`, 'error');
    }
  }

  async function exportPdf() {
    const items = completedItems();
    if (!items.length) return;
    try {
      const images = await prepareExportImages(items);
      const { jsPDF } = window.jspdf;
      let pdf = null;
      images.forEach(image => {
        const orientation = image.width >= image.height ? 'landscape' : 'portrait';
        if (!pdf) pdf = new jsPDF({ orientation, unit: 'px', format: [image.width, image.height] });
        else pdf.addPage([image.width, image.height], orientation);
        pdf.addImage(image.dataUrl, undefined, 0, 0, image.width, image.height);
      });
      if (!pdf) throw new Error('没有可写入的图片');
      pdf.save(`${safeProjectName()}.pdf`);
      showToast(`已导出 ${images.length} 页 PDF`, 'success');
    } catch (error) {
      showToast(`PDF 导出失败：${error.message}`, 'error');
    }
  }

  function xmlEscape(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function buildPptx(images) {
    const files = {};
    const text = value => window.fflate.strToU8(value);
    const add = (name, value) => { files[name] = text(value); };
    const width = 12192000;
    const height = 6858000;
    const overrides = images.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
    const imageDefaults = Array.from(new Set(images.map(image => image.ext))).map(ext => `<Default Extension="${ext}" ContentType="${ext === 'jpg' ? 'image/jpeg' : 'image/png'}"/>`).join('');
    add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageDefaults}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${overrides}</Types>`);
    add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
    const slideIds = images.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('');
    add('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${images.length + 1}"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
    const presentationRels = images.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('');
    add('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRels}<Relationship Id="rId${images.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>`);
    add('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
    add('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
    add('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
    add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
    add('ppt/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PPTER"><a:themeElements><a:clrScheme name="PPTER"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1C2430"/></a:dk2><a:lt2><a:srgbClr val="F4F6F8"/></a:lt2><a:accent1><a:srgbClr val="2767C8"/></a:accent1><a:accent2><a:srgbClr val="16805B"/></a:accent2><a:accent3><a:srgbClr val="9A5B00"/></a:accent3><a:accent4><a:srgbClr val="B42318"/></a:accent4><a:accent5><a:srgbClr val="7A5AF8"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="PPTER"><a:majorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="PPTER"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
    images.forEach((image, index) => {
      const number = index + 1;
      files[`ppt/media/image${number}.${image.ext}`] = image.bytes;
      add(`ppt/slides/slide${number}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:pic><p:nvPicPr><p:cNvPr id="2" name="${xmlEscape(image.filename)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
      add(`ppt/slides/_rels/slide${number}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${number}.${image.ext}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
    });
    return window.fflate.zipSync(files, { level: 0 });
  }

  async function exportPpt() {
    const items = completedItems();
    if (!items.length) return;
    try {
      const images = await prepareExportImages(items);
      const bytes = buildPptx(images);
      saveBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), `${safeProjectName()}.pptx`);
      showToast(`已导出 ${images.length} 页 PPTX`, 'success');
    } catch (error) {
      showToast(`PPTX 导出失败：${error.message}`, 'error');
    }
  }

  function safeProjectName() {
    return (dom.projectName.value.trim() || 'ppter-ppt').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
  }

  async function downloadRow(rowId) {
    const row = getRow(rowId);
    const url = row ? getImageUrls(row)[0] : '';
    if (!url) return;
    try {
      const page = state.rows.indexOf(row) + 1;
      const images = await prepareExportImages([{ url, filename: `page_${String(page).padStart(2, '0')}.png` }]);
      if (!images[0]) throw new Error('图片读取失败');
      saveBlob(images[0].blob, images[0].filename);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function deleteProject(projectId) {
    const project = state.projects.find(item => item.id === projectId);
    if (!project || state.switchingProject) return;
    if (state.batchRunning && projectId === state.currentProjectId) {
      showToast('批量生成进行中，请等待结束后再删除', 'error');
      return;
    }
    const name = project.name || '未命名 PPT';
    if (!window.confirm(`删除「${name}」？页面、对话和提示词会从列表移除。`)) return;
    clearTimeout(state.saveTimer);
    state.switchingProject = true;
    try {
      const data = await requestJson(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      state.projects = Array.isArray(data.projects) ? data.projects : [];
      if (projectId === state.currentProjectId) {
        state.pollTimers.forEach(timer => clearTimeout(timer));
        state.pollTimers.clear();
        const next = await requestJson(`/api/projects/${encodeURIComponent(data.activeProjectId)}`);
        restoreProject(next.project);
        applyProjectToControls();
        setWorkspaceView(state.rows.length ? 'generate' : 'prompt', { scroll: false });
        dom.saveState.textContent = '已保存';
        dom.saveState.className = 'save-state';
      }
      renderAll();
      showToast('已删除历史项目', 'success');
    } catch (error) {
      showToast(`删除失败：${error.message}`, 'error');
    } finally {
      state.switchingProject = false;
    }
  }

  async function selectProject(projectId) {
    if (!projectId || projectId === state.currentProjectId || state.switchingProject) {
      closeSidebar();
      return;
    }
    await saveProjectNow();
    state.switchingProject = true;
    state.pollTimers.forEach(timer => clearTimeout(timer));
    state.pollTimers.clear();
    try {
      const data = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/activate`, { method: 'POST' });
      restoreProject(data.project);
      applyProjectToControls();
      setWorkspaceView(state.rows.length ? 'generate' : 'prompt', { scroll: false });
      dom.saveState.textContent = '已保存';
      dom.saveState.className = 'save-state';
      renderAll();
      closeSidebar();
      resumePendingTasks();
    } catch (error) {
      showToast(`项目切换失败：${error.message}`, 'error');
    } finally {
      state.switchingProject = false;
    }
  }

  async function newProject() {
    if (state.switchingProject) return;
    await saveProjectNow();
    state.switchingProject = true;
    state.pollTimers.forEach(timer => clearTimeout(timer));
    state.pollTimers.clear();
    dom.newProjectBtn.disabled = true;
    try {
      const data = await requestJson('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '未命名 PPT' }),
      });
      const project = data.project;
      state.projects.unshift({
        id: project.id,
        name: project.meta?.name || '未命名 PPT',
        pageCount: 0,
        completedCount: 0,
        createdAt: project.createdAt,
        updatedAt: project.savedAt || project.createdAt,
      });
      restoreProject(project);
      applyProjectToControls();
      setWorkspaceView('prompt', { scroll: false });
      dom.saveState.textContent = '已保存';
      dom.saveState.className = 'save-state';
      renderAll();
      closeSidebar();
      setTimeout(() => {
        dom.projectName.focus();
        dom.projectName.select();
      }, 0);
    } catch (error) {
      showToast(`新建 PPT 失败：${error.message}`, 'error');
    } finally {
      state.switchingProject = false;
      dom.newProjectBtn.disabled = false;
    }
  }

  function bindEvents() {
    dom.apiSettingsBtn.addEventListener('click', openApiModal);
    dom.newProjectBtn.addEventListener('click', newProject);
    dom.sidebarToggleBtn.addEventListener('click', () => document.body.classList.add('sidebar-open'));
    dom.sidebarCloseBtn.addEventListener('click', closeSidebar);
    dom.sidebarBackdrop.addEventListener('click', closeSidebar);
    dom.projectList.addEventListener('click', event => {
      const remove = event.target.closest('[data-delete-project-id]');
      if (remove) {
        deleteProject(remove.dataset.deleteProjectId);
        return;
      }
      const project = event.target.closest('[data-project-id]');
      if (project) selectProject(project.dataset.projectId);
    });
    dom.sendChatBtn.addEventListener('click', () => sendChat(false));
    dom.finalizePromptsBtn.addEventListener('click', () => sendChat(true));
    dom.usePromptsBtn.addEventListener('click', useDraftPrompts);
    dom.textModel.addEventListener('change', event => {
      state.conversation.model = event.target.value;
      scheduleSave();
    });
    dom.chatInput.addEventListener('input', updateChatButtons);
    dom.chatInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendChat(false);
      }
    });
    document.querySelectorAll('[data-workspace-view]').forEach(button => {
      if (button.matches('.workflow-step')) button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceView));
    });
    dom.helpBtn.addEventListener('click', () => { window.location.href = '/help.html'; });
    dom.parseAndNextBtn.addEventListener('click', parseAndNext);
    dom.pasteImportExampleBtn.addEventListener('click', importExample);
    dom.openImportBtn.addEventListener('click', openImportModal);
    dom.emptyStateImportBtn.addEventListener('click', () => setWorkspaceView('prompt'));
    const addBlankPage = () => {
      state.rows.push(createRow());
      setWorkspaceView('generate');
      renderAll();
      scheduleSave();
    };
    dom.addPageBtn.addEventListener('click', addBlankPage);
    dom.emptyStateAddBtn.addEventListener('click', addBlankPage);
    dom.stylePreset.addEventListener('change', event => applyStylePreset(event.target.value));
    dom.customStyleInput.addEventListener('input', event => {
      if (state.settings.stylePreset === 'custom') state.settings.globalPrefix = event.target.value.trim();
      scheduleSave();
    });
    dom.resolution.addEventListener('change', event => { state.settings.resolution = event.target.value; scheduleSave(); });
    dom.projectName.addEventListener('input', () => {
      state.meta.name = dom.projectName.value;
      updateCurrentProjectSummary();
      scheduleSave();
    });
    dom.batchGenerateBtn.addEventListener('click', batchGenerate);
    dom.exportImagesBtn.addEventListener('click', exportImages);
    dom.exportPdfBtn.addEventListener('click', exportPdf);
    dom.exportPptBtn.addEventListener('click', exportPpt);
    dom.confirmReviewBtn.addEventListener('click', () => {
      state.meta.reviewRequired = false;
      state.meta.reviewedAt = new Date().toISOString();
      renderAll();
      saveProjectNow();
      showToast('提示词已确认', 'success');
    });
    dom.parsePromptsBtn.addEventListener('click', () => parseImportText(dom.modalPasteText.value));
    dom.confirmImportBtn.addEventListener('click', confirmImport);
    dom.saveApiKeyBtn.addEventListener('click', saveApiKey);
    dom.clearApiKeyBtn.addEventListener('click', clearApiKey);

    document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('mousedown', event => {
      if (event.target === backdrop) closeModal(backdrop.id);
    }));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop.open').forEach(modal => closeModal(modal.id));
    });

    dom.importPreviewList.addEventListener('click', event => {
      const button = event.target.closest('[data-remove-import-page]');
      if (!button) return;
      state.parsedPages.splice(Number(button.dataset.removeImportPage), 1);
      renderImportPreview();
      dom.confirmImportBtn.disabled = state.parsedPages.length === 0;
    });

    dom.pageList.addEventListener('input', event => {
      const target = event.target;
      if (target.dataset.action !== 'edit-prompt') return;
      const row = getRow(target.dataset.rowId);
      if (!row) return;
      row.prompt = target.value;
      const title = dom.pageList.querySelector(`[data-row-title="${row.id}"]`);
      if (title) title.textContent = rowTitle(row, state.rows.indexOf(row));
      scheduleSave();
    });

    dom.pageList.addEventListener('change', event => {
      const target = event.target;
      if (target.dataset.action === 'reference-files') {
        uploadReferences(target.dataset.rowId, Array.from(target.files || []));
        target.value = '';
      }
    });

    dom.pageList.addEventListener('click', event => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const rowId = Number(target.dataset.rowId);
      switch (target.dataset.action) {
        case 'move-up': moveRow(rowId, -1); break;
        case 'move-down': moveRow(rowId, 1); break;
        case 'delete-row': removeRow(rowId); break;
        case 'choose-reference': byId(`referenceInput${rowId}`)?.click(); break;
        case 'remove-reference': {
          const row = getRow(rowId);
          if (row) row.refImages.splice(Number(target.dataset.referenceIndex), 1);
          renderAll();
          scheduleSave();
          break;
        }
        case 'generate-row': generateRow(rowId, target.dataset.force === 'true'); break;
        case 'download-row': downloadRow(rowId); break;
        case 'preview-image':
          dom.imagePreview.src = target.dataset.imageUrl;
          openModal('imagePreviewModal');
          break;
        default: break;
      }
    });

    dom.pageList.addEventListener('error', event => {
      if (event.target.matches('.result-image-wrap img')) {
        const wrap = event.target.closest('.result-image-wrap');
        wrap.innerHTML = '<div class="result-empty">图片链接已失效，请重新生成</div>';
      }
    }, true);
  }

  async function loadInitialData() {
    const [info, projectIndex] = await Promise.all([
      requestJson('/api/app-info').catch(() => ({ version: '2.1.0' })),
      requestJson('/api/projects').catch(() => ({ projects: [], activeProjectId: '' })),
    ]);
    dom.versionBadge.textContent = `v${info.version || '2.1.0'}`;
    state.projects = Array.isArray(projectIndex.projects) ? projectIndex.projects : [];
    state.currentProjectId = String(projectIndex.activeProjectId || state.projects[0]?.id || '');
    let project = {};
    if (state.currentProjectId) {
      const data = await requestJson(`/api/projects/${encodeURIComponent(state.currentProjectId)}`).catch(() => ({}));
      project = data.project || {};
    }
    if (!project.meta) project = await requestJson('/api/project').catch(() => ({}));
    restoreProject(project);
    if (!state.projects.some(item => item.id === state.currentProjectId) && state.currentProjectId) {
      state.projects.unshift({
        id: state.currentProjectId,
        name: state.meta.name,
        pageCount: state.rows.length,
        completedCount: state.rows.filter(row => row.status === 'completed').length,
      });
    }
    applyProjectToControls();
    setWorkspaceView(state.rows.length ? 'generate' : 'prompt', { scroll: false });
    renderAll();
    await loadConfig();
    resumePendingTasks();
  }

  async function start() {
    cacheDom();
    bindEvents();
    await loadInitialData();
  }

  window.addEventListener('DOMContentLoaded', start);
  window.PPTER_LINKS = { docs: APIMART_DOCS_URL, account: APIMART_ACCOUNT_URL };
}());
