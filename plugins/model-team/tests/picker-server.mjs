// Isolated UI fixture. All roles, models and task responses stay in memory.
import http from 'node:http';
import crypto from 'node:crypto';
import { renderUi } from '../src/ui.mjs';

const state = {
  concurrency: 2,
  coordinator: { name: 'GPT 主Agent', system: '根据当前任务准备必要材料，让 DeepSeek 交付补丁，应用修改并运行验证。' },
  providers: [
    { id: 'deepseek', name: 'DeepSeek 官方（界面测试）', baseUrl: 'https://api.deepseek.com/v1', hasKey: true },
    { id: 'failure', name: '故障与恢复测试服务', baseUrl: 'http://127.0.0.1', hasKey: true },
  ],
  roles: [{ id: 'fixture-role', name: '模型选择器验收助手', providerId: 'deepseek', model: 'deepseek-flash', system: '仅用于本机界面验收。', maxTokens: 16384, timeoutSeconds: 300 }],
  jobs: [],
};
const details = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, maxOutputTokens: 393216, inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576, maxOutputTokens: 393216, inputModalities: ['text'] },
];
let failedOnce = false;
const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(renderUi());
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { operation, input = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let result;
    switch (operation) {
      case 'get_state': result = state; break;
      case 'get_coordinator': result = state.coordinator; break;
      case 'save_coordinator':
        state.coordinator = { name: input.name.trim(), system: input.system.trim() };
        result = state.coordinator;
        break;
      case 'test_provider':
        await new Promise(resolve => setTimeout(resolve, 300));
        if (input.id === 'failure' && !failedOnce) {
          failedOnce = true;
          throw new Error('模拟网络异常，请重试。');
        }
        result = { ok: true, models: details.map(item => item.id), details };
        break;
      case 'save_role': {
        const role = { ...input, id: input.id || crypto.randomUUID() };
        const index = state.roles.findIndex(item => item.id === role.id);
        if (index < 0) state.roles.push(role);
        else state.roles[index] = role;
        result = role;
        break;
      }
      case 'submit_task': {
        const role = state.roles.find(item => item.id === input.role_id);
        result = { id: crypto.randomUUID(), roleId: role.id, roleName: role.name, providerName: '本机模拟服务', model: role.model, task: input.task, context: input.context, status: 'completed', createdAt: new Date().toISOString(), result: '本机模拟调用已完成。', responseModel: role.model };
        state.jobs.unshift(result);
        break;
      }
      case 'get_task': result = state.jobs.find(item => item.id === input.id); break;
      default: throw new Error('Unsupported fixture operation');
    }
    response.end(JSON.stringify({ result }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(17864, '127.0.0.1', () => console.log('模型选择器隔离验收服务 http://127.0.0.1:17864/#token=fixture'));
