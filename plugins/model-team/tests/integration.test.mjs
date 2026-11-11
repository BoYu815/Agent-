import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(30);
  }
  throw new Error('Timed out waiting for local service');
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-team-integration-'));
  const children = [];
  const env = { ...process.env, MODEL_TEAM_DATA_DIR: directory, MODEL_TEAM_PORT: String(30000 + Math.floor(Math.random() * 15000)) };
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit');
        child.kill();
        await closed;
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function launch(filename) {
    const child = spawn(process.execPath, [path.join(root, 'src', filename)], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  }
  async function start() {
    const child = launch('daemon.mjs');
    const descriptor = await until(() => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(directory, 'service.json'), 'utf8'));
        return value.pid === child.pid && value;
      } catch { return null; }
    });
    async function rpc(operation, input = {}) {
      const response = await fetch(`${descriptor.origin}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-model-team-token': descriptor.token },
        body: JSON.stringify({ operation, input }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      return body.result;
    }
    return { child, descriptor, rpc };
  }
  return { directory, launch, start };
}

test('daemon verifies local access, encrypted persistence, API tasks, errors and restart', { timeout: 25000 }, async t => {
  const f = fixture(t);
  const fakeKey = 'integration-only-private-123';
  let completions = 0;
  let mode = 'success';
  const provider = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${fakeKey}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    completions++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, 'mock-model');
    if (mode === 'hold') return;
    if (mode === 'error') {
      response.statusCode = 429;
      return response.end(JSON.stringify({ error: { message: `Retry later ${fakeKey}` } }));
    }
    if (mode === 'redirect') {
      response.writeHead(302, { Location: '/v1/chat/completions' });
      return response.end('{}');
    }
    response.end(JSON.stringify({ choices: [{ message: { content: '中文协作结果 <script>unsafe()</script>' }, finish_reason: 'stop' }], usage: { total_tokens: 30 } }));
  });
  await new Promise(resolve => provider.listen(45000 + Math.floor(Math.random() * 10000), '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  let service = await f.start();
  const { origin, token } = service.descriptor;
  assert.equal((await fetch(`${origin}/health`)).status, 401);
  assert.equal((await fetch(`${origin}/health`, { headers: { 'x-model-team-token': token, Origin: 'https://unrelated.example' } })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    http.get(`${origin}/health`, { headers: { 'x-model-team-token': token, Host: 'unrelated.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  const page = await fetch(origin);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /模型接入/);
  const coordinator = { name: '验收用主Agent', system: '交给分析助手产出补丁，协调者应用并验证。' };
  assert.match((await service.rpc('get_coordinator')).name, /GPT/);
  assert.deepEqual(await service.rpc('save_coordinator', coordinator), coordinator);
  assert.deepEqual((await service.rpc('list_roles')).coordinator, coordinator);
  assert.equal((await service.rpc('get_state')).roles.length, 2);
  await assert.rejects(service.rpc('save_coordinator', { name: '空职责', system: '' }));
  assert.deepEqual(await service.rpc('get_coordinator'), coordinator);
  const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  await service.rpc('save_provider', { id: 'deepseek', name: '模拟模型', baseUrl, apiKey: fakeKey });
  assert.deepEqual((await service.rpc('test_provider', { id: 'deepseek' })).models, ['mock-model']);
  await service.rpc('save_role', { id: 'researcher', name: '分析助手', providerId: 'deepseek', model: 'mock-model', reasoningEffort: 'low', streamResponse: true });
  const submit = () => service.rpc('submit_task', { role_id: 'researcher', task: '检查中文流程' });
  const finish = id => until(async () => {
    const job = (await service.rpc('wait_tasks', { ids: [id], seconds: 1 })).tasks[0];
    return ['completed', 'failed', 'cancelled'].includes(job.status) && job;
  });
  const completed = await finish((await submit()).id);
  assert.equal(completed.status, 'completed');
  assert.match(completed.result, /中文协作结果/);
  assert.equal(completed.reasoningEffort, 'low');
  assert.equal('snapshot' in completed, false);
  mode = 'error';
  const failed = await finish((await submit()).id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /429/);
  assert.equal(failed.error.includes(fakeKey), false);
  mode = 'redirect';
  assert.equal((await finish((await submit()).id)).status, 'failed');
  assert.equal(completions, 3, 'failed calls must not automatically retry or follow redirects');
  mode = 'hold';
  const cancelled = await submit();
  await until(() => completions === 4);
  await service.rpc('cancel_task', { id: cancelled.id });
  assert.equal((await finish(cancelled.id)).status, 'cancelled');
  const interrupted = await submit();
  await until(() => completions === 5);
  const exited = once(service.child, 'exit');
  service.child.kill();
  await exited;
  service = await f.start();
  assert.deepEqual(await service.rpc('get_coordinator'), coordinator);
  assert.equal((await service.rpc('get_task', { id: interrupted.id })).status, 'interrupted');
  assert.equal((await service.rpc('get_task', { id: completed.id })).result, completed.result);
  assert.equal(completions, 5);
  assert.equal((await service.rpc('get_state')).providers[0].hasKey, true);
  assert.equal((await service.rpc('list_roles')).roles[0].reasoningEffort, 'low');
  for (const filename of ['config.json', 'tasks.json']) {
    assert.equal(fs.readFileSync(path.join(f.directory, filename), 'utf8').includes(fakeKey), false);
  }
  assert.equal(JSON.stringify(await service.rpc('get_state')).includes('encryptedKey'), false);
});

test('MCP negotiates, lists tools, serves Chinese UI and returns structured errors', { timeout: 15000 }, async t => {
  const f = fixture(t);
  await f.start();
  const child = f.launch('mcp.mjs');
  let buffer = '';
  const messages = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  let nextId = 0;
  async function call(method, params) {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return until(() => messages.find(message => message.id === id));
  }
  assert.equal((await call('initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  const tools = (await call('tools/list')).result.tools;
  assert.ok(tools.some(tool => tool.name === 'submit_task'));
  assert.ok(tools.some(tool => tool.name === 'wait_tasks'));
  assert.deepEqual(tools.find(tool => tool.name === 'submit_task').inputSchema.properties.reasoning_effort.enum, ['default', 'low', 'high', 'max']);
  assert.equal(tools.find(tool => tool.name === 'get_coordinator').annotations.readOnlyHint, true);
  assert.deepEqual(tools.find(tool => tool.name === 'save_coordinator')._meta.ui.visibility, ['app']);
  assert.deepEqual(tools.find(tool => tool.name === 'save_provider')._meta.ui.visibility, ['app']);
  const roles = (await call('tools/call', { name: 'list_roles' })).result;
  assert.equal(roles.structuredContent.roles.length, 2);
  assert.equal(roles.structuredContent.providers[0].hasKey, false);
  const coordinator = (await call('tools/call', { name: 'get_coordinator' })).result;
  assert.match(coordinator.structuredContent.name, /GPT/);
  assert.deepEqual(roles.structuredContent.coordinator, coordinator.structuredContent);
  const resource = (await call('resources/read', { uri: 'ui://model-team/control-panel' })).result;
  assert.match(resource.contents[0].text, /助手角色/);
  const error = (await call('tools/call', { name: 'submit_task', arguments: { role_id: 'researcher', task: '还没配置密钥' } })).result;
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /API 密钥/);
  assert.equal((await call('unknown')).error.code, -32601);
  child.stdin.write('invalid json\n');
  await until(() => messages.some(message => message.error?.code === -32700));
});
