const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

app.setName('多模型协作桌面版');
app.setAppUserModelId('Tang.ModelTeam.Desktop');
app.setPath('userData', path.join(app.getPath('appData'), 'ModelTeamDesktop'));
// 桌面版和 Codex 插件必须共用同一个数据目录，否则两边会各起一个服务抢 17863 端口。
// Codex 是打包应用，它启动的子进程会把 %LOCALAPPDATA% 重定向到
// %LOCALAPPDATA%\Packages\<Codex 包名>\LocalCache\Local，本地协作服务的数据就写在那里；
// 所以检测到 Codex 包目录时直接沿用，找不到才退回普通用户的 %LOCALAPPDATA%\CodexModelTeam。
function resolveDataDirectory() {
  const localAppData = path.join(app.getPath('appData'), '..', 'Local');
  try {
    const packages = path.join(localAppData, 'Packages');
    const candidates = [];
    for (const name of fs.readdirSync(packages)) {
      if (!/^OpenAI\.Codex_/i.test(name)) continue;
      const packageRoot = path.join(packages, name);
      if (fs.existsSync(packageRoot)) {
        candidates.push(path.join(packageRoot, 'LocalCache', 'Local', 'CodexModelTeam'));
      }
    }
    if (candidates.length) {
      const withData = candidates.find(directory =>
        fs.existsSync(path.join(directory, 'config.json')) || fs.existsSync(path.join(directory, 'service.json')));
      return withData ?? candidates[0];
    }
  } catch {}
  return path.join(localAppData, 'CodexModelTeam');
}
process.env.MODEL_TEAM_DATA_DIR = resolveDataDirectory();

let mainWindow;

function logStartup(message) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'),
      new Date().toISOString() + ' ' + message + '\n');
  } catch {}
}

function connectToService() {
  return new Promise((resolve, reject) => {
    const runtime = path.join(__dirname, '..', 'node.exe');
    logStartup('启动独立服务运行库，配置目录 ' + process.env.MODEL_TEAM_DATA_DIR);
    const child = spawn(runtime, [path.join(__dirname, 'desktop-connect.mjs')], {
      cwd: __dirname,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    let finished = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('连接本机协作服务超时，请稍后重新打开。'));
    }, 20000);

    function finish(error, url) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 8192) {
        child.kill();
        finish(new Error('本机服务返回了过长的连接地址。'));
      }
    });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-1500); });
    child.on('error', () => finish(new Error('无法启动本机服务，请检查程序文件是否完整。')));
    child.on('close', code => {
      if (finished) return;
      if (code !== 0) {
        finish(new Error(errorOutput || '本机协作服务启动失败。'));
        return;
      }
      try {
        const url = new URL(output.trim());
        const token = new URLSearchParams(url.hash.slice(1)).get('token');
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
            !url.port || url.username || url.password || url.pathname !== '/' ||
            url.search || !/^[a-f0-9]{64}$/.test(token || '')) {
          throw new Error('Invalid local service address');
        }
        finish(null, url);
      } catch {
        finish(new Error('本机服务连接信息无效，请重新打开程序。'));
      }
    });
  });
}

async function openWindow() {
  const serviceUrl = await connectToService();
  logStartup('已连接本机协作服务');
  const allowedOrigin = serviceUrl.origin;
  mainWindow = new BrowserWindow({
    title: '多模型协作桌面版',
    width: 1220,
    height: 840,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#f4f7f6',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.setMenu(null);
  const contents = mainWindow.webContents;
  function restrictNavigation(event, destination) {
    try {
      if (new URL(destination).origin === allowedOrigin) return;
    } catch {}
    event.preventDefault();
  }
  contents.on('will-navigate', restrictNavigation);
  contents.on('will-redirect', restrictNavigation);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.on('page-title-updated', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => {
    logStartup('桌面窗口已显示');
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(serviceUrl.href);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(openWindow).catch(error => {
    logStartup('启动失败 ' + error.message);
    dialog.showErrorBox('多模型协作桌面版启动失败', error.message);
    app.quit();
  });
}
