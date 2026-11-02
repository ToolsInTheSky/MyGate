// Gateway integration tests: uses the Node built-in test runner.
// Starts the gateway in front of a mock upstream and verifies passthrough/interception (variable storage)/mutation/streaming.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstream } from '../tools/mock-upstream.js';

const mock = await startMockUpstream();
process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
process.env.LOG_DIR = 'logs/test';

const { createApp } = await import('../src/app.js');
const { MessageStore, addRequestMutation, addResponseMutation } = await import('../src/gateway/interceptor.js');

const app = createApp();
const gw = app.listen(0, '127.0.0.1');
await new Promise((r) => gw.once('listening', r));
const base = `http://127.0.0.1:${gw.address().port}`;

after(() => {
  gw.close();
  mock.server.close();
});

function postChat(body, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('GET /v1/models is proxied unchanged', async () => {
  const res = await fetch(`${base}/v1/models`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.object, 'list');
  assert.equal(json.data[0].id, 'mock-gpt');
});

test('chat messages are captured into the variable store', async () => {
  const res = await postChat({ model: 'mock-gpt', messages: [{ role: 'user', content: 'hello gate' }] });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.choices[0].message.content, 'echo:1');

  const entry = MessageStore.recent(1)[0];
  assert.equal(entry.kind, 'chat.messages');
  assert.equal(entry.messages[0].content, 'hello gate');
  assert.equal(entry.changed, false);
});

test('registered mutation modifies messages before upstream', async () => {
  const off = addRequestMutation(async (ctx) => {
    if (ctx.endpoint === 'chat.completions') ctx.messages.unshift({ role: 'system', content: 'injected' });
  });
  try {
    const res = await postChat({ model: 'mock-gpt', messages: [{ role: 'user', content: 'hi' }] });
    const json = await res.json();
    // The mock counts the messages it received and echoes it → 2 when one system message was inserted
    assert.equal(json.choices[0].message.content, 'echo:2');

    const entry = MessageStore.recent(1)[0];
    assert.equal(entry.changed, true);
    assert.equal(entry.messages[0].role, 'system');
  } finally {
    off();
  }
});

test('SSE stream is relayed with [DONE] and logged', async () => {
  const res = await postChat({ model: 'mock-gpt', stream: true, messages: [{ role: 'user', content: 'stream me' }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /data: \{.*chat\.completion\.chunk/);
  assert.match(text, /data: \[DONE\]/);

  // Verify the stream response summary (content/usage) is written to the JSONL log
  await new Promise((r) => setTimeout(r, 100));
  const fs = await import('node:fs');
  const { currentLogFile } = await import('../src/logger.js');
  const lines = fs.readFileSync(currentLogFile(), 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.type, 'client_response');
  assert.equal(last.stream, true);
  assert.equal(last.content, 'echo:1');
  assert.equal(last.usage.total_tokens, 2);
});

test('embeddings passthrough', async () => {
  const res = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-embed', input: 'embed me' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data[0].object, 'embedding');
});

test('unknown /v1 route is proxied (future endpoints)', async () => {
  const res = await fetch(`${base}/v1/future/thing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ any: 'shape' }),
  });
  assert.equal(res.status, 404); // the mock returns 404 and the gateway relays it unchanged
  const json = await res.json();
  assert.ok(json.error.message.includes('no route'));
});

test('client Authorization is passed through to upstream (key passthrough)', async () => {
  const res = await postChat(
    { model: 'mock-gpt', messages: [{ role: 'user', content: 'auth' }] },
    { authorization: 'Bearer client-key-123' },
  );
  const json = await res.json();
  assert.equal(json.mygate_test.auth, 'Bearer client-key-123');
});

test('no client Authorization → no fallback key in tests (env unset)', async () => {
  const res = await postChat({ model: 'mock-gpt', messages: [{ role: 'user', content: 'anon' }] });
  const json = await res.json();
  assert.equal(json.mygate_test.auth, null); // no Authorization when UPSTREAM_API_KEY is unset
});

test('response mutation modifies non-stream response before client', async () => {
  const off = addResponseMutation(async (ctx, response) => {
    if (response.object === 'chat.completion') response.choices[0].message.content = 'MUTATED';
  });
  try {
    const res = await postChat({ model: 'mock-gpt', messages: [{ role: 'user', content: 'mutate me' }] });
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'MUTATED');
  } finally {
    off();
  }
});

test('response mutation modifies SSE chunks, [DONE] preserved', async () => {
  const off = addResponseMutation(async (ctx, chunk) => {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) delta.content = delta.content.toUpperCase();
  });
  try {
    const res = await postChat({ model: 'mock-gpt', stream: true, messages: [{ role: 'user', content: 'upper' }] });
    const text = await res.text();
    assert.match(text, /ECHO:1/); // delta content was mutated to uppercase
    assert.match(text, /data: \[DONE\]/); // frame preserved
  } finally {
    off();
  }
});

test('admin messages endpoint exposes the variable store', async () => {
  const res = await fetch(`${base}/admin/messages?last=5`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.count >= 3);
  assert.ok(json.data.at(-1).messages);
});

test('invalid JSON body → OpenAI-format 400', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.type, 'invalid_request_error');
});
