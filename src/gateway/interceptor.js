// Message interceptor.
// Captures messages/prompt/input from every request into a "variable" (ctx.messages),
// applies the request mutation pipeline, writes it back to the body, and sends it upstream.
// Captured messages are kept in MessageStore (most recent N) and exposed via /admin/messages.
import { config } from '../config.js';
import { logEvent } from '../logger.js';

// ── messages variable store ─────────────────────────────────────────
const store = []; // { id, ts, endpoint, kind, messages, changed }

export const MessageStore = {
  save(entry) {
    store.push(entry);
    if (store.length > config.messageStoreSize) store.shift();
    return entry;
  },
  recent(n = 20) {
    return store.slice(-n);
  },
  get(id) {
    return store.find((e) => e.id === id) ?? null;
  },
  size() {
    return store.length;
  },
};

// ── request mutation pipeline (client → gateway → upstream) ─────────
// Registering an fn(ctx) lets you modify ctx.messages (a copy) on every request.
// e.g. addRequestMutation(async (ctx) => { ctx.messages.unshift({ role: 'system', content: 'English only' }); });
const requestMutations = [];

export function addRequestMutation(fn) {
  requestMutations.push(fn);
  return () => {
    const i = requestMutations.indexOf(fn);
    if (i >= 0) requestMutations.splice(i, 1);
  };
}

export function hasRequestMutations() {
  return requestMutations.length > 0;
}

export async function applyRequestMutations(ctx) {
  for (const fn of requestMutations) {
    await fn(ctx);
  }
}

// ── response mutation pipeline (upstream → gateway → client) ─────────
// fn(ctx, response) — response is the whole response JSON for non-streaming,
// or an SSE chunk object for streaming. Mutate it in place.
// With no hooks registered, the response is relayed byte-for-byte (no re-serialization).
const responseMutations = [];

export function addResponseMutation(fn) {
  responseMutations.push(fn);
  return () => {
    const i = responseMutations.indexOf(fn);
    if (i >= 0) responseMutations.splice(i, 1);
  };
}

export function hasResponseMutations() {
  return responseMutations.length > 0;
}

export async function applyResponseMutations(ctx, response) {
  for (const fn of responseMutations) {
    await fn(ctx, response);
  }
}

// ── per-endpoint messages extraction/write-back ─────────────────────
// kind: 'chat.messages' | 'completions.prompt' | 'embeddings.input' | 'responses.input'
export function extractMessages(body, endpoint) {
  switch (endpoint) {
    case 'chat.completions':
      return Array.isArray(body?.messages)
        ? { kind: 'chat.messages', value: body.messages }
        : null;
    case 'completions':
      return body?.prompt !== undefined
        ? { kind: 'completions.prompt', value: body.prompt }
        : null;
    case 'embeddings':
      return body?.input !== undefined
        ? { kind: 'embeddings.input', value: body.input }
        : null;
    case 'responses': {
      const value = {};
      if (body?.instructions !== undefined) value.instructions = body.instructions;
      if (body?.input !== undefined) value.input = body.input;
      return Object.keys(value).length ? { kind: 'responses.input', value } : null;
    }
    default:
      return null;
  }
}

function writeBack(body, endpoint, extracted, next) {
  switch (endpoint) {
    case 'chat.completions':
      body.messages = next;
      break;
    case 'completions':
      body.prompt = next;
      break;
    case 'embeddings':
      body.input = next;
      break;
    case 'responses':
      if ('instructions' in next) body.instructions = next.instructions;
      if ('input' in next) body.input = next.input;
      break;
  }
}

// Extract the messages/content from a response body for response_intercepted logging.
function extractResponseContent(body) {
  if (!body || typeof body !== 'object') return null;
  // chat.completion / chat.completion.chunk
  const choice = body?.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta;
    if (msg?.content !== undefined) return msg.content;
  }
  // accumulated SSE summary or plain content field
  if (body.content !== undefined) return body.content;
  // embeddings
  if (Array.isArray(body?.data)) return body.data;
  return null;
}

/**
 * Intercepts the request body. Keeps a copy in ctx.messages as a variable,
 * applies request mutations and writes them back to the body, then logs.
 */
export async function interceptRequest(ctx) {
  const extracted = extractMessages(ctx.body, ctx.endpoint);
  if (!extracted) return;

  const before = structuredClone(extracted.value);
  ctx.messages = structuredClone(extracted.value); // ★ messages variable

  for (const fn of requestMutations) {
    await fn(ctx);
  }

  const changed = JSON.stringify(ctx.messages) !== JSON.stringify(before);
  writeBack(ctx.body, ctx.endpoint, extracted, ctx.messages);

  MessageStore.save({
    id: ctx.id,
    ts: new Date().toISOString(),
    endpoint: ctx.endpoint,
    kind: extracted.kind,
    messages: ctx.messages,
    changed,
  });

  logEvent('request_intercepted', {
    id: ctx.id,
    endpoint: ctx.endpoint,
    kind: extracted.kind,
    count: Array.isArray(ctx.messages) ? ctx.messages.length : undefined,
    changed,
    messages: config.logBodies ? ctx.messages : undefined,
    delta: ctx.delta,
  });
}

/**
 * Logs the response after response mutations have been applied.
 * Shows the final response content (or "no mutation applied").
 */
export function interceptResponse(ctx, body, mutated) {
  const content = extractResponseContent(body);
  logEvent('response_intercepted', {
    id: ctx.id,
    changed: mutated,
    content: config.logBodies ? content : undefined,
    body: config.logBodies ? body : undefined,
  });
}