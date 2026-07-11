/**
 * Provider IDs and preset configuration for the Claude Code (Agent SDK) adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time. Edit provider packages and registry YAML, not
 * generated artifacts.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['anthropic', 'anthropic-oauth', 'z-ai', 'kimi', 'opencode-go-anthropic'] as const;

type ProviderId = (typeof providerIds)[number];
type ApiKeyProviderId = Exclude<ProviderId, 'anthropic-oauth'>;

const CLAUDE_AGENT_SDK_AUTH_SCRUB_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'Z_AI_API_KEY',
  'KIMI_API_KEY',
  'OPENCODE_GO_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_AWS_API_KEY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
] as const;

/**
 * Define Claude Code process delivery for a provider-owned API key.
 * @param providerDefinitionId - Provider definition that owns the API-key method.
 * @returns Validated adapter/provider authentication metadata.
 */
function defineProviderApiKeyAuth(providerDefinitionId: ApiKeyProviderId): AdapterProviderAuth {
  return defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId, methodId: 'api-key' },
        deliveries: [{ kind: 'process-env', fields: { apiKey: 'ANTHROPIC_API_KEY' } }],
      },
    ],
    scrubEnvVars: CLAUDE_AGENT_SDK_AUTH_SCRUB_ENV_VARS,
  });
}

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  anthropic: defineProviderApiKeyAuth('anthropic'),
  'anthropic-oauth': defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
        deliveries: [{ kind: 'native-client', clientId: 'claude-code' }],
      },
      {
        method: { owner: 'client', clientId: 'claude-code', methodId: 'oauth-token' },
        deliveries: [{ kind: 'process-env', fields: { oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' } }],
      },
    ],
    scrubEnvVars: CLAUDE_AGENT_SDK_AUTH_SCRUB_ENV_VARS,
  }),
  'z-ai': defineProviderApiKeyAuth('z-ai'),
  kimi: defineProviderApiKeyAuth('kimi'),
  'opencode-go-anthropic': defineProviderApiKeyAuth('opencode-go-anthropic'),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/**
 * Default provider id to use when no provider is explicitly configured.
 */
export const defaultPresetId = 'anthropic';

/** Provider id used for conformance tests through the Claude Code client auth context. */
export const testPresetId = 'anthropic-oauth';
