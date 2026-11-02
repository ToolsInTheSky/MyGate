// ── Example: single request mutation as a function ───────────────────────
// Edit the function body to customize. hooks/index.js registers this.
// Does NOT overlap with request-mutations.example.js — that one prepends a
// system message and strips reasoning_content; this one appends a footer to
// the last user message.

export const requestMutation = (ctx) => {
  if (ctx.endpoint !== 'chat.completions') return;
  if (!Array.isArray(ctx.messages)) return;
  const last = ctx.messages[ctx.messages.length - 1];
  if (last && last.role === 'user' && typeof last.content === 'string') {
    last.content += '\n\n[Answer concisely.]';
  }
};