import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('embedded role notifications preserve task state and update the coordinator', () => {
  const nodes = new Map();
  const listeners = new Map();
  const host = { postMessage() {} };
  const window = { parent: host, addEventListener: (name, handler) => listeners.set(name, handler) };
  const document = {
    body: { scrollHeight: 700 },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', addEventListener() {} });
      return nodes.get(id);
    },
    addEventListener: (name, handler) => listeners.set(name, handler),
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), {
    window, document, location: { hash: '' }, URLSearchParams,
    setTimeout: () => 0, clearTimeout() {},
  });
  const notify = structuredContent => listeners.get('message')({ source: host, data: {
    jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent },
  } });
  const navigate = tab => listeners.get('click')({ target: {
    closest: selector => selector === '[data-tab]' ? { dataset: { tab } } : null,
  } });
  notify({ providers: [], roles: [], coordinator: { name: '主Agent', system: '原职责' }, jobs: [
    { id: 'saved-job', status: 'completed', task: '保留的任务', roleName: '助手', model: 'example', createdAt: '2026-11-11T00:00:00Z' },
  ] });
  notify({ providers: [], roles: [], coordinator: { name: '新主Agent', system: '新职责' } });
  navigate('roles');
  assert.match(nodes.get('content').innerHTML, /新主Agent/);
  navigate('tasks');
  assert.match(nodes.get('content').innerHTML, /保留的任务/);
});
