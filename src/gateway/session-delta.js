// Per-session message delta tracking.
//
// Agent clients (ACP — Agent Communication Protocol — and most chat UIs) are stateless:
// every turn re-sends the FULL message history. Logging that verbatim makes the console
// unreadable, so we cache the last messages per session and expose only the newly
// appended ones (the "delta").
//
// Session key resolution order:
//   1. body.session_id / sessionId / conversation_id / thread_id (also under body.metadata)
//   2. headers: x-session-id / x-acp-session-id / x-conversation-id / x-thread-id
//   3. fingerprint of the system message + first user message (best-effort grouping)
import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';

// Bounded cache: at most 500 sessions, evicted after 1 hour of inactivity.
const sessions = new LRUCache({ max: 500, ttl: 60 * 60 * 1000 });

const BODY_KEYS = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId'];
const HEADER_KEYS = ['x-session-id', 'x-acp-session-id', 'x-conversation-id', 'x-thread-id'];

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export function sessionIdOf(headers = {}, body = {}) {
  const fromBody = BODY_KEYS.map((k) => body?.[k]);
  const fromMetadata = BODY_KEYS.map((k) => body?.metadata?.[k]);
  const explicit = firstString(...fromBody, ...fromMetadata);
  if (explicit) return explicit;

  const fromHeaders = firstString(...HEADER_KEYS.map((k) => headers?.[k]));
  if (fromHeaders) return fromHeaders;

  return null;
}

// Fallback key for clients that send no session id: group by the conversation opener.
function fingerprint(messages) {
  const system = messages.find((m) => m?.role === 'system');
  const firstUser = messages.find((m) => m?.role !== 'system') ?? messages[0];
  const seed = JSON.stringify([system?.content ?? '', firstUser?.content ?? '']);
  return `fp:${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

function sameMessage(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Records the messages of a request and returns the newly appended ones.
 * Returns null when the request carries no message array (models, health, embeddings...).
 *
 * @returns {{session: string, total: number, reused: number, delta: unknown[]} | null}
 */
export function trackMessages({ headers, body }) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const session = sessionIdOf(headers, body) ?? fingerprint(messages);
  const previous = sessions.get(session) ?? [];

  // Longest common prefix: everything before it was already sent in an earlier turn.
  let common = 0;
  while (common < previous.length && common < messages.length && sameMessage(previous[common], messages[common])) {
    common += 1;
  }

  const delta = messages.slice(common);
  sessions.set(session, messages);

  return { session, total: messages.length, reused: common, delta };
}

export function resetSessions() {
  sessions.clear();
}

export function sessionCount() {
  return sessions.size;
}
