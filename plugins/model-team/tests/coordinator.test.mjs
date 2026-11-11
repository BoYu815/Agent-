import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';

const vault = { seal: async () => 'sealed', unseal: async () => 'key' };

function baseConfig() {
  return {
    version: 1,
    concurrency: 2,
    providers: [{ id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', encryptedKey: '' }],
    roles: [
      { id: 'researcher', name: '分析助手', providerId: 'deepseek', model: 'deepseek-flash', maxTokens: 4096, timeoutSeconds: 300, system: '旧职责' },
    ],
  };
}

function createStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-team-coordinator-'));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(baseConfig()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new Store(directory, vault) };
}

test('旧配置缺少 coordinator 时读取默认主Agent', t => {
  const { store } = createStore(t);
  const state = store.publicState();
  assert.equal(state.coordinator.name, 'GPT 主Agent');
  assert.match(state.coordinator.system, /DeepSeek/);
  assert.match(state.coordinator.system, /复杂推导.*high/);
  assert.match(state.coordinator.system, /wait_tasks/);
  assert.deepEqual(state.roles, baseConfig().roles);
});

test('保存主Agent后重新加载仍保留', t => {
  const { directory, store } = createStore(t);
  const coordinator = { name: '自定义主Agent', system: '自定义职责' };
  assert.deepEqual(store.saveCoordinator(coordinator), coordinator);
  const reloaded = new Store(directory, vault);
  assert.deepEqual(reloaded.getCoordinator(), coordinator);
  assert.deepEqual(reloaded.publicState().coordinator, coordinator);
});

test('非法主Agent输入不改变状态', t => {
  const { store } = createStore(t);
  const before = store.publicState().coordinator;
  assert.throws(() => store.saveCoordinator({ name: 'x'.repeat(81), system: '有效职责' }));
  assert.deepEqual(store.publicState().coordinator, before);
  assert.throws(() => store.saveCoordinator({ name: '有效名称', system: '' }));
  assert.deepEqual(store.publicState().coordinator, before);
  assert.throws(() => store.saveCoordinator({ name: '有效名称' }));
  assert.deepEqual(store.publicState().coordinator, before);
});

test('主Agent与外部角色数组分离', t => {
  const { store } = createStore(t);
  const beforeRoles = JSON.parse(JSON.stringify(store.publicState().roles));
  store.saveCoordinator({ name: '新主Agent', system: '新职责' });
  assert.deepEqual(store.publicState().roles, beforeRoles);
  assert.ok(!store.publicState().roles.some(role => role.name === '新主Agent'));
});

test('部分主Agent配置按字段读取默认职责', t => {
  const { store } = createStore(t);
  const fallback = store.getCoordinator();
  for (const value of [null, [], {}, { name: '自定义主Agent' }, { name: '', system: '   ' }]) {
    store.config.coordinator = value;
    assert.equal(store.getCoordinator().system, fallback.system);
  }
  store.config.coordinator = { name: '自定义主Agent' };
  assert.equal(store.getCoordinator().name, '自定义主Agent');
});
