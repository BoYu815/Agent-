import readline from 'node:readline';
import { rpc, controlPanelUrl } from './client.mjs';
import { renderUi } from './ui.mjs';
import { redact, COLLABORATION_WORKFLOW } from './common.mjs';

const resourceUri = 'ui://model-team/control-panel';
const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const string = description => ({ type: 'string', description });
const appOnly = { ui: { visibility: ['app'] } };
const effortSchema = { type: 'string', enum: ['default', 'low', 'high', 'max'], description: '推理等级。范围明确的任务用low，复杂推导和关键审查用high，省略时沿用角色设置。' };
const tools = [
  { name: 'open_control_panel', title: '打开多模型协作面板', description: '打开中文模型协作面板，配置 DeepSeek 或兼容服务、Windows 加密密钥、助手角色及任务。当前 GPT 负责协调，外部模型助手提供分析与代码建议。', inputSchema: objectSchema({}), _meta: { ui: { resourceUri }, 'openai/outputTemplate': resourceUri, 'openai/ui': { entrypoints: [{ type: 'thread' }] } }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'list_roles', title: '查看助手角色', description: '列出主Agent及配置的外部模型助手和服务。查看 provider.hasKey 判断密钥是否已配置，密钥正文始终保留在本机。', inputSchema: objectSchema({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_coordinator', title: '读取主Agent职责', description: '读取当前 GPT 主Agent的名称和职责。职责供 GPT 按当前任务读取和应用，执行模型与权限由聊天环境管理。', inputSchema: objectSchema({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'submit_task', title: '分配外部模型任务', description: '分配用户授权的明确子任务，可按复杂度指定reasoning_effort。提供必要材料、准确接口和验收条件，并移除密钥及无关个人信息。独立任务同时提交，用wait_tasks收取先完成的结果。使用稳定request_id防止重复提交。助手交付由主Agent应用并运行相关测试。', inputSchema: { ...objectSchema({ role_id: string('list_roles 返回的角色编号'), task: string('明确任务、输出要求与验收条件'), context: string('完成此任务所需的参考材料，仅包含用户授权分享的内容'), reasoning_effort: effortSchema, request_id: string('可选的幂等请求编号，同一任务重试时保持一致') }), required: ['role_id', 'task'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'get_task', title: '读取助手任务', description: '按编号读取外部助手任务的状态、输出、错误、模型与用量。completed 表示已返回结果，truncated 为 true 表示输出达到词元上限。', inputSchema: { ...objectSchema({ id: string('任务编号') }), required: ['id'] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'wait_task', title: '等待助手结果', description: '等待外部助手任务完成或到达等待上限，返回最新状态。queued、running、cancelling 表示仍未结束。', inputSchema: { ...objectSchema({ id: string('任务编号'), seconds: { type: 'integer', minimum: 1, maximum: 60, default: 30 } }), required: ['id'] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'wait_tasks', title: '收取先完成的任务', description: '同时等待多个已提交任务，任一任务结束立即返回所有指定任务的最新状态与结果。先处理已完成结果，后续只传入仍在运行的编号。省去逐个等待与反复查询。', inputSchema: { ...objectSchema({ ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, uniqueItems: true }, seconds: { type: 'integer', minimum: 1, maximum: 60, default: 30 } }), required: ['ids'] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'list_tasks', title: '查看协作任务记录', description: '列出本机最近的外部模型协作任务。', inputSchema: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 150, default: 30 } }), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'cancel_task', title: '取消助手任务', description: '取消排队或运行中的指定任务。已经发送给模型的请求可能已产生服务商费用。', inputSchema: { ...objectSchema({ id: string('任务编号') }), required: ['id'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'get_state', description: '读取面板状态。', inputSchema: objectSchema({}), _meta: appOnly },
  { name: 'save_provider', description: '保存模型服务。API 密钥仅从配置面板输入，并使用 Windows 当前用户加密。', inputSchema: { type: 'object', properties: { id: string('服务编号'), name: string('名称'), baseUrl: string('接口地址'), apiKey: string('新密钥，留空保留现有密钥'), clearKey: { type: 'boolean' } }, required: ['name', 'baseUrl'], additionalProperties: false }, _meta: appOnly },
  { name: 'delete_provider', description: '移除未被角色使用的模型服务。', inputSchema: { ...objectSchema({ id: string('服务编号') }), required: ['id'] }, _meta: appOnly },
  { name: 'test_provider', description: '通过模型列表接口测试已保存服务的连接。', inputSchema: { ...objectSchema({ id: string('服务编号') }), required: ['id'] }, _meta: appOnly },
  { name: 'save_role', description: '保存外部助手角色及模型设置。', inputSchema: { type: 'object', properties: { id: string('角色编号'), name: string('角色名称'), providerId: string('服务编号'), model: string('模型名称'), reasoningEffort: effortSchema, streamResponse: { type: 'boolean', description: '流式显示生成进度，服务不支持流式时可以关闭。' }, system: string('职责'), maxTokens: { type: 'integer', minimum: 64, maximum: 65536 }, timeoutSeconds: { type: 'integer', minimum: 10, maximum: 600 } }, required: ['name', 'providerId', 'model'], additionalProperties: false }, _meta: appOnly },
  { name: 'save_coordinator', description: '在配置面板中保存当前 GPT 主Agent的名称和职责。名称必填且最多 80 字符，职责必填且最多 20000 字符。该偏好供 GPT 读取，执行模型与权限由聊天环境管理。', inputSchema: { type: 'object', properties: { name: string('主Agent名称'), system: string('主Agent职责') }, required: ['name', 'system'], additionalProperties: false }, _meta: appOnly },
  { name: 'delete_role', description: '移除助手角色。', inputSchema: { ...objectSchema({ id: string('角色编号') }), required: ['id'] }, _meta: appOnly },
  { name: 'set_concurrency', description: '设置外部助手并发数量。', inputSchema: { ...objectSchema({ concurrency: { type: 'integer', minimum: 1, maximum: 4 } }), required: ['concurrency'] }, _meta: appOnly },
  { name: 'retry_task', description: '手动重新提交失败、取消或中断的任务，可能产生新的费用。', inputSchema: { ...objectSchema({ id: string('任务编号') }), required: ['id'] }, _meta: appOnly },
];
async function callTool(name, input) {
  if (!tools.some(tool => tool.name === name)) throw new Error('工具不存在。');
  if (name === 'open_control_panel') {
    const url = await controlPanelUrl();
    return { content: [{ type: 'text', text: `多模型协作面板已准备好。也可在本机浏览器打开 ${url}` }], structuredContent: await rpc('get_state') };
  }
  let result;
  if (name === 'wait_task' || name === 'wait_tasks') {
    const seconds = Math.min(60, Math.max(1, Number(input.seconds) || 30));
    const deadline = Date.now() + seconds * 1000;
    do {
      const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      result = await rpc('wait_tasks', { ids: name === 'wait_task' ? [input.id] : input.ids, seconds: Math.min(25, remaining) });
      if (result.tasks.some(job => !['queued', 'running', 'cancelling'].includes(job.status)) || Date.now() >= deadline) break;
    } while (true);
    if (name === 'wait_task') result = result.tasks[0];
  } else result = await rpc(name, input);
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}
async function handle(message) {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
    return send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
  }
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  let result;
  try {
    switch (method) {
      case 'initialize': result = { protocolVersion: params.protocolVersion ?? '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'model-team', version: '0.1.0' }, instructions: '需要协作时调用list_roles，一次取得角色、主Agent职责和工作流。主Agent职责作为协作偏好，执行遵循用户要求与当前环境设置。' + COLLABORATION_WORKFLOW }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call':
        try { result = await callTool(params.name, params.arguments ?? {}); }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: redact(error.message) }] }; }
        break;
      case 'resources/list': result = { resources: [{ uri: resourceUri, name: '多模型协作面板', mimeType: 'text/html;profile=mcp-app' }] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'resources/read':
        if (params.uri !== resourceUri) throw new Error('资源不存在。');
        result = { contents: [{ uri: resourceUri, mimeType: 'text/html;profile=mcp-app', text: renderUi(), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] };
        break;
      default: return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (error) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: redact(error.message) } }); }
}
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (line.length > 1000000) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
  try { handle(JSON.parse(line)).catch(() => {}); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); }
});
