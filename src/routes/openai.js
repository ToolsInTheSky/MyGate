// /v1 OpenAI-compatible routes. Every route goes through the gate() pipeline:
//   create ctx → intercept messages (store/mutate/log the variable) → forward upstream
import { Router } from 'express';
import { interceptRequest } from '../gateway/interceptor.js';
import { forward } from '../gateway/proxy.js';

function gate(endpoint) {
  return [
    (req, res, next) => {
      req.ctx.endpoint = endpoint;
      next();
    },
    async (req, res, next) => {
      try {
        if (req.ctx.body) await interceptRequest(req.ctx);
        next();
      } catch (err) {
        next(err);
      }
    },
    forward,
  ];
}

export function openaiRouter() {
  const router = Router();

  router.get('/models', gate('models'));
  router.get('/models/:model', gate('models.get'));
  router.post('/chat/completions', gate('chat.completions'));
  router.post('/completions', gate('completions'));
  router.post('/embeddings', gate('embeddings'));
  router.post('/responses', gate('responses'));
  router.get('/responses/:responseId', gate('responses.get'));
  router.delete('/responses/:responseId', gate('responses.delete'));
  router.post('/responses/:responseId/cancel', gate('responses.cancel'));
  router.post('/moderations', gate('moderations'));

  // Pass through every /v1 endpoint added in the future (audio, files, batch, ...)
  router.use(gate('passthrough'));

  return router;
}
