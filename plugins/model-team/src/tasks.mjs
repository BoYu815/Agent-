import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { text, redact, reasoningEffort } from './common.mjs';
import { complete } from './provider.mjs';

export class TaskQueue extends EventEmitter {
  constructor(store, completion = complete) {
    super();
    this.store = store;
    this.completion = completion;
    this.running = new Map();
    this.pumping = false;
    this.stopping = false;
  }
  submit(input) {
    const task = text(input.task, '任务要求', 40000);
    const context = text(input.context ?? '', '参考材料', 200000, false);
    const requestId = input.request_id ? text(input.request_id, '请求编号', 160) : null;
    if (requestId) {
      const existing = this.store.jobs.find(job => job.requestId === requestId);
      if (existing) {
        if (existing.roleId !== input.role_id || existing.task !== task || existing.context !== context || (existing.requestedEffort ?? null) !== (input.reasoning_effort ?? null)) throw new Error('请求编号已被其他任务使用。');
        return this.store.publicJob(existing);
      }
    }
    if (this.store.jobs.filter(job => ['queued', 'running', 'cancelling'].includes(job.status)).length >= 50) throw new Error('待处理任务已达 50 个，请等待已有任务完成。');
    const snapshot = this.store.snapshotRole(input.role_id);
    if (input.reasoning_effort != null) snapshot.role.reasoningEffort = reasoningEffort(input.reasoning_effort);
    const job = { id: crypto.randomUUID(), requestId, requestedEffort: input.reasoning_effort ?? null,
      reasoningEffort: snapshot.role.reasoningEffort ?? 'default', roleId: snapshot.role.id, roleName: snapshot.role.name,
      providerName: snapshot.provider.name, model: snapshot.role.model, task, context, status: 'queued', createdAt: new Date().toISOString(), snapshot };
    this.store.addJob(job);
    queueMicrotask(() => this.pump());
    return this.store.publicJob(job);
  }
  pump() {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      while (this.running.size < this.store.config.concurrency) {
        const job = this.store.jobs.find(item => item.status === 'queued');
        if (!job) break;
        const controller = new AbortController();
        this.store.updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
        this.running.set(job.id, controller);
        this.execute(job, controller).catch(() => {}).finally(() => { this.running.delete(job.id); this.pump(); });
      }
    } finally { this.pumping = false; }
  }
  async execute(job, controller) {
    let key = '';
    const timeout = setTimeout(() => controller.abort(new Error('任务超时，请查看后手动重试。')), job.snapshot.role.timeoutSeconds * 1000);
    try {
      key = await this.store.vault.unseal(job.snapshot.provider.encryptedKey);
      controller.signal.throwIfAborted();
      this.store.updateJob(job.id, { stage: 'waiting' }, false);
      const result = await this.completion(job.snapshot, key, job.task, job.context, controller.signal, progress => {
        if (!controller.signal.aborted) this.store.updateJob(job.id, progress, false);
      });
      controller.signal.throwIfAborted();
      this.store.updateJob(job.id, { ...result, partialResult: null, stage: 'completed', status: 'completed', snapshot: null, finishedAt: new Date().toISOString() });
    } catch (error) {
      const status = this.stopping ? 'interrupted' : controller.signal.aborted && controller.signal.reason?.message === '已取消任务。' ? 'cancelled' : 'failed';
      const message = controller.signal.aborted ? controller.signal.reason?.message ?? '任务已中断。' : error.message;
      this.store.updateJob(job.id, { ...error.completion, status, error: redact(message, [key]), snapshot: null, finishedAt: new Date().toISOString() });
    } finally { clearTimeout(timeout); this.emit('settled'); }
  }
  cancel(id) {
    const job = this.store.jobs.find(item => item.id === id);
    if (!job) throw new Error('任务不存在。');
    if (job.status === 'queued') { this.store.updateJob(id, { status: 'cancelled', snapshot: null, finishedAt: new Date().toISOString() }); this.emit('settled'); }
    if (job.status === 'running') {
      this.store.updateJob(id, { status: 'cancelling' });
      this.running.get(id)?.abort(new Error('已取消任务。'));
    }
    return this.store.publicJob(this.store.jobs.find(item => item.id === id));
  }
  retry(id) {
    const job = this.store.jobs.find(item => item.id === id);
    if (!job || !['failed', 'cancelled', 'interrupted'].includes(job.status)) throw new Error('只能重试失败、取消或中断的任务。');
    return this.submit({ role_id: job.roleId, task: job.task, context: job.context, reasoning_effort: job.requestedEffort ?? undefined });
  }
  wait(ids, milliseconds) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || ids.some(id => typeof id !== 'string' || !this.store.jobs.some(job => job.id === id))) {
      throw new Error('请提供 1 到 8 个有效任务编号。');
    }
    const current = () => ids.map(id => this.store.publicJob(this.store.jobs.find(job => job.id === id)));
    const finished = () => current().some(job => !['queued', 'running', 'cancelling'].includes(job.status));
    if (finished()) return Promise.resolve({ tasks: current() });
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.off('settled', check); resolve({ tasks: current() }); };
      const check = () => { if (finished()) finish(); };
      const timer = setTimeout(finish, milliseconds);
      this.on('settled', check);
    });
  }
  stop() { this.stopping = true; for (const controller of this.running.values()) controller.abort(new Error('本地服务正在退出。')); }
}
