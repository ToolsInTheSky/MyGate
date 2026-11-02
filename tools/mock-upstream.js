// Local mock upstream for tests (minimal OpenAI-compatible surface).
// The chat/completions response content is "echo:<messages.length>" — used to verify the interceptor/mutations.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function startMockUpstream(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        const url = new URL(req.url, 'http://localhost');

        if (req.method === 'GET' && url.pathname === '/v1/models') {
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({
            object: 'list',
            data: [{ id: 'mock-gpt', object: 'model', created: 1_700_000_000, owned_by: 'mock' }],
          }));
        }

        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          const content = `echo:${body?.messages?.length ?? 0}`;
          if (body?.stream) {
            res.setHeader('content-type', 'text/event-stream');
            const mk = (delta, finish = null, usage) => ({
              id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1,
              model: 'mock-gpt',
              choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
              ...(usage ? { usage } : {}),
            });
            res.write(`data: ${JSON.stringify(mk({ role: 'assistant', content: '' }))}\n\n`);
            res.write(`data: ${JSON.stringify(mk({ content }))}\n\n`);
            res.write(`data: ${JSON.stringify(mk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }))}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: 'mock-gpt',
            choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, logprobs: null, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            // For verifying gateway key passthrough: the Authorization the upstream actually received
            mygate_test: { auth: req.headers.authorization ?? null },
          }));
        }

        if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({
            object: 'list', model: 'mock-embed',
            data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }));
        }

        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${url.pathname}`, type: 'invalid_request_error', param: null, code: null } }));
      });
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT || 11435);
  startMockUpstream(port).then(({ port: p }) => {
    console.log(`[mock-upstream] OpenAI-compatible mock on http://127.0.0.1:${p}/v1`);
  });
}
