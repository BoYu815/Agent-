import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../src/store.mjs';
import { TaskQueue } from '../src/tasks.mjs';
import { normalizeBaseUrl, redact } from '../src/common.mjs';
import { seal, unseal } from '../src/vault.mjs';
import { complete, listModels } from '../src/provider.mjs';

const vault = { seal: async value => Buffer.from(value).toString('base64'), unseal: async value => Buffer.from(value, 'base64').toString() };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(condition) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error('Condition did not become true');
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-team-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new Store(directory, vault);
}
async function configure(store) {
  await store.saveProvider({ id: 'deepseek', name: '测试服务', baseUrl: 'http://127.0.0.1:3000/v1', apiKey: 'test-private-value-123' });
}
test('normalizes model URLs and rejects credentials and insecure remote URLs', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
  for (const url of ['http://remote.example/v1', 'https://user:password@host/v1', 'https://host/v1?key=secret', 'file:///tmp/a']) assert.throws(() => normalizeBaseUrl(url));
});
test('saves config, keeps blank keys and never exposes ciphertext in public state', async t => {
  const store = fixture(t);
  await configure(store);
  await store.saveProvider({ id: 'deepseek', name: '改名', baseUrl: 'http://127.0.0.1:3000/v1', apiKey: '' });
  const state = store.publicState();
  assert.equal(state.providers[0].hasKey, true);
  assert.equal('encryptedKey' in state.providers[0], false);
  assert.equal(await vault.unseal(store.config.providers[0].encryptedKey), 'test-private-value-123');
  await assert.rejects(store.saveProvider({ id: 'deepseek', name: '改地址', baseUrl: 'https://other.example/v1' }));
  assert.throws(() => store.setConcurrency(9));
  assert.equal(store.config.concurrency, 2);
  assert.throws(() => store.deleteProvider('deepseek'));
  const restored = new Store(store.directory, vault);
  assert.equal(restored.publicState().providers[0].name, '改名');
});
test('Windows vault performs a current-user encrypted round trip', { skip: process.platform !== 'win32' }, async () => {
  const sample = 'unit-test-only-key-清晰-123';
  const encrypted = await seal(sample);
  assert.notEqual(encrypted, sample);
  assert.equal(encrypted.includes(sample), false);
  assert.equal(await unseal(encrypted), sample);
});
test('task queue enforces concurrency, deduplicates submission and keeps full output', async t => {
  const store = fixture(t);
  await configure(store);
  let running = 0;
  let maximum = 0;
  let calls = 0;
  const queue = new TaskQueue(store, async () => {
    calls++;
    running++;
    maximum = Math.max(maximum, running);
    await delay(50);
    running--;
    return { result: '结果'.repeat(2000), usage: { total_tokens: 10 } };
  });
  const first = queue.submit({ role_id: 'researcher', task: '任务一', request_id: 'once' });
  assert.equal(queue.submit({ role_id: 'researcher', task: '任务一', request_id: 'once' }).id, first.id);
  assert.throws(() => queue.submit({ role_id: 'researcher', task: '其他任务', request_id: 'once' }));
  for (let index = 0; index < 4; index++) queue.submit({ role_id: 'reviewer', task: `任务 ${index}` });
  await waitFor(() => store.jobs.every(job => job.status === 'completed'));
  assert.equal(calls, 5);
  assert.equal(maximum, 2);
  assert.equal(store.jobs[0].result.length, 4000);
  assert.equal(store.jobs[0].snapshot, null);
  assert.equal('result' in store.publicState().jobs[0], false);
});
test('cancels queued and running tasks without starting cancelled work', async t => {
  const store = fixture(t);
  await configure(store);
  store.setConcurrency(1);
  let calls = 0;
  const queue = new TaskQueue(store, async (_snapshot, _key, _task, _context, signal) => {
    calls++;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const first = queue.submit({ role_id: 'researcher', task: '等待取消' });
  const second = queue.submit({ role_id: 'researcher', task: '排队取消' });
  await waitFor(() => calls === 1);
  queue.cancel(second.id);
  queue.cancel(first.id);
  await waitFor(() => store.jobs.every(job => job.status === 'cancelled'));
  assert.equal(calls, 1);
  assert.equal(store.jobs.every(job => job.snapshot === null), true);
});
test('retries manually with a new ID and recovers interrupted work without resending', async t => {
  const store = fixture(t);
  await configure(store);
  const queue = new TaskQueue(store, async () => { throw new Error('Request failed with test-private-value-123'); });
  const job = queue.submit({ role_id: 'reviewer', task: '失败任务' });
  await waitFor(() => store.jobs[0].status === 'failed');
  assert.equal(store.jobs[0].error.includes('test-private-value-123'), false);
  const retried = queue.retry(job.id);
  assert.notEqual(retried.id, job.id);
  await waitFor(() => store.jobs[1].status === 'failed');
  const snapshot = store.snapshotRole('reviewer');
  store.addJob({ id: 'crashed', status: 'running', task: '已发送的任务', snapshot });
  const recovered = new Store(store.directory, vault);
  assert.equal(recovered.jobs.at(-1).status, 'interrupted');
  assert.equal(recovered.jobs.at(-1).snapshot, null);
});
test('provider calls use selected model and preserve large outputs while hiding API keys', async t => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: '输出'.repeat(2000) }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: 30 } }));
  });
  await new Promise(resolve => server.listen(45000 + Math.floor(Math.random() * 10000), '127.0.0.1', resolve));
  t.after(() => server.close());
  const provider = { baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  assert.deepEqual((await listModels(provider, 'test-key')).models, ['mock-model']);
  const result = await complete({ provider, role: { model: 'mock-model', maxTokens: 1000, system: '检查材料' } }, 'test-key', '分析任务', '参考内容', AbortSignal.timeout(5000));
  assert.equal(requests[0].auth, 'Bearer test-key');
  assert.equal(requests[0].body.model, 'mock-model');
  assert.match(requests[0].body.messages[1].content, /参考内容/);
  assert.equal(result.result.length, 4000);
  assert.equal(result.truncated, true);
  assert.equal(redact('token sk-1234567890'), 'token [密钥已隐藏]');
});

