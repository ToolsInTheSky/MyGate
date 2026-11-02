// ── response mutation hook (upstream → gateway → client) ──
// Contains 2 mutation logics in one function. hooks/index.js registers it
// via addResponseMutation.
//
// response is the whole response JSON (non-stream) or a per-chunk object (stream).

export const responseMutation = (ctx, response) => {
  // Logic 1: uppercase the content of every streamed token.
  if (typeof response?.content !== 'string') return;
  response.content = response.content.toUpperCase();

  // Logic 2: rewrite the finish_reason on non-stream responses.
  if (ctx.endpoint !== 'chat.completions') return;
  const choice = response?.choices?.[0];
  if (choice && choice.finish_reason === 'stop') {
    choice.finish_reason = 'length';
  }
};