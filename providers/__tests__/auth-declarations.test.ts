import { ProviderDefinitionSchema } from '@makaio/contracts';
import { describe, expect, it } from 'vitest';
import { providerDefinition as alibabaDefinition } from '../alibaba/src/definition.js';
import {
  providerDefinition as anthropicDefinition,
  providerDefinitionOAuth as anthropicOAuthDefinition,
} from '../anthropic/src/index.js';
import { providerDefinition as cursorDefinition } from '../cursor/src/definition.js';
import { providerDefinition as githubCopilotDefinition } from '../github-copilot/src/definition.js';
import { providerDefinition as googleDefinition } from '../google/src/index.js';
import { providerDefinition as kimiDefinition } from '../kimi/src/definition.js';
import { providerDefinition as nanogptDefinition } from '../nanogpt/src/definition.js';
import { providerDefinition as openaiDefinition } from '../openai/src/definition.js';
import { providerDefinition as openaiCodexDefinition } from '../openai-codex/src/definition.js';
import {
  anthropicProviderDefinition as opencodeGoAnthropicDefinition,
  openaiProviderDefinition as opencodeGoDefinition,
} from '../opencode-go/src/definition.js';
import { providerDefinition as openrouterDefinition } from '../openrouter/src/definition.js';
import { providerDefinition as qwenOAuthDefinition } from '../qwen/src/definition.js';
import { providerDefinition as zAiDefinition } from '../z-ai/src/definition.js';

const explicitProviderMatrix = [
  [alibabaDefinition, 'api-key', 'apiKey', 'BAILIAN_CODING_PLAN_API_KEY'],
  [anthropicDefinition, 'api-key', 'apiKey', 'ANTHROPIC_API_KEY'],
  [cursorDefinition, 'api-key', 'apiKey', 'CURSOR_API_KEY'],
  [githubCopilotDefinition, 'token', 'token', 'COPILOT_TOKEN'],
  [googleDefinition, 'api-key', 'apiKey', 'GEMINI_API_KEY'],
  [kimiDefinition, 'api-key', 'apiKey', 'KIMI_API_KEY'],
  [nanogptDefinition, 'api-key', 'apiKey', 'NANOGPT_API_KEY'],
  [openaiDefinition, 'api-key', 'apiKey', 'OPENAI_API_KEY'],
  [openaiCodexDefinition, 'api-key', 'apiKey', 'OPENAI_API_KEY'],
  [opencodeGoDefinition, 'api-key', 'apiKey', 'OPENCODE_GO_API_KEY'],
  [opencodeGoAnthropicDefinition, 'api-key', 'apiKey', 'OPENCODE_GO_API_KEY'],
  [openrouterDefinition, 'api-key', 'apiKey', 'OPENROUTER_API_KEY'],
  [zAiDefinition, 'api-key', 'apiKey', 'Z_AI_API_KEY'],
] as const;

describe('first-party provider auth declarations', () => {
  it.each(
    explicitProviderMatrix,
  )('$0.id declares $1 with its explicit credential source', (definition, methodId, fieldId, sourceVariable) => {
    const parsedDefinition = ProviderDefinitionSchema.parse(definition);

    expect(parsedDefinition.authMethods).toEqual([
      {
        id: methodId,
        mode: 'explicit',
        label: methodId === 'token' ? 'Token' : 'API key',
        fields: [
          {
            id: fieldId,
            label: methodId === 'token' ? 'Token' : 'API key',
            required: true,
            secret: true,
            sourceHints: [{ kind: 'environment', variable: sourceVariable }],
          },
        ],
      },
    ]);
  });

  it.each([anthropicOAuthDefinition, qwenOAuthDefinition])('$id leaves authentication to its client', (definition) => {
    expect(() => ProviderDefinitionSchema.parse(definition)).not.toThrow();
    expect(definition.authMethods).toEqual([]);
  });
});
