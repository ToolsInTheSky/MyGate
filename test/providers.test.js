// Provider adapter registry tests (SPEC success criterion 4).
// Default provider = existing .env behavior; PROVIDER_ID selects a registered provider.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstream } from '../tools/mock-upstream.js';

const mockA = await startMockUpstream();
const mockB = await startMockUpstream();
process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${mockA.port}/v1`;
process.env.UPSTREAM_API_KEY = 'env-key';
process.env.LOG_DIR = 'logs/test-providers'; // avoid per-file log contention

const registry = await import('../src/providers/registry.js');
const { createApp } = await import('../src/app.js');

const app = createApp();
const gw = app.listen(0, '127.0.0.1');
await new Promise((r) => gw.once('listening', r));
const base = `http://127.0.0.1:${gw.address().port}`;

after(() => {
  delete process.env.PROVIDER_ID;
  gw.close();
  mockA.server.close();
  mockB.server.close();
});

function chatRequest() {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-gpt', messages: [{ role: 'user', content: 'provider test' }] }),
  });
}

test('default active provider is openai-compatible with env values', () => {
  delete process.env.PROVIDER_ID;
  const p = registry.getActive();
  assert.equal(p.id, 'openai-compatible');
  assert.equal(p.baseUrl, `http://127.0.0.1:${mockA.port}/v1`);
  assert.equal(p.apiKey, 'env-key');
});

test('client without Authorization gets default provider env-key fallback', async () => {
  delete process.env.PROVIDER_ID;
  const json = await (await chatRequest()).json();
  assert.equal(json.mygate_test.auth, 'Bearer env-key');
});

test('PROVIDER_ID selects a registered provider (custom baseUrl + apiKey)', async () => {
  registry.registerProvider({ id: 'mockB', name: 'Mock B', baseUrl: `http://127.0.0.1:${mockB.port}/v1`, apiKey: 'custom-key' });
  process.env.PROVIDER_ID = 'mockB';
  try {
    assert.equal(registry.getActive().id, 'mockB');
    const json = await (await chatRequest()).json();
    // Key fallback switches to mockB's apiKey and the request reaches mockB without going through mockA
    assert.equal(json.mygate_test.auth, 'Bearer custom-key');
  } finally {
    delete process.env.PROVIDER_ID;
  }
});

test('unknown PROVIDER_ID → OpenAI-format 500', async () => {
  process.env.PROVIDER_ID = 'does-not-exist';
  try {
    const res = await chatRequest();
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.equal(json.error.type, 'api_error');
    assert.match(json.error.message, /does-not-exist/);
  } finally {
    delete process.env.PROVIDER_ID;
  }
});
