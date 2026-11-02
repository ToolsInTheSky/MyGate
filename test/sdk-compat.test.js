// SDK compatibility tests (SPEC success criterion 1): verifies that the Vercel AI SDK's
// OpenAI-compatible client works for both non-stream and stream with only the gateway baseURL.
// Dependencies: ai, @ai-sdk/openai-compatible (devDependency, approved 2026-10-29).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { startMockUpstream } from '../tools/mock-upstream.js';

const mock = await startMockUpstream();
process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
process.env.LOG_DIR = 'logs/test-sdk'; // avoid log file contention when running in parallel with gateway.test.js

const { createApp } = await import('../src/app.js');
const app = createApp();
const gw = app.listen(0, '127.0.0.1');
await new Promise((r) => gw.once('listening', r));

after(() => {
  gw.close();
  mock.server.close();
});

// Custom provider pointing at the gateway — the SDK sees the gateway as an OpenAI server.
const gate = createOpenAICompatible({
  name: 'mygate',
  baseURL: `http://127.0.0.1:${gw.address().port}/v1`,
  apiKey: 'sdk-test-key',
});

test('Vercel AI SDK generateText works through the gateway', async () => {
  const { text } = await generateText({ model: gate('mock-gpt'), prompt: 'hello gate' });
  assert.equal(text, 'echo:1'); // the mock counts received messages → the SDK sends one user message
});

test('Vercel AI SDK streamText works through the gateway (SSE relay)', async () => {
  const { text } = await streamText({ model: gate('mock-gpt'), prompt: 'stream via sdk' });
  assert.equal(await text, 'echo:1');
});
