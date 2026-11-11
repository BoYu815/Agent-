import { controlPanelUrl, openBrowser, rpc } from './client.mjs';
try {
  const command = process.argv[2] ?? 'open';
  if (command === 'open') {
    openBrowser(await controlPanelUrl());
    process.stdout.write('多模型协作面板已打开。\n');
  } else if (command === 'status') {
    process.stdout.write(JSON.stringify(await rpc('list_roles'), null, 2) + '\n');
  } else throw new Error('支持的操作为 open、status。');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
