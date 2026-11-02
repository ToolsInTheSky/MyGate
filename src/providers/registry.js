// Provider adapter registry (SPEC success criterion 4).
// Provider = { id, name, baseUrl, apiKey? }
//
// - baseUrl: includes /v1 in the base path (https://api.openai.com/v1, http://host:port/v1)
// - apiKey:  fallback key used when the client sends no Authorization (passthrough, SPEC decision 1)
// - mapRequest/mapResponse: request/response transform hooks for adding non-OpenAI providers (Anthropic, etc.).
//   Unused in v1, which has a single OpenAI-compatible upstream (multi-routing is out of scope for v2, SPEC decision 4).
//
// The active provider is selected per request via the env PROVIDER_ID (default: 'openai-compatible').
// The default provider uses UPSTREAM_BASE_URL/UPSTREAM_API_KEY from .env as-is, so behavior is
// identical to before (env loaded at startup).
import { config } from '../config.js';

const providers = new Map();

// Default: OpenAI-compatible provider (existing .env values as-is)
providers.set('openai-compatible', {
  id: 'openai-compatible',
  name: 'OpenAI-compatible (env)',
  baseUrl: config.upstreamBaseUrl,
  apiKey: config.upstreamApiKey,
});

export function registerProvider(provider) {
  if (!provider?.id || !provider.baseUrl) {
    throw new Error('provider requires id and baseUrl');
  }
  providers.set(provider.id, provider);
  return () => providers.delete(provider.id);
}

export function getActive() {
  const id = process.env.PROVIDER_ID || 'openai-compatible';
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function listProviders() {
  return [...providers.values()].map(({ id, name, baseUrl }) => ({ id, name, baseUrl }));
}
