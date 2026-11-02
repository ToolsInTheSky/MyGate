// Express app factory. Middleware order:
//   raw body → incoming request log/ctx → /v1 routes → /health, /admin → 404/error
import express from 'express';
import { config } from './config.js';
import { logEvent, redactHeaders } from './logger.js';
import { newRequestId } from './gateway/proxy.js';
import { MessageStore } from './gateway/interceptor.js';
import { trackMessages } from './gateway/session-delta.js';
import { openaiRouter } from './routes/openai.js';

export function openaiError(message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, param: null, code } };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Receive every body as a Buffer (JSON parsing is chosen by content-type,
  // so non-JSON bodies such as multipart can be relayed unchanged).
  app.use(express.raw({ type: () => true, limit: '50mb' }));

  // ★ Log every incoming request + create the request ctx
  app.use((req, res, next) => {
    const id = req.get('x-client-request-id') || newRequestId();
    const rawBody = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;

    let body;
    const isJson = (req.headers['content-type'] ?? '').includes('json');
    if (rawBody && isJson) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json(openaiError('Received JSON body is not valid JSON.'));
      }
    }

    // Console-only view helper: which messages are new for this session (stateless clients resend everything).
    const delta = config.logBodies ? trackMessages({ headers: req.headers, body }) : null;
    req.ctx = { id, rawBody, body, messages: undefined, delta };
    logEvent('client_request', {
      id,
      method: req.method,
      path: req.originalUrl,
      headers: redactHeaders(req.headers),
      body: config.logBodies ? (body ?? (rawBody ? `<raw ${rawBody.length} bytes>` : undefined)) : undefined,
      delta,
    });
    next();
  });

  app.use('/v1', openaiRouter());

  // ── Operational endpoints ──
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), messagesStored: MessageStore.size() });
  });

  // Query the messages variables captured by the interceptor
  app.get('/admin/messages', (req, res) => {
    const n = Number(req.query.last ?? 20);
    res.json({ object: 'list', count: MessageStore.size(), data: MessageStore.recent(n) });
  });
  app.get('/admin/messages/:id', (req, res) => {
    const entry = MessageStore.get(req.params.id);
    if (!entry) return res.status(404).json(openaiError('No intercepted messages for this id.', 'invalid_request_error', 'not_found'));
    res.json(entry);
  });

  // 404 (OpenAI error format)
  app.use((req, res) => {
    res.status(404).json(openaiError(`Unknown route: ${req.method} ${req.originalUrl}`, 'invalid_request_error', 'not_found'));
  });

  // Error handler (OpenAI error format)
  app.use((err, req, res, _next) => {
    logEvent('gateway_error', { id: req.ctx?.id, message: String(err?.stack ?? err) });
    const status = err?.status ?? err?.statusCode ?? 500;
    res.status(status).json(openaiError(err?.message ?? 'Internal gateway error.', status >= 500 ? 'api_error' : 'invalid_request_error'));
  });

  return app;
}
