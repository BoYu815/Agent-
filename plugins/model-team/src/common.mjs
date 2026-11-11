import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PRODUCT = 'local-model-team-v1';
export const DEFAULT_PORT = 17863;
export const COLLABORATION_WORKFLOW = '按速度与质量共同选择协作步骤。配置查询、状态说明和局部简单修改由主Agent直接完成。普通、范围明确的子任务使用low；复杂推导、跨模块逻辑、数据兼容、并发与故障恢复使用high，关键审查保留high。通过submit_task的reasoning_effort按任务覆盖角色等级。独立任务同时提交，避免把所有角色串行调用一遍；用wait_tasks等待任一任务完成，先处理已返回结果，后续只等待仍在运行的编号。主Agent应用补丁并执行相关测试，关键改动或实质争议增加独立审查；明确的测试结果可直接验收。输出截断、测试失败或关键证据缺失时，补齐相关材料并针对具体缺口重做或升级到high，保留已验证成果。向助手集中提供必要文件、准确接口和验收条件，减少补丁猜测与往返。用户追问时先回答当前问题，再报告尚待完成的工作。';
export function reasoningEffort(value = 'default') {
  if (!['default', 'low', 'high', 'max'].includes(value)) throw new Error('推理等级应为服务商默认、低、高或最高。');
  return value;
}
export function dataDirectory() {
  if (process.env.MODEL_TEAM_DATA_DIR) return path.resolve(process.env.MODEL_TEAM_DATA_DIR);
  const local = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? 'C:/Users/tang', 'AppData', 'Local');
  // Codex 沙箱里 LOCALAPPDATA 已经重定向到 Codex 包目录，保持原样；
  // 普通环境（例如手动双击“打开协作面板”）也优先用同一个包目录，
  // 这样桌面版和插件才能共用 service.json、配置和任务，不重复起服务抢 17863 端口。
  if (!/[\\/]Packages[\\/]OpenAI\.Codex_[^\\/]+[\\/]LocalCache[\\/]Local$/i.test(local)) {
    try {
      const packages = path.join(local, 'Packages');
      const candidates = [];
      for (const name of fs.readdirSync(packages)) {
        if (!/^OpenAI\.Codex_/i.test(name)) continue;
        const packageRoot = path.join(packages, name);
        if (fs.existsSync(packageRoot)) candidates.push(path.join(packageRoot, 'LocalCache', 'Local', 'CodexModelTeam'));
      }
      if (candidates.length) {
        const withData = candidates.find(directory => fs.existsSync(path.join(directory, 'config.json')) || fs.existsSync(path.join(directory, 'service.json')));
        return withData ?? candidates[0];
      }
    } catch {}
  }
  return path.join(local, 'CodexModelTeam');
}
export function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function readJson(filename, fallback) {
  if (!fs.existsSync(filename)) return fallback;
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error(`配置文件无法读取，请保留文件后检查格式。${path.basename(filename)}`); }
}
export function text(value, name, maximum = 20000, required = true) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
    throw new Error(`${name}不能为空，且长度不能超过 ${maximum} 个字符。`);
  }
  return value.trim();
}
export function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name}应为 ${minimum} 到 ${maximum} 之间的整数。`);
  return value;
}
export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(text(value, '接口地址', 2048)); } catch { throw new Error('请填写有效的完整接口地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('远程模型服务需要 HTTPS，本机模型服务可使用 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址中应去掉用户名、密码、查询参数和片段。');
  url.pathname = url.pathname.replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}
export function redact(value, secrets = [], maximum = 1500) {
  let output = String(value ?? '未知错误');
  for (const secret of secrets) if (secret) output = output.split(secret).join('[密钥已隐藏]');
  return output.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [已隐藏]').slice(0, maximum);
}
