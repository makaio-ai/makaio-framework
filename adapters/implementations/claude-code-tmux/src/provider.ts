/**
 * Provider IDs and preset configuration for the Claude Code tmux adapter.
 *
 * Same providers as the CLI adapter — both use Claude Code which authenticates
 * via the Anthropic API. The tmux adapter just runs interactively instead of
 * via stdio JSON streaming.
 */
import { defineAdapterProviderAuth, type AdapterProviderAuth } from '@makaio/contracts';

export const providerIds = ['anthropic', 'anthropic-oauth'] as const;

type ProviderId = (typeof providerIds)[number];

const CLAUDE_CODE_TMUX_AUTH_SCRUB_ENV_VARS = [
  'ANTHROPIC_API_KEY',
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

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {
  anthropic: defineAdapterProviderAuth({
    bindings: [
      {
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        deliveries: [{ kind: 'process-env', fields: { apiKey: 'ANTHROPIC_API_KEY' } }],
      },
    ],
    scrubEnvVars: CLAUDE_CODE_TMUX_AUTH_SCRUB_ENV_VARS,
  }),
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
    scrubEnvVars: CLAUDE_CODE_TMUX_AUTH_SCRUB_ENV_VARS,
  }),
} satisfies Record<ProviderId, AdapterProviderAuth>;

/** Default provider when no explicit provider is configured. */
export const defaultPresetId = 'anthropic';

/** Provider used for conformance tests through the Claude Code client auth context. */
export const testPresetId: (typeof providerIds)[number] = 'anthropic-oauth';
