# MyGate

**OpenAI-compatible AI gateway** built on Node.js + Express.
It inspects, mutates, and logs every request/response in the middle.

When viewing logs on screen, this project is convenient for observing a single session of the
Agent Communication Protocol (ACP).

---

```
client ──▶ MyGate (:8787) ──▶ upstream (OpenAI / Ollama / LM Studio / vLLM ...)
              │
              ├─ messages variable storage (MessageStore, /admin/messages)
              ├─ messages mutation (mutation pipeline)
              └─ full in/out JSONL logs (logs/)
```

## Quick start

```bash
npm install
cp .env.example .env   # set UPSTREAM_BASE_URL, UPSTREAM_API_KEY

npm start              # start the gateway (:8787, auto-loads .env)
npm start -- --verbose # same, plus per-request logs on the console
npm run mock           # (another window) local mock upstream :11435
npm test               # integration tests (including SDK compatibility)
```

SDK compatibility check: `test/sdk-compat.test.js` — proves that the Vercel AI SDK
(`ai` + `@ai-sdk/openai-compatible`, a devDependency) handles generateText/streamText
with only `baseURL=http://gate:8787/v1`.

Real-world test with the pi coding agent: [docs/pi-e2e-test.md](docs/pi-e2e-test.md)
(pi → gateway :8787 → strata :8081 wiring complete and verified)

Try it right away without an upstream:

```bash
npm run mock
UPSTREAM_BASE_URL=http://127.0.0.1:11435/v1 npm start
curl http://localhost:8787/v1/models
curl http://localhost:8787/admin/messages
```

## OpenAI-compatible endpoints

| Method | Path |
| --- | --- |
| GET | `/v1/models`, `/v1/models/{model}` |
| POST | `/v1/chat/completions` (SSE streaming relay) |
| POST | `/v1/completions` |
| POST | `/v1/embeddings` |
| POST | `/v1/responses` (+ GET/DELETE `/v1/responses/{id}`, `.../cancel`) |
| POST | `/v1/moderations` |
| *any* | `/v1/**` — future endpoints pass through automatically |

Operations: `GET /health`, `GET /admin/messages?last=20`, `GET /admin/messages/:id`

## messages variable & mutation

For every request, `messages` (chat) / `prompt` / `input` is **captured as a variable (`ctx.messages`)**,
the most recent N entries are kept in memory, and the original/mutated values are written to the log.

Mutations are registered as functions (`addRequestMutation` in `src/gateway/interceptor.js`):

```js
import { addRequestMutation } from './src/gateway/interceptor.js';

addRequestMutation(async (ctx) => {
  if (ctx.endpoint === 'chat.completions') {
    ctx.messages.unshift({ role: 'system', content: 'Always answer in Korean.' });
  }
});
```

The **response direction** can be mutated too (`addResponseMutation`; when no hook is registered,
bytes are relayed as-is):

```js
import { addResponseMutation } from './src/gateway/interceptor.js';

// non-stream: the whole response JSON / stream: per SSE chunk (preserves data:/[DONE] frames)
addResponseMutation(async (ctx, response) => {
  const delta = response.choices?.[0]?.delta ?? response.choices?.[0]?.message;
  if (delta?.content) delta.content = delta.content.toUpperCase();
});
```

### Mutation API

Both pipelines expose the same three functions:

| function | purpose |
| --- | --- |
| `addRequestMutation(fn)` / `addResponseMutation(fn)` | register a hook; returns an unsubscribe function |
| `hasRequestMutations()` / `hasResponseMutations()` | is any hook registered? |
| `applyRequestMutations(ctx)` / `applyResponseMutations(ctx, response)` | run every registered hook in order |

Hooks run in registration order. `ctx` carries `id`, `endpoint`, `body`, `headers`, `delta`,
and the captured `messages` variable. For responses, `response` is the whole response JSON
(non-stream) or a per-chunk object (stream).

The gateway loads `hooks/index.js` automatically at startup (no-op if the file is absent).
It currently registers `hooks/pi-agent-bridge.js`, which removes native tool-calling fields,
moves the tool definitions into the system message, and instructs the model to request one human-run
operation using `[(S)USERREQUEST]`/ `[(E)USERREQUEST]` blocks. 
Edit `hooks/systemprompt.txt` to change that protocol.

Other examples are included but disabled in `hooks/index.js`:

- `hooks/request-mutations.example.js` — exports `requestMutation` (2 logics: prepend system message + strip reasoning_content)
- `hooks/response-mutations.example.js` — exports `responseMutation` (2 logics: uppercase content + rewrite finish_reason)
- `hooks/request-mutation.example.js` — exports `requestMutation` (1 logic: append footer to last user message)
- `hooks/response-mutation.example.js` — exports `responseMutation` (1 logic: strip model field)
- `hooks/index.js` — registers the collaboration hook and contains commented registrations for the examples

To add or remove a logic, edit the function body in the matching file and its registration in `hooks/index.js`.

## API key passthrough

When the client sends `Authorization: Bearer <key>`, **the same key is forwarded to upstream**.
If no key is sent, `UPSTREAM_API_KEY` from `.env` is used as the fallback.

