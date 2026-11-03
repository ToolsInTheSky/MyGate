// Upstream proxy. Logs every outgoing request/response and relays SSE streams
// byte-by-byte while accumulating their content for logging.
import { randomUUID } from 'node:crypto';
import { EnvHttpProxyAgent } from 'undici';
import { config } from '../config.js';
import { logEvent, redactHeaders } from '../logger.js';
import { hasResponseMutations, applyResponseMutations, interceptResponse } from './interceptor.js';
import { getActive } from '../providers/registry.js';

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding',
  'accept-encoding',
]);
const proxyDispatcher = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy
  ? new EnvHttpProxyAgent()
  : undefined;

function describeFetchError(error){
  const cause = error?.cause;
  if (!cause) return error;
  const detail = [cause.code, cause.message].filter(Boolean).join(': ');
  if (detail) error.message = `${error.message} (${detail})`;
  return error;
}

export function upstreamUrl(requestUrl, baseUrl) {
  const base = new URL(baseUrl);
  const request = new URL(requestUrl, 'http://localhost');
  const basePath = base.pathname.replace(/\/$/, '');
  const requestPath = request.pathname.replace(/^\/v1(?=\/|$)/, '');
  base.pathname = `${basePath}${requestPath}`;
  base.search = request.search;
  return base;
}

function buildUpstreamHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
  }
  // API key passthrough (SPEC decision 1): forward the client's Authorization as-is,
  // and use the active provider's apiKey only as a fallback when none was sent.
  const provider = getActive();
  if (!headers.authorization && provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  headers['x-mygate-request-id'] = req.ctx.id;
  return headers;
}

function summarizeChat(json) {
  const choice = json?.choices?.[0];
  return {
    completionId: json?.id,
    model: json?.model,
    content: choice?.message?.content,
    finishReason: choice?.finish_reason,
    usage: json?.usage,
  };
}

// Accumulate delta content from the SSE text to build a log summary.
function sseSummary(text) {
  let content = '';
  let toolCalls;
  let finishReason = null;
  let usage = null;
  let completionId = null;
  let model = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      completionId ??= chunk.id;
      model ??= chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.delta?.tool_calls) toolCalls = choice.delta.tool_calls;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    } catch { /* ignore vendor-specific extension events */ }
  }
  return { completionId, model, content: toolCalls ? null : content, tool_calls: toolCalls, finishReason, usage };
}

// Transforms one SSE line (data: event) through the response mutations. [DONE]/comments/parse failures stay as-is.
async function transformSseLine(ctx, line) {
  if (!line.startsWith('data:')) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return line;
  try {
    const chunk = JSON.parse(payload);
    await applyResponseMutations(ctx, chunk);
    return `data: ${JSON.stringify(chunk)}`;
  } catch {
    return line; // leave unknown events untouched
  }
}

/**
 * Forwards ctx.body (the mutated request) to upstream and relays the response to the client.
 * Registered as Express middleware: forward(req, res, next).
 */
export async function forward(req, res) {
  const ctx = req.ctx;
  const { id } = ctx;
  const provider = getActive();
  const url = upstreamUrl(req.originalUrl, provider.baseUrl);
  const headers = buildUpstreamHeaders(req);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const payload = hasBody ? (ctx.body !== undefined ? JSON.stringify(ctx.body) : ctx.rawBody) : undefined;

  logEvent('upstream_request', {
    id,
    method: req.method,
    url: url.toString(),
    headers: config.logHeaders ? redactHeaders(headers) : undefined,
    body: config.logBodies ? payload : undefined,
    delta: ctx.delta,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

  let upstreamRes;
  try {
    upstreamRes = await fetch(url, {
      method: req.method,
      headers,
      body: payload,
      signal: controller.signal,
      duplex: 'half',
      dispatcher: proxyDispatcher,
    });
  } catch (error) {
    throw describeFetchError(error);
  } finally {
    clearTimeout(timer);
  }

  const contentType = upstreamRes.headers.get('content-type') ?? 'application/json';
  const upstreamLog = {
    id,
    status: upstreamRes.status,
    requestId: upstreamRes.headers.get('x-request-id') ?? undefined,
    contentType,
  };

  // ── SSE stream: accumulate logs + (when mutations are registered) mutate per chunk ──
  // Without mutations, relay bytes as-is (no re-serialization policy, SPEC assumption 6).
  if (contentType.includes('text/event-stream')) {
    res.status(upstreamRes.status);
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');

    const mutate = hasResponseMutations();
    const collector = new TextDecoder();
    let total = 0;
    let sseText = '';
    let transformedSseText = '';
    let lineBuf = '';
    const reader = upstreamRes.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        const text = collector.decode(value, { stream: true });
        sseText += text;
        if (!mutate) {
          res.write(value);
          continue;
        }
        // Mutation mode: line buffer → parse/transform only data: events, then rewrite
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop(); // last item is an incomplete line — append it to the next chunk
        for (const line of lines) {
          const transformed = await transformSseLine(ctx, line.replace(/\r$/, ''));
          transformedSseText += `${transformed}\n`;
          res.write(`${transformed}\n`);
        }
      }
      sseText += collector.decode();
      if (mutate && lineBuf) {
        const transformed = await transformSseLine(ctx, lineBuf.replace(/\r$/, ''));
        transformedSseText += `${transformed}\n`;
        res.write(`${transformed}\n`);
      }
    } catch (err) {
      logEvent('gateway_error', { id, phase: 'stream', message: String(err) });
    } finally {
      res.end();
    }

    const upstreamSummary = sseSummary(sseText);
    if (config.logBodies) upstreamLog.body = { ...upstreamSummary, object: 'chat.completion.chunk' };
    logEvent('upstream_received', upstreamLog);
    const summary = sseSummary(mutate ? transformedSseText : sseText);
    const sseBody = { ...summary, object: 'chat.completion.chunk' };
    interceptResponse(ctx, sseBody, mutate);
    logEvent('client_response', {
      id,
      status: upstreamRes.status,
      stream: true,
      mutated: mutate,
      bytes: total,
      ...summary,
      contentLength: summary.content?.length,
    });
    return;
  }

  // ── Regular response: relay the original bytes as-is (preserve unknown fields) ──
  // Only JSON responses are parsed/transformed/re-serialized when response mutations are registered.
  const text = await upstreamRes.text();
  if (config.logBodies && contentType.includes('json')) {
    try {
      upstreamLog.body = JSON.parse(text);
    } catch { /* non-JSON passthrough */ }
  }
  logEvent('upstream_received', upstreamLog);
  let outText = text;
  let mutated = false;
  if (hasResponseMutations() && contentType.includes('json')) {
    try {
      const json = JSON.parse(text);
      const baseline = JSON.stringify(json);
      await applyResponseMutations(ctx, json);
      const after = JSON.stringify(json);
      if (after !== baseline) {
        outText = after;
        mutated = true;
      }
    } catch { /* non-JSON passthrough */ }
  }
  res.status(upstreamRes.status);
  res.setHeader('content-type', contentType);
  res.send(outText);

  let json = null;
  try { json = JSON.parse(outText); } catch { /* non-JSON passthrough */ }
  interceptResponse(ctx, json, mutated);
  logEvent('client_response', {
    id,
    status: upstreamRes.status,
    stream: false,
    mutated,
    ...(json?.object === 'chat.completion' ? summarizeChat(json) : {}),
    body: config.logBodies ? outText : undefined,
  });
}

export function newRequestId() {
  return randomUUID();
}
