(() => {
  'use strict';
  const content = document.getElementById('content');
  const connection = document.getElementById('connection');
  const statuses = { queued: '排队中', running: '处理中', cancelling: '正在取消', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const effortLabels = { default: '服务商默认', low: '低', high: '高', max: '最高' };
  const effortLabel = value => effortLabels[value ?? 'default'] ?? '服务商默认';
  const modelLists = new Map();
  const modelDetails = new Map();
  const modelLoads = new Map();
  const providerTests = new Map();
  let state;
  let activeTab = 'overview';
  let selectedTaskId = null;
  let selectedTask = null;
  let refreshing = false;
  let noticeTimer;
  let bridgeId = 0;
  const bridgePending = new Map();
  const embedded = window.parent !== window;
  const parameters = new URLSearchParams(location.hash.slice(1));
  let token = parameters.get('token');
  if (!embedded) {
    if (token) {
      sessionStorage.setItem('model-team-panel-token', token);
      history.replaceState(null, '', location.pathname);
    } else token = sessionStorage.getItem('model-team-panel-token');
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const badge = status => `<span class="badge ${status === 'completed' ? 'success' : ['failed', 'interrupted'].includes(status) ? 'error' : ['running', 'queued'].includes(status) ? 'running' : ''}">${escape(statuses[status] ?? status)}</span>`;
  const button = (action, label, id, kind = 'text-button') => `<button type="button" class="${kind}" data-action="${action}"${id ? ` data-id="${escape(id)}"` : ''}>${escape(label)}</button>`;
  const formatNumber = value => Number.isFinite(value) ? Number(value).toLocaleString('zh-CN') : '';
  const modelDisplayName = detail => detail?.documentedVersion || detail?.name;
  function modelDetailLine(detail) {
    if (!detail) return '';
    const modalities = { text: '文本', image: '图像', audio: '音频', video: '视频' };
    const inputs = (detail.inputModalities ?? []).map(value => modalities[value] ?? value).join('、');
    const versionNote = detail.documentedVersion ? `官方文档核对 ${new Date(detail.versionCheckedAt).toLocaleDateString('zh-CN')}` : '';
    return [modelDisplayName(detail), detail.contextWindow ? `上下文 ${formatNumber(detail.contextWindow)}` : '', detail.maxOutputTokens ? `最大输出 ${formatNumber(detail.maxOutputTokens)}` : '', inputs ? `输入 ${inputs}` : '', versionNote].filter(Boolean).join(' · ');
  }
  function detailOf(providerId, modelId) { return modelDetails.get(providerId)?.get(modelId); }
  function detailByModelId(modelId) { for (const map of modelDetails.values()) { const found = map.get(modelId); if (found) return found; } return null; }
  function jobModelLabel(job) { const name = modelDisplayName(detailByModelId(job.model)); return name && name !== job.model ? `${job.model} · ${name}` : job.model; }
  function rememberModels(providerId, details) {
    const map = new Map();
    for (const detail of details ?? []) if (detail?.id) map.set(detail.id, detail);
    modelDetails.set(providerId, map);
  }

  window.addEventListener('message', event => {
    if (!embedded || event.source !== window.parent || !event.data || event.data.jsonrpc !== '2.0') return;
    const message = event.data;
    if (message.id != null && bridgePending.has(message.id)) {
      const pending = bridgePending.get(message.id);
      bridgePending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    }
    if (message.method === 'ui/notifications/tool-result') {
      const next = message.params?.structuredContent;
      if (Array.isArray(next?.roles) && Array.isArray(next.jobs)) {
        state = next;
      } else if (Array.isArray(next?.roles) && state) {
        state = {
          ...state,
          roles: next.roles,
          providers: next.providers ?? state.providers,
          coordinator: next.coordinator ?? state.coordinator,
        };
      }
      if (state && !document.querySelector('dialog[open]')) render();
    }
  });
  function hostRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++bridgeId;
      const timer = setTimeout(() => { bridgePending.delete(id); reject(new Error('插件面板连接超时，可使用本机协作面板继续配置。')); }, 30000);
      bridgePending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  async function request(operation, input = {}) {
    if (embedded) {
      const response = await hostRequest('tools/call', { name: operation, arguments: input });
      if (response.isError) throw new Error(response.content?.find(item => item.type === 'text')?.text ?? '操作失败。');
      return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
    }
    if (!token) throw new Error('请通过“打开协作面板”入口打开，恢复本机连接。');
    const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-model-team-token': token }, body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? '操作失败。');
    return body.result;
  }
  function notify(message, isError = false) {
    const notice = document.getElementById('notice');
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.classList.toggle('error', isError);
    notice.hidden = false;
    noticeTimer = setTimeout(() => { notice.hidden = true; }, isError ? 7000 : 3500);
  }
  function pageHead(title, subtitle, actions = '') { return `<div class="page-head"><div><h1>${title}</h1><p class="subtext">${subtitle}</p></div>${actions}</div>`; }
  function providerOptions(selectedId) { return state.providers.map(provider => `<option value="${escape(provider.id)}"${provider.id === selectedId ? ' selected' : ''}>${escape(provider.name)}</option>`).join(''); }
  function roleOptions() {
    return state.roles.map(role => {
      const detail = detailOf(role.providerId, role.model);
      const name = modelDisplayName(detail);
      const model = name && name !== role.model ? `${role.model} · ${name}` : role.model;
      return `<option value="${escape(role.id)}">${escape(role.name)} · ${escape(model)}</option>`;
    }).join('');
  }
  function renderOverview() {
    const configured = state.providers.filter(provider => provider.hasKey).length;
    const running = state.jobs.filter(job => !terminal.has(job.status)).length;
    return `${pageHead('把合适的任务，交给合适的助手', '在当前聊天中协调，也可以从这里直接分配任务。')}
      <section class="hero"><div><div class="eyebrow">你的模型协作工作台</div><h2>GPT 协调，外部模型协作</h2><p>为每个助手选择模型和职责。当前 GPT 负责拆分任务、核对结论并整合交付。</p><div class="flow"><span>提出需求</span><b>→</b><span>助手处理子任务</span><b>→</b><span>检查与汇总</span></div></div>${button('new-task', '分配一个任务', '', 'primary')}</section>
      <div class="metrics"><div class="metric"><div class="label">已配置密钥的服务</div><div class="number">${configured}<span class="small"> / ${state.providers.length}</span></div></div><div class="metric"><div class="label">可用角色配置</div><div class="number">${state.roles.length}</div></div><div class="metric"><div class="label">处理与排队任务</div><div class="number">${running}</div></div></div>
      <div class="cards"><section class="card"><h3>开始使用</h3><div class="step"><span class="step-num">1</span><div><strong>保存接口和密钥</strong><p>在“模型接入”中填写密钥，并测试连接。</p></div></div><div class="step"><span class="step-num">2</span><div><strong>配置助手角色</strong><p>为分析、审查等工作选择模型及职责。</p></div></div><div class="step"><span class="step-num">3</span><div><strong>分配明确的任务</strong><p>提供必要的参考材料，等待结果后检查和汇总。</p></div></div></section><section class="card"><h3>在聊天中使用</h3><p class="subtext">插件加载后，可以直接告诉当前 GPT 需要怎样协作。</p><pre class="prompt-example">使用多模型协作插件，让分析助手检查方案，审查助手独立找问题。等两位助手完成后，核对并汇总结果。</pre><p class="view-label">插件工具会在桌面端重新加载后出现在可用工具中。助手通过 API 返回内容，文件修改由当前 GPT 处理。</p></section></div>`;
  }
  function renderProviders() {
    return `${pageHead('模型接入', '连接 DeepSeek 或其他兼容 Chat Completions 的模型服务。', button('new-provider', '添加服务', '', 'primary'))}
      <div class="cards">${state.providers.map(provider => {
        const tested = providerTests.get(provider.id);
        const models = modelLists.get(provider.id) ?? [];
        const modelRows = models.slice(0, 100).map(model => {
          const detail = modelDetailLine(detailOf(provider.id, model));
          return `<div class="model-item"><code>${escape(model)}</code>${detail ? `<span>${escape(detail)}</span>` : ''}</div>`;
        }).join('');
        return `<section class="card"><div class="card-top"><h3>${escape(provider.name)}</h3><span class="badge ${provider.hasKey ? 'success' : 'warn'}">${provider.hasKey ? '密钥已配置' : '待填写密钥'}</span></div><div class="endpoint">${escape(provider.baseUrl)}</div><p class="small">密钥保存在此 Windows 用户的加密存储中。</p><div class="card-actions">${button('test-provider', '测试连接', provider.id, 'secondary')}${button('edit-provider', '编辑', provider.id)}${button('delete-provider', '移除', provider.id, 'text-button remove')}</div>${tested ? `<div class="provider-test ${tested.error ? 'error' : ''}">${escape(tested.message)}</div>` : ''}${models.length ? `<details class="model-list"><summary>查看 ${models.length} 个模型</summary>${modelRows}</details>` : ''}</section>`;
      }).join('') || '<div class="empty"><h2>添加第一个模型服务</h2><p>保存接口地址和密钥后，即可为助手选择模型。</p></div>'}</div>`;
  }
  function renderRoles() {
    const coordinator = state.coordinator ?? {};
    const coordinatorName = coordinator.name || '主 Agent';
    const coordinatorSystem = coordinator.system || '沿用模型的基础行为。';
    const coordinatorPreview = coordinatorSystem.length > 240 ? `${coordinatorSystem.slice(0, 240)}…` : coordinatorSystem;
    return `${pageHead('助手角色', '每个角色使用独立的模型设置和职责说明。', button('new-role', '添加角色', '', 'primary'))}<section class="card coordinator-card"><div class="card-top"><h3>${escape(coordinatorName)}</h3><span class="badge success">当前 GPT</span></div><div class="model-name">当前 GPT 聊天所选模型</div><div class="small">执行模型由当前 GPT 聊天界面选择。</div><p class="role-system">${escape(coordinatorPreview)}</p><div class="info-box">这是当前 GPT 的协作配置。插件可通过 get_coordinator 读取，也可复制职责到 GPT 聊天使用。</div><div class="card-actions">${button('edit-coordinator', '编辑主Agent')}${button('copy-coordinator', '复制职责', '', 'secondary')}</div></section><div class="cards">${state.roles.map(role => {
      const provider = state.providers.find(item => item.id === role.providerId);
      const detail = detailOf(role.providerId, role.model);
      return `<section class="card"><div class="card-top"><h3>${escape(role.name)}</h3><span class="badge ${provider?.hasKey ? '' : 'warn'}">${provider?.hasKey ? '已配置' : '服务待配置'}</span></div><div class="model-name">${escape(role.model)}</div><div class="small">${escape(provider?.name ?? '服务已移除')}</div>${detail && modelDetailLine(detail) ? `<div class="model-detail">${escape(modelDetailLine(detail))}</div>` : ''}<p class="role-system">${escape(role.system || '沿用模型的基础行为。')}</p><div class="meta"><span>推理 ${escape(effortLabel(role.reasoningEffort))}</span><span>输出上限 ${role.maxTokens} 词元</span><span>超时 ${role.timeoutSeconds} 秒</span></div><div class="card-actions">${button('edit-role', '编辑角色', role.id, 'secondary')}${button('role-task', '分配任务', role.id)}${button('delete-role', '移除', role.id, 'text-button remove')}</div></section>`;
    }).join('') || '<div class="empty"><h2>创建第一个助手角色</h2><p>选定模型，并写明助手应该完成的工作。</p></div>'}</div>`;
  }
  function renderTaskDetail() {
    if (!selectedTask) return '<div class="empty"><h2>选择任务查看结果</h2><p>任务结果会保存在本机，重新打开后可以继续查看。</p></div>';
    const job = selectedTask;
    const pending = !terminal.has(job.status);
    const requestedModel = detailByModelId(job.model);
    const requestedName = modelDisplayName(requestedModel);
    const requestedLabel = requestedName && requestedName !== job.model ? `（${requestedName}）` : '';
    const elapsedSeconds = Math.max(0, Math.floor(((job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()) - new Date(job.startedAt || job.createdAt).getTime()) / 1000));
    const stages = { waiting: '等待模型响应', thinking: '模型推理中', writing: '正在生成结果' };
    const progress = pending ? `<div class="info-box" role="status">${job.status === 'queued' ? '等待空闲助手' : escape(stages[job.stage] ?? statuses[job.status])} · 已用 ${elapsedSeconds} 秒${job.outputCharacters ? ` · 已生成 ${Number(job.outputCharacters)} 字符` : ''}</div>` : '';
    const preview = !job.result && job.partialResult ? `<p class="small">已生成的部分内容，完整性待任务结束后核对</p><pre class="result">${escape(job.partialResult)}</pre>` : '';
    return `<div class="task-status">${badge(job.status)}<div>${pending ? button('cancel-task', '取消任务', job.id) : ['failed', 'cancelled', 'interrupted'].includes(job.status) ? button('retry-task', '重试', job.id) : ''}${job.result ? button('copy-result', '复制结果', job.id) : ''}</div></div><h3 style="margin-top:20px">${escape(job.roleName)}</h3><div class="meta"><span>${escape(job.providerName)} · ${escape(job.model)}${escape(requestedLabel)} · 推理 ${escape(effortLabel(job.reasoningEffort))}</span><span>${date(job.createdAt)}</span></div>${job.error ? `<div class="error-box" style="margin-top:20px">${escape(job.error)}</div>` : ''}${job.truncated ? '<div class="info-box">本次输出达到词元上限。可调整角色的输出上限，再明确要求助手继续。</div>' : ''}${progress}${preview}${job.result ? `<pre class="result">${escape(job.result)}</pre>` : pending && !job.partialResult ? '<div class="empty"><div class="spinner"></div><p>助手正在处理任务，请稍候。</p></div>' : ''}${job.usage ? `<div class="usage">本次用量 · 输入 ${Number(job.usage.prompt_tokens ?? 0)} / 输出 ${Number(job.usage.completion_tokens ?? 0)} 词元 · 请求模型 ${escape(job.model)}${job.responseModel ? ` · 返回模型 ${escape(job.responseModel)}` : ''}${job.systemFingerprint ? ` · 后端指纹 ${escape(job.systemFingerprint)}` : ''}</div>` : ''}<details class="task-material"><summary>查看任务要求和参考材料</summary><pre>${escape(job.task)}${job.context ? '\n\n' + escape(job.context) : ''}</pre></details>`;
  }
  function renderTasks() {
    return `${pageHead('协作任务', '跟踪外部助手的处理状态，检查并收取结果。', button('new-task', '分配任务', '', 'primary'))}<div class="card"><div class="inline-settings"><span>同时处理</span><select id="concurrency" aria-label="并发任务数量">${[1, 2, 3, 4].map(value => `<option value="${value}"${state.concurrency === value ? ' selected' : ''}>${value} 个任务</option>`).join('')}</select><span class="small">调整后对后续排队任务生效</span></div></div><div class="tasks-layout"><section class="task-list">${state.jobs.map(job => `<button class="task-row ${selectedTaskId === job.id ? 'selected' : ''}" data-action="select-task" data-id="${escape(job.id)}">${badge(job.status)}<div class="title">${escape(job.task)}</div><div class="meta"><span>${escape(job.roleName)} · ${escape(jobModelLabel(job))}</span><span>${date(job.createdAt)}</span></div></button>`).join('') || '<div class="card empty"><h2>还没有协作任务</h2><p>给助手分配一个明确的小任务，开始第一次协作。</p></div>'}</section><section class="card task-detail">${renderTaskDetail()}</section></div>`;
  }
  function render() {
    if (!state) return;
    document.querySelectorAll('[data-tab]').forEach(element => element.classList.toggle('active', element.dataset.tab === activeTab));
    const queued = state.jobs.filter(job => !terminal.has(job.status)).length;
    document.getElementById('queue-count').textContent = queued || '';
    content.innerHTML = ({ overview: renderOverview, providers: renderProviders, roles: renderRoles, tasks: renderTasks })[activeTab]();
    if (embedded) window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: Math.min(900, Math.max(620, document.body.scrollHeight)) } }, '*');
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [nextState, nextTask] = await Promise.all([
        request('get_state'),
        selectedTaskId && !terminal.has(selectedTask?.status) ? request('get_task', { id: selectedTaskId }) : selectedTask,
      ]);
      state = nextState;
      selectedTask = nextTask;
      connection.textContent = '已连接本机服务';
      prefetchModels();
      if (!document.querySelector('dialog[open]')) render();
    } finally { refreshing = false; }
  }
  function loadModels(providerId) {
    const previous = modelLoads.get(providerId);
    if (previous?.loading) return previous.promise;
    const load = { loading: true, updatedAt: previous?.updatedAt, error: '' };
    modelLoads.set(providerId, load);
    load.promise = request('test_provider', { id: providerId }).then(result => {
      if (modelLoads.get(providerId) !== load) return null;
      modelLists.set(providerId, result.models ?? []);
      rememberModels(providerId, result.details ?? (result.models ?? []).map(model => ({ id: model })));
      load.updatedAt = new Date();
      return result;
    }).catch(error => {
      if (modelLoads.get(providerId) !== load) return null;
      load.error = error.message;
      throw error;
    }).finally(() => {
      if (modelLoads.get(providerId) !== load) return;
      load.loading = false;
      updateModelOptions();
      updateRoleModelHint();
      if (!document.querySelector('dialog[open]')) render();
    });
    updateModelOptions();
    return load.promise;
  }
  function prefetchModels() {
    for (const provider of state.providers) {
      if (provider.hasKey && !modelLoads.has(provider.id)) loadModels(provider.id).catch(() => {});
    }
  }
  function fillForm(form, values) {
    form.reset();
    form.querySelector('.form-error').textContent = '';
    for (const [key, value] of Object.entries(values)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else field.value = value ?? '';
    }
  }
  function openProvider(id) {
    const provider = state.providers.find(item => item.id === id);
    const form = document.getElementById('provider-form');
    fillForm(form, provider ?? { id: '', name: '', baseUrl: 'https://api.deepseek.com/v1' });
    form.elements.apiKey.value = '';
    document.getElementById('provider-heading').textContent = provider ? '编辑模型服务' : '添加模型服务';
    document.getElementById('provider-dialog').showModal();
  }
  function updateModelOptions() {
    const form = document.getElementById('role-form');
    const id = form.elements.providerId.value;
    const load = modelLoads.get(id);
    const provider = state?.providers.find(item => item.id === id);
    const status = document.getElementById('role-model-status');
    status.classList.toggle('error', Boolean(load?.error));
    if (load?.loading) status.textContent = '正在获取服务商模型列表…';
    else if (load?.error) status.textContent = `读取失败，仍可手动填写模型 ID。${load.error}`;
    else if (load?.updatedAt) status.textContent = `${provider?.name ?? '当前服务'} · 来自服务商模型列表 · 更新于 ${load.updatedAt.toLocaleTimeString('zh-CN')}`;
    else status.textContent = '可刷新服务商模型列表，或直接手动填写模型 ID。';
    document.getElementById('model-picker-refresh').disabled = Boolean(load?.loading);
    const models = modelLists.get(id) ?? [];
    const list = document.getElementById('role-model-list');
    const focusedModel = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    list.innerHTML = models.map(model => {
      const selected = model === form.elements.model.value.trim();
      return `<button type="button" class="model-option${selected ? ' selected' : ''}" data-action="choose-model" data-id="${escape(model)}" aria-pressed="${selected}"><strong>${escape(model)}</strong><span>${escape(modelDetailLine(detailOf(id, model)))}</span><span class="model-option-current">${selected ? '当前选择' : ''}</span></button>`;
    }).join('') || `<p class="model-picker-empty">${load?.loading ? '正在加载可选模型…' : '当前没有可展示的模型，可手动填写模型 ID。'}</p>`;
    if (focusedModel) {
      const options = [...list.querySelectorAll('[data-action="choose-model"]')];
      const focusTarget = options.find(option => option.dataset.id === focusedModel);
      (focusTarget ?? document.getElementById('model-picker-refresh')).focus();
    }
  }
  function updateRoleModelHint() {
    const form = document.getElementById('role-form');
    const hint = document.getElementById('role-model-hint');
    if (!form || !hint) return;
    const detail = detailOf(form.elements.providerId.value, form.elements.model.value.trim());
    hint.textContent = detail ? modelDetailLine(detail) : '';
    const model = form.elements.model.value.trim();
    const models = modelLists.get(form.elements.providerId.value);
    let warning = '';
    if (model && !models) warning = '尚未获取模型列表，保存后将按填写的模型 ID 发送。';
    else if (model && !models.includes(model)) warning = '该模型不在当前服务商列表中，保存后将按原样发送。';
    document.getElementById('role-model-warning').textContent = warning;
    document.querySelectorAll('#role-model-list [data-action="choose-model"]').forEach(option => {
      const selected = option.dataset.id === model;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-pressed', String(selected));
      option.querySelector('.model-option-current').textContent = selected ? '当前选择' : '';
    });
  }
  function openRole(id) {
    if (!state.providers.length) return notify('请先添加一个模型服务。', true);
    const role = state.roles.find(item => item.id === id);
    const form = document.getElementById('role-form');
    form.elements.providerId.innerHTML = providerOptions(role?.providerId);
    fillForm(form, role ? { ...role, reasoningEffort: role.reasoningEffort ?? 'default', streamResponse: role.streamResponse ?? true } : { id: '', name: '', model: 'deepseek-flash', reasoningEffort: 'default', streamResponse: true, maxTokens: 4096, timeoutSeconds: 300, system: '使用中文完成指定任务，明确给出依据和待验证的内容。' });
    document.getElementById('role-heading').textContent = role ? '编辑助手角色' : '添加助手角色';
    document.getElementById('role-model-picker').hidden = true;
    document.getElementById('model-picker-toggle').setAttribute('aria-expanded', 'false');
    updateModelOptions();
    updateRoleModelHint();
    document.getElementById('role-dialog').showModal();
  }
  function openCoordinator() {
    const coordinator = state.coordinator ?? {};
    const form = document.getElementById('coordinator-form');
    fillForm(form, { name: coordinator.name || '主 Agent', system: coordinator.system || '' });
    document.getElementById('coordinator-dialog').showModal();
  }
  function openTask(roleId) {
    if (!state.roles.length) return notify('请先添加助手角色。', true);
    const form = document.getElementById('task-form');
    form.elements.role_id.innerHTML = roleOptions();
    fillForm(form, roleId ? { role_id: roleId } : {});
    form.dataset.requestId = crypto.randomUUID();
    document.getElementById('task-dialog').showModal();
  }
  function confirmAction(message) {
    const dialog = document.getElementById('confirm-dialog');
    document.getElementById('confirm-message').textContent = message;
    return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); });
  }
  async function performAction(action, id, target) {
    switch (action) {
      case 'toggle-model-picker': {
        const picker = document.getElementById('role-model-picker');
        picker.hidden = !picker.hidden;
        target.setAttribute('aria-expanded', String(!picker.hidden));
        updateModelOptions();
        const providerId = document.getElementById('role-form').elements.providerId.value;
        if (!picker.hidden && !modelLoads.has(providerId)) loadModels(providerId).catch(() => {});
        return;
      }
      case 'refresh-models':
        await loadModels(document.getElementById('role-form').elements.providerId.value).catch(() => {});
        return;
      case 'choose-model': {
        const form = document.getElementById('role-form');
        form.elements.model.value = id;
        document.getElementById('role-model-picker').hidden = true;
        document.getElementById('model-picker-toggle').setAttribute('aria-expanded', 'false');
        updateRoleModelHint();
        form.elements.model.focus();
        return;
      }
      case 'new-provider': return openProvider();
      case 'edit-provider': return openProvider(id);
      case 'new-role': return openRole();
      case 'edit-role': return openRole(id);
      case 'edit-coordinator': return openCoordinator();
      case 'copy-coordinator':
        try {
          await navigator.clipboard.writeText(state.coordinator?.system ?? '');
          notify('主Agent职责已复制。');
        } catch {
          openCoordinator();
          const form = document.getElementById('coordinator-form');
          form.elements.system.focus();
          form.elements.system.select();
          notify('无法自动复制，已打开编辑窗口并选中职责文本，请按 Ctrl+C 复制。', true);
        }
        return;
      case 'new-task': return openTask();
      case 'role-task': return openTask(id);
      case 'delete-provider':
        if (await confirmAction('移除此模型服务及其保存的密钥？正在处理的任务继续使用提交时的配置。')) {
          await request('delete_provider', { id });
          modelLoads.delete(id);
          modelLists.delete(id);
          modelDetails.delete(id);
          providerTests.delete(id);
        }
        break;
      case 'delete-role':
        if (await confirmAction('移除此助手角色？已有任务记录会保留。')) await request('delete_role', { id });
        break;
      case 'test-provider':
        target.disabled = true;
        target.textContent = '正在测试…';
        try {
          const result = await loadModels(id);
          if (result) providerTests.set(id, { message: `连接成功，读取到 ${result.models.length} 个模型。` });
        } catch (error) { providerTests.set(id, { error: true, message: error.message }); }
        break;
      case 'select-task': selectedTaskId = id; selectedTask = await request('get_task', { id }); break;
      case 'cancel-task': await request('cancel_task', { id }); break;
      case 'retry-task':
        if (await confirmAction('重新提交此任务？模型调用可能产生新的费用。')) { selectedTask = await request('retry_task', { id }); selectedTaskId = selectedTask.id; }
        break;
      case 'copy-result':
        try { await navigator.clipboard.writeText(selectedTask.result); notify('结果已复制。'); }
        catch { notify('请在结果区域选择并复制文字。', true); }
        return;
    }
    await refresh();
  }
  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (tab) { activeTab = tab.dataset.tab; render(); return; }
    const close = event.target.closest('[data-close]');
    if (close) { document.getElementById(close.dataset.close).close(); return; }
    const action = event.target.closest('[data-action]');
    if (action) performAction(action.dataset.action, action.dataset.id, action).catch(error => notify(error.message, true));
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'concurrency') request('set_concurrency', { concurrency: Number(event.target.value) }).then(refresh).catch(error => notify(error.message, true));
    if (event.target.name === 'providerId') {
      updateModelOptions();
      updateRoleModelHint();
      if (!modelLoads.has(event.target.value)) loadModels(event.target.value).catch(() => {});
    }
    if (event.target.name === 'model') updateRoleModelHint();
  });
  document.addEventListener('input', event => { if (event.target.name === 'model') updateRoleModelHint(); });
  for (const [formId, operation] of [['provider-form', 'save_provider'], ['role-form', 'save_role'], ['coordinator-form', 'save_coordinator'], ['task-form', 'submit_task']]) {
    document.getElementById(formId).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      if (form.dataset.busy) return;
      form.dataset.busy = 'true';
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      form.querySelector('.form-error').textContent = '';
      try {
        const input = Object.fromEntries(new FormData(form));
        if (operation === 'save_provider') input.clearKey = form.elements.clearKey.checked;
        if (operation === 'save_role') { input.streamResponse = form.elements.streamResponse.checked; input.maxTokens = Number(input.maxTokens); input.timeoutSeconds = Number(input.timeoutSeconds); }
        if (operation === 'submit_task') input.request_id = form.dataset.requestId;
        const result = await request(operation, input);
        if (operation === 'save_provider') { form.elements.apiKey.value = ''; modelLists.delete(result.id); modelDetails.delete(result.id); modelLoads.delete(result.id); providerTests.delete(result.id); }
        if (operation === 'submit_task') { selectedTaskId = result.id; selectedTask = result; activeTab = 'tasks'; }
        form.closest('dialog').close();
        const customModel = operation === 'save_role' && modelLists.has(input.providerId) && !modelLists.get(input.providerId).includes(input.model.trim());
        notify(operation === 'submit_task' ? '任务已加入协作队列。' : customModel ? '设置已保存。该模型不在当前服务商列表中，将按原样发送。' : '设置已保存。');
        await refresh();
      } catch (error) { form.querySelector('.form-error').textContent = error.message; }
      finally { submit.disabled = false; delete form.dataset.busy; }
    });
  }
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => {
    if (dialog.id === 'provider-dialog') document.getElementById('provider-form').elements.apiKey.value = '';
    if (state) render();
  }));
  async function start() {
    try {
      if (embedded) {
        await hostRequest('ui/initialize', { appInfo: { name: 'model-team', version: '0.1.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' });
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      }
      await refresh();
      let pollTicks = 0;
      setInterval(() => {
        const busy = state?.jobs.some(job => !terminal.has(job.status));
        if (!document.hidden && (busy || ++pollTicks % 5 === 0)) refresh().catch(() => { connection.textContent = '连接暂时中断'; });
      }, 1000);
    } catch (error) {
      connection.textContent = '待连接';
      content.innerHTML = `<div class="card empty"><h2>面板暂时无法连接</h2><p>${escape(error.message)}</p><p>可以双击桌面的“多模型协作”重新打开本机面板。</p></div>`;
    }
  }
  start();
})();
