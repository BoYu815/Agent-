import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson, text, integer, normalizeBaseUrl, reasoningEffort, COLLABORATION_WORKFLOW } from './common.mjs';
import { seal, unseal } from './vault.mjs';

const defaultCoordinator = () => ({
  name: 'GPT 主Agent',
  system: '你是当前 GPT 主Agent，负责明确目标、协调 DeepSeek 子助手、执行修改与测试并汇总交付。' + COLLABORATION_WORKFLOW,
});

const defaultState = () => ({
  version: 1,
  concurrency: 2,
  coordinator: defaultCoordinator(),
  providers: [{ id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', encryptedKey: '' }],
  roles: [
    { id: 'researcher', name: '分析助手', providerId: 'deepseek', model: 'deepseek-flash', maxTokens: 4096, timeoutSeconds: 300, system: '你是分析助手。根据提供的材料完成任务。使用中文，区分事实与推测，指出证据和缺失信息。' },
    { id: 'reviewer', name: '审查助手', providerId: 'deepseek', model: 'deepseek-flash', maxTokens: 4096, timeoutSeconds: 300, system: '你是独立审查助手。检查提供的方案或代码，优先指出具体缺陷和修复建议。用中文汇总，并标明尚未验证的结论。' },
  ],
});
export class Store {
  constructor(directory, vault = { seal, unseal }) {
    this.directory = directory;
    this.vault = vault;
    fs.mkdirSync(directory, { recursive: true });
    this.statePath = path.join(directory, 'config.json');
    this.jobsPath = path.join(directory, 'tasks.json');
    this.config = readJson(this.statePath, defaultState());
    this.jobs = readJson(this.jobsPath, []);
    if (this.config.version !== 1 || !Array.isArray(this.config.providers) || !Array.isArray(this.config.roles) || !Array.isArray(this.jobs)) throw new Error('配置版本或格式不兼容，请保留数据后检查。');
    this.jobs = this.jobs.map(job => ['running', 'cancelling'].includes(job.status) ? { ...job, status: 'interrupted', snapshot: null, error: '服务在任务运行时退出。请确认后手动重试，避免重复调用。', finishedAt: new Date().toISOString() } : job);
    writeJson(this.jobsPath, this.jobs);
  }
  saveConfig(config) { writeJson(this.statePath, config); this.config = config; }
  saveJobs(jobs) { writeJson(this.jobsPath, jobs); this.jobs = jobs; }
  getCoordinator() {
    const saved = this.config.coordinator;
    const fallback = defaultCoordinator();
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return fallback;
    return {
      name: typeof saved.name === 'string' && saved.name.trim() ? saved.name : fallback.name,
      system: typeof saved.system === 'string' && saved.system.trim() ? saved.system : fallback.system,
    };
  }
  publicState() {
    return {
      concurrency: this.config.concurrency,
      workflow: COLLABORATION_WORKFLOW,
      coordinator: this.getCoordinator(),
      providers: this.config.providers.map(({ encryptedKey, ...provider }) => ({ ...provider, hasKey: Boolean(encryptedKey) })),
      roles: this.config.roles,
      jobs: this.jobs.slice(-150).reverse().map(job => this.summary(job)),
    };
  }
  publicJob({ snapshot, ...job }) { return job; }
  summary(job) {
    const { context, result, partialResult, ...summary } = this.publicJob(job);
    return { ...summary, task: summary.task.slice(0, 400) };
  }
  async saveProvider(input) {
    const existing = this.config.providers.find(provider => provider.id === input.id);
    const id = existing?.id ?? crypto.randomUUID();
    const name = text(input.name, '服务名称', 80);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const apiKey = input.apiKey == null ? '' : text(input.apiKey, 'API 密钥', 8192, false);
    if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) throw new Error('API 密钥应为英文字符，请去掉空格、换行或中文字符。');
    if (existing?.encryptedKey && baseUrl !== existing.baseUrl && !apiKey && !input.clearKey) throw new Error('接口地址改变后，请重新填写密钥，或明确清除原密钥。');
    const encryptedKey = apiKey ? await this.vault.seal(apiKey) : input.clearKey ? '' : existing?.encryptedKey ?? '';
    if (existing && this.config.providers.find(item => item.id === id) !== existing) {
      throw new Error('此服务在保存期间已被其他操作修改，请重新打开后保存。');
    }
    const provider = { id, name, baseUrl, encryptedKey };
    const providers = existing
      ? this.config.providers.map(item => item.id === id ? provider : item)
      : [...this.config.providers, provider];
    this.saveConfig({ ...this.config, providers });
    return { id, name, baseUrl, hasKey: Boolean(encryptedKey) };
  }
  deleteProvider(id) {
    if (this.config.roles.some(role => role.providerId === id)) throw new Error('请先修改或移除使用此服务的助手角色。');
    this.saveConfig({ ...this.config, providers: this.config.providers.filter(provider => provider.id !== id) });
    return { removed: true };
  }
  saveRole(input) {
    if (!this.config.providers.some(provider => provider.id === input.providerId)) throw new Error('请选择一个已保存的模型服务。');
    const previous = this.config.roles.find(item => item.id === input.id);
    const streamResponse = input.streamResponse ?? previous?.streamResponse ?? true;
    if (typeof streamResponse !== 'boolean') throw new Error('流式输出设置应为开启或关闭。');
    const role = {
      id: this.config.roles.some(item => item.id === input.id) ? input.id : crypto.randomUUID(),
      name: text(input.name, '角色名称', 80),
      providerId: input.providerId,
      model: text(input.model, '模型名称', 200),
      reasoningEffort: reasoningEffort(input.reasoningEffort ?? previous?.reasoningEffort),
      streamResponse,
      maxTokens: integer(Number(input.maxTokens ?? 4096), '最大输出词元', 64, 65536),
      timeoutSeconds: integer(Number(input.timeoutSeconds ?? 300), '超时秒数', 10, 600),
      system: text(input.system ?? '', '角色职责', 20000, false),
    };
    const existing = this.config.roles.some(item => item.id === role.id);
    const roles = existing
      ? this.config.roles.map(item => item.id === role.id ? role : item)
      : [...this.config.roles, role];
    this.saveConfig({ ...this.config, roles });
    return role;
  }
  saveCoordinator(input = {}) {
    const coordinator = {
      name: text(input.name, '主Agent名称', 80),
      system: text(input.system, '主Agent职责', 20000),
    };
    this.saveConfig({ ...this.config, coordinator });
    return coordinator;
  }
  deleteRole(id) { this.saveConfig({ ...this.config, roles: this.config.roles.filter(role => role.id !== id) }); return { removed: true }; }
  setConcurrency(value) { this.saveConfig({ ...this.config, concurrency: integer(value, '并发数量', 1, 4) }); return { concurrency: value }; }
  snapshotRole(id) {
    const role = this.config.roles.find(item => item.id === id);
    if (!role) throw new Error('没有找到此助手角色。');
    const provider = this.config.providers.find(item => item.id === role.providerId);
    if (!provider) throw new Error('助手关联的模型服务已被移除。');
    if (!provider.encryptedKey) throw new Error('请先在配置面板中保存此模型服务的 API 密钥。');
    return { role: { ...role }, provider: { ...provider } };
  }
  addJob(job) { this.saveJobs([...this.jobs, job]); }
  updateJob(id, changes, persist = true) {
    const job = this.jobs.find(item => item.id === id);
    if (!job) throw new Error('任务不存在。');
    const updated = { ...job, ...changes };
    const jobs = this.jobs.map(item => item.id === id ? updated : item);
    if (persist) this.saveJobs(jobs);
    else this.jobs = jobs;
    return updated;
  }
}
