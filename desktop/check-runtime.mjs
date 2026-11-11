import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.argv.includes('--paths')) {
  const log = fs.readFileSync(path.join(process.env.APPDATA, 'ModelTeamDesktop', 'startup.log'), 'utf8');
  const marker = '启动独立服务运行库，配置目录 ';
  const matching = log.split(/\r?\n/).filter(line => line.includes(marker));
  const actual = matching.at(-1).split(marker)[1];
  const expected = path.join(process.env.LOCALAPPDATA, 'CodexModelTeam');
  for (const directory of [actual, expected, path.normalize(actual)]) {
    const filename = path.join(directory, 'service.json');
    console.log(JSON.stringify({directory,characterCodes:[...directory].map(c=>c.charCodeAt(0)),exists:fs.existsSync(filename)}));
  }
  const result = spawnSync('C:/Users/tang/Desktop/多模型协作桌面版/resources/node.exe',
    ['C:/Users/tang/Desktop/多模型协作桌面版/resources/app/desktop-connect.mjs'], {
      env: { ...process.env, MODEL_TEAM_DATA_DIR: actual },
      encoding:'utf8',windowsHide:true,timeout:15000,
    });
  console.log(JSON.stringify({status:result.status,connected:/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/.test(result.stdout),stderr:result.stderr}));
  process.exit(0);
}

if (process.argv.includes('--tests')) {
  const result = spawnSync('C:/Users/tang/Desktop/多模型协作桌面版/多模型协作.exe',
    ['--test', 'tests/core.test.mjs', 'tests/integration.test.mjs'], {
      cwd: 'E:/ChatGPT工作区/多模型协作插件/plugins/model-team',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 45000,
    });
  console.log(result.stdout);
  console.error(result.stderr);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const diagnostic = `
const fs = require('node:fs');
const path = require('node:path');
const filename = path.join(process.env.LOCALAPPDATA, 'CodexModelTeam', 'service.json');
const descriptor = JSON.parse(fs.readFileSync(filename, 'utf8'));
console.log(JSON.stringify({node:process.version,localAppData:process.env.LOCALAPPDATA,descriptor:filename,pid:descriptor.pid,origin:descriptor.origin}));
fetch(descriptor.origin + '/health', {headers:{'x-model-team-token':descriptor.token}})
  .then(async response => console.log(JSON.stringify({status:response.status,body:await response.text()})))
  .catch(error => console.log('FETCH ERROR ' + error.message + ' ' + error.cause));
`;
for (const executable of ['E:/Node.js/node.exe', 'C:/Users/tang/Desktop/多模型协作桌面版/多模型协作.exe']) {
  const result = spawnSync(executable, ['-e', diagnostic], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  console.log(JSON.stringify({executable,status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr}));
}
