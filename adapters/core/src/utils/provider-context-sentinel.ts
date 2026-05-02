import type { ProviderContext } from '@makaio/contracts';

/**
 * Sentinel definitionId used when the orchestrator did not resolve a real
 * provider. Adapters that encounter this know credentials are absent and
 * can decide whether to proceed (e.g. local CLI adapters) or warn.
 */
export const UNRESOLVED_PROVIDER_DEFINITION_ID = 'unresolved';

/**
 * Create a minimal sentinel provider context for adapter paths that bypass
 * orchestrator credential resolution.
 *
 * The sentinel carries `credentialRefs: {}` — no API key or endpoint.
 * This does **not** necessarily mean the adapter cannot authenticate:
 *
 * - **SDK adapters** (anthropic-sdk, openai-node, gemini-sdk) fall back to
 * environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).
 * The sentinel is transparent — if env vars are configured, the adapter
 * works without orchestrator-injected credentials.
 * - **Local CLI adapters** (claude-code-cli, codex-app-server) resolve
 * credentials from local tooling and ignore the sentinel entirely.
 * - **Rehydration paths** use the sentinel temporarily until the persisted
 * `providerConfigId` is re-resolved via {@link buildProviderContext}.
 *
 * Resolution chain when `providerConfigId` is omitted from `AgentSelection`:
 *
 * 1. Explicit `providerConfigId` on the wire → `buildProviderContext()`
 * → credential refs forwarded to connector
 * 2. Persona/profile/virtualModel resolution may produce a `providerConfigId`
 * from the resolved entity
 * 3. Neither → sentinel → adapter falls back to env vars or local tooling
 * @returns Fresh sentinel context — not shared, safe to mutate.
 */
export function createSentinelProviderContext(): ProviderContext {
  return {
    providerConfigId: 'sentinel',
    definitionId: UNRESOLVED_PROVIDER_DEFINITION_ID,
    credentialRefs: {},
  };
}
