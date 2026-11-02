// ── Example: single response mutation as a function ──────────────────────
// Edit the function body to customize. hooks/index.js registers this.
// Does NOT overlap with response-mutations.example.js — that one uppercases
// content and rewrites finish_reason; this one strips the model field.

export const responseMutation = (ctx, response) => {
  if (response && typeof response === 'object') {
    delete response.model;
  }
};