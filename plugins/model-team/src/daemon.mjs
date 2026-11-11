import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from './store.mjs';
import { TaskQueue } from './tasks.mjs';
import { listModels } from './provider.mjs';
import { PRODUCT, DEFAULT_PORT, dataDirectory, writeJson, redact, COLLABORATION_WORKFLOW } from './common.mjs';
import { renderUi } from './ui.mjs';

const directory = dataDirectory();
fs.mkdirSync(directory, { recursive: true });
const descriptorPath = path.join(directory, 'service.json');
const token = crypto.randomBytes(32).toString('hex');
let store;
let queue;
let origin;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512000) throw new Error('请求内容超过 500 KB。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求格式错误。'); }
}
async function dispatch(operation, input = {}) {
  switch (operation) {
    case 'get_state': return store.publicState();
    case 'get_coordinator': return store.getCoordinator();
    case 'save_coordinator': return store.saveCoordinator(input);
    case 'list_roles': return { roles: store.publicState().roles, providers: store.publicState().providers, coordinator: store.getCoordinator(), workflow: COLLABORATION_WORKFLOW };
    case 'save_provider': return store.saveProvider(input);
    case 'delete_provider': return store.deleteProvider(input.id);
    case 'save_role': return store.saveRole(input);
    case 'delete_role': return store.deleteRole(input.id);
    case 'set_concurrency': { const result = store.setConcurrency(input.concurrency); queue.pump(); return result; }
    case 'test_provider': {
      const provider = store.config.providers.find(item => item.id === input.id);
      if (!provider?.encryptedKey) throw new Error('请先保存 API 密钥。');
      const key = await store.vault.unseal(provider.encryptedKey);
      try { return await listModels(provider, key); } catch (error) { throw new Error(redact(error.message, [key])); }
    }
    case 'submit_task': return queue.submit(input);
    case 'wait_tasks': return queue.wait(input.ids, Math.min(25, Math.max(1, Number(input.seconds) || 25)) * 1000);
    case 'get_task': {
      const job = store.jobs.find(item => item.id === input.id);
      if (!job) throw new Error('任务不存在。');
      return store.publicJob(job);
    }
    case 'list_tasks': return { tasks: store.jobs.slice(-Math.min(Number(input.limit) || 30, 150)).reverse().map(job => store.summary(job)) };
    case 'cancel_task': return queue.cancel(input.id);
    case 'retry_task': return queue.retry(input.id);
    default: throw new Error('未知操作。');
  }
}
const server = http.createServer(async (request, response) => {
  try {
    if (!origin || !store) return json(response, 503, { error: '本地服务正在启动。' });
    const host = new URL(origin).host;
    if (request.headers.host !== host) return json(response, 403, { error: '主机地址不匹配。' });
    if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: '仅接受本机配置面板的请求。' });
    const url = new URL(request.url, origin);
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" });
      return response.end(renderUi());
    }
    if (request.headers['x-model-team-token'] !== token) return json(response, 401, { error: '面板连接已失效，请通过“打开协作面板”重新打开。' });
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { product: PRODUCT, version: '0.1.0', pid: process.pid });
    if (request.method !== 'POST' || url.pathname !== '/rpc') return json(response, 404, { error: '接口不存在。' });
    if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '需要 JSON 格式。' });
    const { operation, input } = await readBody(request);
    const result = await dispatch(operation, input);
    json(response, 200, { result });
  } catch (error) { if (!response.headersSent) json(response, 400, { error: redact(error.message) }); else response.end(); }
});
server.requestTimeout = 35000;
server.headersTimeout = 10000;
server.listen(Number(process.env.MODEL_TEAM_PORT ?? DEFAULT_PORT), '127.0.0.1', () => {
  try {
    origin = `http://127.0.0.1:${server.address().port}`;
    store = new Store(directory);
    queue = new TaskQueue(store);
    writeJson(descriptorPath, { product: PRODUCT, pid: process.pid, origin, token });
    queue.pump();
  } catch { server.close(); process.exitCode = 1; }
});
server.on('error', () => { process.exitCode = 1; });
function shutdown() {
  queue?.stop();
  server.close();
  try {
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    if (descriptor.token === token) fs.unlinkSync(descriptorPath);
  } catch {}
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