## Console logs (`--verbose`)

Per-request logs are printed to the console **only when the gateway is started with `--verbose`**
(alias `-v`). Without the flag only the startup banner and errors appear; the JSONL file is always written.

```bash
npm start -- --verbose
```

Agent clients such as ACP are stateless: every turn re-sends the full message history. To keep the
console readable, the gateway caches the last messages per session and prints only the messages added
since the previous turn of that session. The session key is taken from `session_id` (or `sessionId`,
`conversation_id`, `thread_id`, also under `metadata`), then from `x-session-id` / `x-acp-session-id` /
`x-conversation-id` headers, and finally from a fingerprint of the system + first user message.
The cache is an LRU (`lru-cache`, up to 500 sessions, 1 hour idle TTL).

```text
21:11:03.564 client_request    POST /v1/chat/completions id=ff7f5ea7
  {
    "model": "recursivesi/flint",
    "temperature": 0,
    "messages": [
      {
        "role": "user",
        "content": "next question"
      }
    ]
  }
  delta (1 new / 7 total, 6 already seen)
```

## Logging

Every event is recorded as JSONL in `logs/YYYY-MM-DD.log` (local date; the absolute path is printed at startup). With `--verbose` the console also prints a readable one-line summary plus pretty JSON (colors on a TTY; `NO_COLOR=1` disables them):

| type | content |
| --- | --- |
| `client_request` | client → gateway (method, path, headers [masked], body) |
| `request_intercepted` | captured messages, request mutation applied/none |
| `upstream_request` | gateway → upstream (URL, final body) |
| `upstream_received` | upstream response received (status, content preview) |
| `response_intercepted` | response mutation applied/none (mutated content shown when changed) |
| `client_response` | response sent to the client (for streams, accumulated content/usage summary) |
| `gateway_error` | exceptions |

### Event flow

```
client ──▶ gateway ──▶ upstream ──▶ gateway ──▶ client

[1] client_request       ← client sends POST /v1/chat/completions
[2] request_intercepted  ← messages captured, request mutation applied (if any)
[3] upstream_request     ← modified body forwarded to upstream
[4] upstream_received    ← upstream response received (status + content preview)
[5] response_intercepted ← response mutation applied (if any)
[6] client_response      ← full response relayed back to client (summary)
```

Mutations are split by direction: `addRequestMutation` (client → upstream) and
`addResponseMutation` (upstream → client), with matching `applyRequestMutations` /
`applyResponseMutations` and `hasRequestMutations` / `hasResponseMutations`.

The console shows configured headers and body metadata and truncates long `content` strings
at 1000 chars. `LOG_TOOLS` and `LOG_ACCUMULATED_MESSAGES` apply to both console and JSONL logs.

Sensitive headers such as `Authorization` are masked. Body logging can be disabled with `LOG_BODIES=false`.
Set `LOG_TOOLS=false` to omit `tools` from logged bodies, and `LOG_ACCUMULATED_MESSAGES=false`
to log only messages added since the previous turn instead of the accumulated history.

## Structure

```
src/
  index.js              entry point
  app.js                Express app, global middleware, /health, /admin
  config.js             environment variable config
  logger.js             JSONL + console logger
  gateway/
    interceptor.js      messages variable store + mutation pipeline
    proxy.js            upstream forwarding (SSE byte relay, response summary logs, provider registry integration)
  providers/
    registry.js         provider adapter registry (PROVIDER_ID selection, env fallback)
  routes/openai.js      /v1 routes (gate pipeline + catch-all passthrough)
  hooks/
    index.js                     entry point — loaded automatically by src/index.js (optional)
    request-mutations.example.js  request-side hook fn (2 logics)
    response-mutations.example.js response-side hook fn (2 logics)
    request-mutation.example.js   request-side hook fn (1 logic)
    response-mutation.example.js  response-side hook fn (1 logic)
  test/
  gateway.test.js       integration tests (node --test)
tools/
  mock-upstream.js      OpenAI-compatible mock server (npm run mock)
docs/
  specs/SPEC.md                project spec (approved) — success criteria, boundaries, decision log
  status.md                    status / current upstream / v2 candidates
  worklog.md                   worklog (newest at the bottom)
  openai-api-spec.md           OpenAI API spec summary (based on official docs)
  openai-compatibility.md      Ollama/LM Studio/vLLM/Azure compatibility matrix
  npm-libraries.md             research on npm libraries for an OpenAI-compatible setup
  pi-e2e-test.md               pi coding agent real-world test environment record
```

All main development documents live in `docs/`. See
[docs/status.md](docs/status.md) for status/current upstream and [docs/worklog.md](docs/worklog.md) for the work history.


## Design decisions

- Full compatibility via the **OpenAI error format** (`{error:{message,type,param,code}}`) and **preserving unknown fields**.
- SSE is relayed **byte-for-byte** without JSON re-serialization when no response mutation is registered (chunk boundaries preserved).
- API key is **passthrough**: the client key goes to upstream unchanged; the env key is the fallback.
- Future non-OpenAI providers (Anthropic, etc.) will be added as adapters under `src/providers/`.
