// Global config. Environment variables take precedence; defaults target local development.
const env = process.env;

export const config = {
  port: Number(env.PORT || 8787),

  // Upstream OpenAI-compatible server. The base path includes /v1.
  // e.g. https://api.openai.com/v1, http://localhost:11434/v1, http://localhost:1234/v1
  upstreamBaseUrl: env.UPSTREAM_BASE_URL || 'https://api.openai.com/v1',
  upstreamApiKey: env.UPSTREAM_API_KEY || '',

  logDir: env.LOG_DIR || 'logs',
  logBodies: env.LOG_BODIES !== 'false',
  logHeaders: env.LOG_HEADERS !== 'false',

  // Capacity of the variable store that keeps messages captured by the interceptor
  messageStoreSize: Number(env.MESSAGE_STORE_SIZE || 200),

  // Upstream call timeout (ms)
  upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 120_000),
};
