// ── request mutation hook (client → gateway → upstream) ──
// Contains 2 mutation logics in one function. hooks/index.js registers it
// via addRequestMutation. To add/remove a logic, edit this function body.
//
// This file does NOT overlap with request-mutation.example.js — that one
// appends to the last user message; this one prepends a system message and
// strips reasoning_content.

export const requestMutation = (ctx) => {
  // Logic 1: prepend a system message on every chat completion.
  if (ctx.endpoint !== 'chat.completions') return;
  if (!Array.isArray(ctx.messages)) return;
  ctx.messages.unshift({ role: 'system', content: 'Always answer in English.' });

  // Logic 2: strip reasoning_content from assistant messages before forwarding
  // (useful when the upstream model charges for reasoning tokens).
  for (const m of ctx.messages) {
    if (m.role === 'assistant' && m.reasoning_content !== undefined) {
      delete m.reasoning_content;
    }
  }
};