test('role reasoning persists, legacy saves preserve it, and task overrides stay isolated', async t => {
  const store = fixture(t);
  await configure(store);
  const original = store.config.roles[0];
  const role = store.saveRole({ ...original, reasoningEffort: 'low', streamResponse: false });
  const { reasoningEffort, streamResponse, ...legacyInput } = role;
  assert.equal(store.saveRole(legacyInput).reasoningEffort, 'low');
  assert.equal(store.config.roles[0].streamResponse, false);
  assert.throws(() => store.saveRole({ ...role, reasoningEffort: 'unknown' }));
  const received = [];
  const queue = new TaskQueue(store, async snapshot => {
    received.push(snapshot.role.reasoningEffort);
    return { result: '已验证结果' };
  });
  const job = queue.submit({ role_id: role.id, task: '复杂任务', reasoning_effort: 'high', request_id: 'complex-once' });
  assert.equal(queue.submit({ role_id: role.id, task: '复杂任务', reasoning_effort: 'high', request_id: 'complex-once' }).id, job.id);
  assert.throws(() => queue.submit({ role_id: role.id, task: '复杂任务', reasoning_effort: 'low', request_id: 'complex-once' }));
  queue.submit({ role_id: role.id, task: '普通任务' });
  await waitFor(() => store.jobs.every(item => item.status === 'completed'));
  assert.deepEqual(received, ['high', 'low']);
  assert.equal(new Store(store.directory, vault).config.roles[0].reasoningEffort, 'low');
});

test('wait collects the first completed independent task and cleans up listeners', async t => {
  const store = fixture(t);
  await configure(store);
  const finishers = new Map();
  const queue = new TaskQueue(store, async (_snapshot, _key, task, _context, _signal, progress) => {
    progress({ stage: 'writing', partialResult: '部分正文', outputCharacters: 4 });
    return new Promise(resolve => finishers.set(task, () => resolve({ result: task + '完成' })));
  });
  const slow = queue.submit({ role_id: 'researcher', task: '慢任务' });
  const fast = queue.submit({ role_id: 'reviewer', task: '快任务' });
  await waitFor(() => finishers.size === 2);
  assert.equal(store.jobs[0].partialResult, '部分正文');
  assert.equal('partialResult' in store.publicState().jobs[0], false);
  const waiting = queue.wait([slow.id, fast.id], 2000);
  finishers.get('快任务')();
  const result = await waiting;
  assert.deepEqual(result.tasks.map(job => job.status), ['running', 'completed']);
  assert.equal(queue.listenerCount('settled'), 0);
  finishers.get('慢任务')();
  await queue.wait([slow.id], 2000);
  assert.equal(store.jobs[0].partialResult, null);
  assert.equal(queue.listenerCount('settled'), 0);
  assert.throws(() => queue.wait(['missing'], 1));
});

