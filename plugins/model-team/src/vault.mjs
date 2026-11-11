import { spawn } from 'node:child_process';

// Send secret material over stdin, never in process arguments or logs.
const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$request = $inputText | ConvertFrom-Json
$entropy = [Text.Encoding]::UTF8.GetBytes('codex-model-team-v1')
if ($request.action -eq 'seal') {
  $clear = [Text.Encoding]::UTF8.GetBytes([string]$request.value)
  $protected = [Security.Cryptography.ProtectedData]::Protect($clear,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} else {
  $protected = [Convert]::FromBase64String([string]$request.value)
  $clear = [Security.Cryptography.ProtectedData]::Unprotect($protected,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($clear))
}
`;
function transform(action, value) {
  if (process.platform !== 'win32') throw new Error('此版本使用 Windows 当前用户加密存储，请在 Windows 上运行。');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let completed = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('本机密钥加密服务超时。')); }, 15000);
    function finish(error) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.on('error', () => finish(new Error('无法启动 Windows 密钥加密服务。')));
    child.on('close', code => finish(code === 0 ? null : new Error('无法使用当前 Windows 用户读取或保存密钥，请重新填写。')));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ action, value }));
  });
}
export const seal = value => transform('seal', value);
export const unseal = value => transform('unseal', value);
