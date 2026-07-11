/**
 * Provider IDs and preset configuration for the Qwen ACP adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 */
import type { AdapterProviderAuth } from '@makaio/contracts';

/** No production provider is advertised until Qwen auth can be isolated safely. */
export const providerIds = [] as const;

type ProviderId = (typeof providerIds)[number];

export const QWEN_ACP_AUTH_SCRUB_ENV_VARS = [
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
] as const;

/** Validated authentication metadata keyed by supported provider definition ID. */
export const providerAuthById = {} satisfies Record<ProviderId, AdapterProviderAuth>;
