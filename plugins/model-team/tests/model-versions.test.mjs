import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocumentedVersions } from '../src/provider.mjs';

test('reads model aliases and full versions from the same official table', () => {
  const html = `<table><tr><th>MODEL</th><th><code>deepseek-flash</code><sup>(1)</sup></th><th>deepseek-v4-pro</th></tr>
    <tr><td>MODEL VERSION</td><td>DeepSeek-V4.1-Flash-1017</td><td>DeepSeek-V4-Pro-0813</td></tr></table>`;
  assert.deepEqual([...parseDocumentedVersions(html)], [
    ['deepseek-flash', 'DeepSeek-V4.1-Flash-1017'], ['deepseek-v4-pro', 'DeepSeek-V4-Pro-0813'],
  ]);
});

test('supports new documented versions without inventing missing aliases', () => {
  const html = `<table><tr><td>MODEL</td><td>deepseek-example</td><td>deepseek-missing</td></tr>
    <tr><td>MODEL VERSION</td><td>DeepSeek-Example-1231</td><td></td></tr></table>`;
  assert.deepEqual([...parseDocumentedVersions(html)], [['deepseek-example', 'DeepSeek-Example-1231']]);
  assert.equal(parseDocumentedVersions('<html>Unavailable</html>').size, 0);
});

test('does not join unrelated tables or accept prose as a model version', () => {
  const html = `<table><tr><td>MODEL</td><td>deepseek-flash</td></tr></table>
    <table><tr><td>MODEL VERSION</td><td>DeepSeek-Example-1231</td></tr></table>
    <table><tr><td>MODEL</td><td>deepseek-test</td></tr><tr><td>MODEL VERSION</td><td>unknown version</td></tr></table>`;
  assert.equal(parseDocumentedVersions(html).size, 0);
  assert.equal(parseDocumentedVersions('<table><tr><th>MODEL</th><th>deepseek-test</th><th>deepseek-other</th></tr><tr><td>MODEL VERSION</td><td>DeepSeek-Test-1017</td></tr></table>').size, 0);
});

test('adds official full versions without sending API credentials to the documentation site', async () => {
  const originalFetch = globalThis.fetch;
  const { listModels } = await import('../src/provider.mjs?version-success');
  const html = '<table><tr><th>MODEL</th><th>deepseek-flash</th></tr><tr><td>MODEL VERSION</td><td>DeepSeek-V4.1-Flash-1017</td></tr></table>';
  try {
    globalThis.fetch = async (url, options) => {
      if (url === 'https://api.deepseek.com/v1/models') {
        assert.equal(options.headers.Authorization, 'Bearer fixture-key');
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] }));
      }
      assert.equal(url, 'https://api-docs.deepseek.com/quick_start/pricing/');
      assert.equal(options.headers, undefined);
      return new Response(html);
    };
    const result = await listModels({ baseUrl: 'https://api.deepseek.com/v1' }, 'fixture-key');
    assert.deepEqual(result.models, ['deepseek-flash']);
    assert.equal(result.details[0].documentedVersion, 'DeepSeek-V4.1-Flash-1017');
    assert.equal(result.details[0].versionSource, 'https://api-docs.deepseek.com/quick_start/pricing/');
    assert.ok(result.details[0].versionCheckedAt);
  } finally { globalThis.fetch = originalFetch; }
});

test('keeps model discovery usable when the documentation request fails', async () => {
  const originalFetch = globalThis.fetch;
  const { listModels } = await import('../src/provider.mjs?version-failure');
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.deepseek.com/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] }));
      }
      throw new Error('Fixture documentation outage');
    };
    const result = await listModels({ baseUrl: 'https://api.deepseek.com/v1' }, 'fixture-key');
    assert.deepEqual(result.models, ['deepseek-v4-pro']);
    assert.equal(result.details[0].name, 'DeepSeek-V4-Pro');
    assert.equal(result.details[0].documentedVersion, undefined);
  } finally { globalThis.fetch = originalFetch; }
});
