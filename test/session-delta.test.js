// Session delta tests: agent clients are stateless and resend the full history,
// so only the messages added since the previous turn should be reported.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { trackMessages, sessionIdOf, resetSessions } from '../src/gateway/session-delta.js';

const msg = (role, content) => ({ role, content });

beforeEach(() => resetSessions());

test('first request of a session returns the whole history', () => {
  const r = trackMessages({ headers: {}, body: { messages: [msg('user', 'hi')] } });
  assert.equal(r.total, 1);
  assert.equal(r.reused, 0);
  assert.deepEqual(r.delta, [msg('user', 'hi')]);
});

test('second turn returns only the appended messages', () => {
  const headers = { 'x-session-id': 's1' };
  const first = [msg('system', 'sys'), msg('user', 'q1')];
  trackMessages({ headers, body: { messages: first } });

  const second = [...first, msg('assistant', 'a1'), msg('user', 'q2')];
  const r = trackMessages({ headers, body: { messages: second } });

  assert.equal(r.reused, 2);
  assert.equal(r.total, 4);
  assert.deepEqual(r.delta, [msg('assistant', 'a1'), msg('user', 'q2')]);
});

test('sessions are isolated by session id', () => {
  trackMessages({ headers: {}, body: { session_id: 'a', messages: [msg('user', 'a1')] } });
  const r = trackMessages({ headers: {}, body: { session_id: 'b', messages: [msg('user', 'b1')] } });
  assert.equal(r.session, 'b');
  assert.equal(r.reused, 0);
  assert.deepEqual(r.delta, [msg('user', 'b1')]);
});

test('body session_id wins over the header', () => {
  assert.equal(sessionIdOf({ 'x-session-id': 'header' }, { session_id: 'body' }), 'body');
});

test('metadata.session_id is accepted', () => {
  assert.equal(sessionIdOf({}, { metadata: { session_id: 'meta' } }), 'meta');
});

test('a retry with no new messages yields an empty delta', () => {
  const headers = { 'x-session-id': 's2' };
  const messages = [msg('user', 'q1')];
  trackMessages({ headers, body: { messages } });
  const r = trackMessages({ headers, body: { messages } });
  assert.equal(r.reused, 1);
  assert.deepEqual(r.delta, []);
});

test('a diverged history returns the differing tail', () => {
  const headers = { 'x-session-id': 's3' };
  trackMessages({ headers, body: { messages: [msg('system', 'sys'), msg('user', 'q1')] } });
  const r = trackMessages({
    headers,
    body: { messages: [msg('system', 'sys'), msg('user', 'edited'), msg('user', 'q2')] },
  });
  assert.equal(r.reused, 1);
  assert.deepEqual(r.delta, [msg('user', 'edited'), msg('user', 'q2')]);
});

test('clients without a session id are grouped by conversation fingerprint', () => {
  const first = [msg('system', 'sys'), msg('user', 'q1')];
  const a = trackMessages({ headers: {}, body: { messages: first } });
  const b = trackMessages({ headers: {}, body: { messages: [...first, msg('user', 'q2')] } });
  assert.match(a.session, /^fp:/);
  assert.equal(a.session, b.session);
  assert.deepEqual(b.delta, [msg('user', 'q2')]);
});

test('requests without a messages array are ignored', () => {
  assert.equal(trackMessages({ headers: {}, body: { model: 'x' } }), null);
  assert.equal(trackMessages({ headers: {}, body: null }), null);
});
