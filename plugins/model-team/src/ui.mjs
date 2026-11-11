import fs from 'node:fs';
export function renderUi() {
  return fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
    .replace('/*__STYLE__*/', () => fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8'))
    .replace('/*__SCRIPT__*/', () => fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/<\/script/gi, '<\\/script'));
}