test('streaming sends reasoning settings, exposes partial output, and assembles split UTF-8 events', async t => {
  const key = 'test-stream-secret';
  const received = [];
  const progress = [];
  let finishResponse;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = data => response.write('data: ' + JSON.stringify(data) + '\r\n\r\n');
    send({ model: 'stream-model', choices: [{ delta: { reasoning_content: '私有推理内容' } }] });
    await delay(550);
    const event = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: '中文结果🙂 ' + key + ' 后续结果'.repeat(15) } }] }) + '\r\n\r\n');
    for (let offset = 0; offset < event.length; offset += 7) response.write(event.subarray(offset, offset + 7));
    finishResponse = () => {
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 30 } });
      response.end('data: [DONE]\n\n');
    };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  let completed = false;
  const pending = complete({ provider: { baseUrl: `http://127.0.0.1:${server.address().port}` },
    role: { model: 'stream-model', maxTokens: 65536, reasoningEffort: 'high' } }, key, '任务', '', AbortSignal.timeout(5000), value => progress.push(value))
    .then(value => { completed = true; return value; });
  await waitFor(() => progress.some(value => value.stage === 'writing'));
  assert.equal(completed, false, 'partial output must be observable before the response finishes');
  assert.equal(received[0].reasoning_effort, 'high');
  assert.equal(received[0].stream, true);
  assert.equal(JSON.stringify(progress).includes(key), false);
  assert.equal(JSON.stringify(progress).includes('私有推理内容'), false);
  assert.ok(progress.some(value => value.thinkingCharacters > 0));
  finishResponse();
  const result = await pending;
  assert.match(result.result, /中文结果🙂/);
  assert.equal(result.result.includes(key), false);
  assert.equal(result.responseModel, 'stream-model');
  assert.equal(result.usage.completion_tokens, 30);
});

test('interrupted streams fail while retaining redacted partial output', async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '推理' } }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '尚未完成的部分正文'.repeat(10) } }] }) + '\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const progress = [];
  await assert.rejects(complete({ provider: { baseUrl: `http://127.0.0.1:${server.address().port}` },
    role: { model: 'mock', maxTokens: 4096 } }, 'test-key', '任务', '', AbortSignal.timeout(2000), value => progress.push(value)), /完成前中断/);
  assert.ok(progress.at(-1).partialResult.length > 0);
});

test('cancelling tasks count toward the active task limit', async t => {
  const store = fixture(t);
  await configure(store);
  const queue = new TaskQueue(store);
  store.jobs = Array.from({ length: 50 }, (_, index) => ({ id: String(index), status: index ? 'queued' : 'cancelling', task: '占位任务' }));
  assert.throws(() => queue.submit({ role_id: 'researcher', task: '第51个活动任务' }), /已达 50/);
  assert.equal(store.jobs.length, 50);
});

test('empty budget-limited responses preserve usage and explain the recovery options', async t => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: 'budget-model', choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens: 20000, completion_tokens_details: { reasoning_tokens: 20000 } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const store = fixture(t);
  await store.saveProvider({ id: 'deepseek', name: '模拟服务', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-budget-key' });
  const queue = new TaskQueue(store);
  const job = queue.submit({ role_id: 'reviewer', task: '模拟预算耗尽' });
  await waitFor(() => store.jobs.find(item => item.id === job.id).status === 'failed');
  const failed = store.jobs.find(item => item.id === job.id);
  assert.equal(failed.truncated, true);
  assert.equal(failed.finishReason, 'length');
  assert.equal(failed.usage.completion_tokens, 20000);
  assert.match(failed.error, /缩小任务范围/);
  assert.equal(failed.responseModel, 'budget-model');
});
