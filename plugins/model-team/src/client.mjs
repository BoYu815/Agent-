import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCT, dataDirectory, readJson } from './common.mjs';

let starting;
export async function ensureService() {
  if (starting) return starting;
  starting = connect().finally(() => { starting = null; });
  return starting;
}
async function descriptorIfReady() {
  try {
    const descriptor = readJson(path.join(dataDirectory(), 'service.json'), null);
    if (descriptor?.product !== PRODUCT || !/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.origin)) return null;
    const response = await fetch(`${descriptor.origin}/health`, { headers: { 'x-model-team-token': descriptor.token }, signal: AbortSignal.timeout(800), redirect: 'error' });
    if (response.ok && (await response.json()).product === PRODUCT) return descriptor;
  } catch {}
  return null;
}
async function connect() {
  const ready = await descriptorIfReady();
  if (ready) return ready;
  const daemon = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
  const child = spawn(process.execPath, [daemon], { detached: true, windowsHide: true, stdio: 'ignore', cwd: path.dirname(daemon), env: process.env });
  let spawnError = false;
  child.on('error', () => { spawnError = true; });
  child.unref();
  for (let attempt = 0; attempt < 70; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (spawnError) throw new Error('无法启动本地协作服务，请检查 Node.js 安装。');
    const descriptor = await descriptorIfReady();
    if (descriptor) return descriptor;
  }
  throw new Error('本地协作服务启动失败，请检查端口 17863 是否被其他程序占用。');
}
export async function rpc(operation, input = {}) {
  const descriptor = await ensureService();
  const response = await fetch(`${descriptor.origin}/rpc`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'x-model-team-token': descriptor.token },
    body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '本地协作服务请求失败。');
  return data.result;
}
export async function controlPanelUrl() { const descriptor = await ensureService(); return `${descriptor.origin}/#token=${descriptor.token}`; }
export function openBrowser(url) {
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
