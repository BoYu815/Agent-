import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const runtime = 'E:/ChatGPT工作区/LibraryCleanerDesktop/node_modules/electron/dist';
const destination = path.join(directory, 'release', '多模型协作桌面版');
const application = path.join(destination, 'resources', 'app');

if (!fs.existsSync(path.join(runtime, 'electron.exe'))) throw new Error('找不到本机 Electron 运行库。');
if (fs.existsSync(destination)) throw new Error('发布目录已存在，请另存当前版本后再构建。');

fs.mkdirSync(destination, { recursive: true });
fs.cpSync(runtime, destination, { recursive: true });
fs.copyFileSync('E:/Node.js/node.exe', path.join(destination, 'resources', 'node.exe'));
fs.renameSync(path.join(destination, 'electron.exe'), path.join(destination, '多模型协作.exe'));
fs.mkdirSync(application, { recursive: true });
for (const filename of ['package.json', 'main.cjs', 'desktop-connect.mjs']) {
  fs.copyFileSync(path.join(directory, filename), path.join(application, filename));
}
const backendSource = path.join(directory, '..', 'plugins', 'model-team');
for (const folder of ['src', 'web']) {
  fs.cpSync(path.join(backendSource, folder), path.join(application, 'backend', folder), { recursive: true });
}
fs.copyFileSync(path.join(backendSource, 'package.json'), path.join(application, 'backend', 'package.json'));
// A packaged app directory supplies the desktop entry point.
const defaultApplication = path.join(destination, 'resources', 'default_app.asar');
if (fs.existsSync(defaultApplication)) fs.unlinkSync(defaultApplication);
console.log(destination);
