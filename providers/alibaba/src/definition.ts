import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Provider definition for Alibaba Model Studio.
 *
 * Dual-protocol provider — exposes both an Anthropic-compatible and an
 * OpenAI-compatible inference endpoint. The two `endpoints` entries let
 * adapters choose whichever wire protocol they support.
 *
 * Model catalog is shared across both protocols: the same set of Qwen, GLM,
 * MiniMax, and Kimi models are accessible via either endpoint.
 * Credentials are resolved from `BAILIAN_CODING_PLAN_API_KEY`.
 *
 * `defaultModelFilterMode` is set to `'allowlist'` because this is a firehose
 * provider — models are hidden by default and must be explicitly allowed.
 */
export const providerDefinition: ProviderDefinitionInput = {
  id: 'alibaba',
  name: 'Alibaba Model Studio',
  description: 'Alibaba Model Studio — Anthropic and OpenAI compatible API',
  endpoints: {
    anthropic: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
    openai: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  },
  defaultModel: 'qwen3.5-plus',
  fastModel: 'minimax-m2.5',
  defaultModelFilterMode: 'allowlist',
  authMethods: [
    {
      id: 'api-key',
      mode: 'explicit',
      label: 'API key',
      fields: [
        {
          id: 'apiKey',
          label: 'API key',
          required: true,
          secret: true,
          sourceHints: [{ kind: 'environment', variable: 'BAILIAN_CODING_PLAN_API_KEY' }],
        },
      ],
    },
  ],
};
