import { describe, expect, it } from 'vitest';
import type {
  AdapterAuthBinding,
  AdapterProviderAuth,
  ClientAuthMethodDefinition,
  ProviderAuthMethodDefinition,
} from '@makaio/contracts';
import { clientDefinition as claudeCodeClientDefinition } from '../../clients/claude-code/src/definition.js';
import { clientDefinition as codexClientDefinition } from '../../clients/codex/src/definition.js';
import { providerDefinition as alibabaProviderDefinition } from '../../providers/alibaba/src/definition.js';
import { providerDefinition as anthropicProviderDefinition } from '../../providers/anthropic/src/definition.js';
import { providerDefinition as cursorProviderDefinition } from '../../providers/cursor/src/definition.js';
import { providerDefinition as githubCopilotProviderDefinition } from '../../providers/github-copilot/src/definition.js';
import { providerDefinition as googleProviderDefinition } from '../../providers/google/src/definition.js';
import { providerDefinition as kimiProviderDefinition } from '../../providers/kimi/src/definition.js';
import { providerDefinition as nanogptProviderDefinition } from '../../providers/nanogpt/src/definition.js';
import {
  anthropicProviderDefinition as opencodeGoAnthropicProviderDefinition,
  openaiProviderDefinition as opencodeGoProviderDefinition,
} from '../../providers/opencode-go/src/definition.js';
import { providerDefinition as openaiCodexProviderDefinition } from '../../providers/openai-codex/src/definition.js';
import { providerDefinition as openaiProviderDefinition } from '../../providers/openai/src/definition.js';
import { providerDefinition as openrouterProviderDefinition } from '../../providers/openrouter/src/definition.js';
import { providerDefinition as zAiProviderDefinition } from '../../providers/z-ai/src/definition.js';
import { adapterDefinition as anthropicSdk } from './anthropic-sdk/src/definition.js';
import { adapterDefinition as claudeAgentSdk } from './claude-agent-sdk/src/definition.js';
import { adapterDefinition as claudeCodeCli } from './claude-code-cli/src/definition.js';
import { adapterDefinition as claudeCodeTmux } from './claude-code-tmux/src/definition.js';
import { adapterDefinition as codexAppServer } from './codex-app-server/src/definition.js';
import { adapterDefinition as cursorSdk } from './cursor-sdk/src/definition.js';
import { adapterDefinition as geminiSdk } from './gemini-sdk/src/definition.js';
import { GEMINI_SDK_SENSITIVE_ENV_VARS } from './gemini-sdk/src/gemini-sdk-environment.js';
import { adapterDefinition as githubCopilotSdk } from './github-copilot-sdk/src/definition.js';
import { adapterDefinition as openaiNode } from './openai-node/src/definition.js';
import { adapterDefinition as piSdk } from './pi-sdk/src/definition.js';

interface DefinitionWithProviderAuth {
  readonly name: string;
  readonly providers: readonly {
    readonly definitionId: string;
    readonly auth?: AdapterProviderAuth;
  }[];
}

interface AuthCatalogDefinition {
  readonly id: string;
  readonly authMethods?: readonly (ClientAuthMethodDefinition | ProviderAuthMethodDefinition)[];
}

const adapterDefinitions: readonly DefinitionWithProviderAuth[] = [
  anthropicSdk,
  openaiNode,
  claudeAgentSdk,
  claudeCodeCli,
  claudeCodeTmux,
  codexAppServer,
  cursorSdk,
  geminiSdk,
  githubCopilotSdk,
  piSdk,
];

const providerAuthCatalogDefinitions: readonly AuthCatalogDefinition[] = [
  alibabaProviderDefinition,
  anthropicProviderDefinition,
  cursorProviderDefinition,
  githubCopilotProviderDefinition,
  googleProviderDefinition,
  kimiProviderDefinition,
  nanogptProviderDefinition,
  opencodeGoAnthropicProviderDefinition,
  opencodeGoProviderDefinition,
  openaiCodexProviderDefinition,
  openaiProviderDefinition,
  openrouterProviderDefinition,
  zAiProviderDefinition,
];

const clientAuthCatalogDefinitions: readonly AuthCatalogDefinition[] = [
  claudeCodeClientDefinition,
  codexClientDefinition,
];

const providerAuthCatalog = new Map(
  providerAuthCatalogDefinitions.map((definition): readonly [string, AuthCatalogDefinition] => [
    definition.id,
    definition,
  ]),
);

const clientAuthCatalog = new Map(
  clientAuthCatalogDefinitions.map((definition): readonly [string, AuthCatalogDefinition] => [
    definition.id,
    definition,
  ]),
);

/**
 * Read required auth metadata from one adapter/provider ref.
 * @param definition - Adapter definition that owns the provider ref.
 * @param providerDefinitionId - Provider ref to locate.
 * @returns Attached validated authentication metadata.
 */
function getAuth(definition: DefinitionWithProviderAuth, providerDefinitionId: string): AdapterProviderAuth {
  const provider = definition.providers.find(({ definitionId }) => definitionId === providerDefinitionId);
  if (!provider?.auth) {
    throw new Error(`${definition.name}/${providerDefinitionId} is missing auth metadata`);
  }
  return provider.auth;
}

/**
 * Resolve a binding method against its canonical exported provider or client definition.
 * @param binding - Adapter binding whose method reference must resolve.
 * @returns Canonical catalog method referenced by the binding.
 */
function getCatalogAuthMethod(binding: AdapterAuthBinding): ClientAuthMethodDefinition | ProviderAuthMethodDefinition {
  const { method } = binding;
  const definition =
    method.owner === 'provider'
      ? providerAuthCatalog.get(method.providerDefinitionId)
      : clientAuthCatalog.get(method.clientId);
  const definitionId = method.owner === 'provider' ? method.providerDefinitionId : method.clientId;
  if (!definition) {
    throw new Error(`Missing exported ${method.owner} auth catalog definition "${definitionId}"`);
  }

  const authMethod = definition.authMethods?.find(({ id }) => id === method.methodId);
  if (!authMethod) {
    throw new Error(`Missing ${method.owner} auth method "${definitionId}/${method.methodId}"`);
  }
  return authMethod;
}

/**
 * Build the expected provider-owned API-key binding for one connector target.
 * @param providerDefinitionId - Provider definition that owns the API-key method.
 * @param target - Adapter-owned connector operation.
 * @param fieldName - Connector field receiving the API key.
 * @param constants - Optional connector constants delivered alongside the key.
 * @returns Expected API-key binding.
 */
function connectorApiKeyBinding(
  providerDefinitionId: string,
  target: string,
  fieldName = 'apiKey',
  constants?: Readonly<Record<string, string | null>>,
): AdapterAuthBinding {
  return {
    method: { owner: 'provider', providerDefinitionId, methodId: 'api-key' },
    deliveries: [
      {
        kind: 'connector',
        target,
        fields: { apiKey: fieldName },
        ...(constants ? { constants } : {}),
      },
    ],
  };
}

const claudeClientBindings: readonly AdapterAuthBinding[] = [
  {
    method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
    deliveries: [{ kind: 'native-client', clientId: 'claude-code' }],
  },
  {
    method: { owner: 'client', clientId: 'claude-code', methodId: 'oauth-token' },
    deliveries: [{ kind: 'process-env', fields: { oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' } }],
  },
];

const claudeAuthControls = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
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

describe('adapter provider auth declarations', () => {
  it('attaches validated auth metadata to every supported provider ref', () => {
    for (const definition of adapterDefinitions) {
      expect(definition.providers, definition.name).not.toHaveLength(0);
      for (const provider of definition.providers) {
        expect(provider.auth, `${definition.name}/${provider.definitionId}`).toBeDefined();
      }
    }
  });

  it('resolves every binding method and delivered credential field against exported auth catalogs', () => {
    for (const definition of adapterDefinitions) {
      for (const provider of definition.providers) {
        for (const binding of getAuth(definition, provider.definitionId).bindings) {
          const authMethod = getCatalogAuthMethod(binding);
          const declaredFieldIds = authMethod.mode === 'explicit' ? authMethod.fields.map(({ id }) => id) : [];
          const deliveredFieldIds = new Set(
            binding.deliveries.flatMap((delivery) =>
              delivery.kind === 'process-env' || delivery.kind === 'connector' ? Object.keys(delivery.fields) : [],
            ),
          );

          expect(
            [...deliveredFieldIds].sort(),
            `${definition.name}/${provider.definitionId}/${binding.method.owner}:${binding.method.methodId}`,
          ).toEqual([...declaredFieldIds].sort());
        }
      }
    }
  });

  it('maps direct SDK API keys to deterministic constructor fields', () => {
    for (const providerDefinitionId of ['z-ai', 'alibaba', 'opencode-go-anthropic', 'anthropic']) {
      expect(getAuth(anthropicSdk, providerDefinitionId).bindings).toEqual([
        connectorApiKeyBinding(providerDefinitionId, 'anthropic-sdk.constructor', 'apiKey', { authToken: null }),
      ]);
    }

    for (const providerDefinitionId of ['openai', 'nanogpt', 'openrouter', 'z-ai', 'alibaba', 'opencode-go']) {
      expect(getAuth(openaiNode, providerDefinitionId).bindings).toEqual([
        connectorApiKeyBinding(providerDefinitionId, 'openai-node.constructor', 'apiKey', { adminAPIKey: null }),
      ]);
    }
  });

  it('maps all Claude provider and client methods to their process or native sink', () => {
    const apiKeyMatrix: ReadonlyArray<readonly [DefinitionWithProviderAuth, readonly string[]]> = [
      [claudeAgentSdk, ['anthropic', 'z-ai', 'kimi', 'opencode-go-anthropic']],
      [claudeCodeCli, ['anthropic', 'opencode-go-anthropic']],
      [claudeCodeTmux, ['anthropic']],
    ];

    for (const [definition, providerDefinitionIds] of apiKeyMatrix) {
      for (const providerDefinitionId of providerDefinitionIds) {
        expect(getAuth(definition, providerDefinitionId).bindings).toEqual([
          {
            method: { owner: 'provider', providerDefinitionId, methodId: 'api-key' },
            deliveries: [{ kind: 'process-env', fields: { apiKey: 'ANTHROPIC_API_KEY' } }],
          },
        ]);
      }
      expect(getAuth(definition, 'anthropic-oauth').bindings).toEqual(claudeClientBindings);
    }
  });

  it('declares Codex native, access-token, and API-key RPC delivery separately', () => {
    expect(getAuth(codexAppServer, 'openai-codex').bindings).toEqual([
      {
        method: { owner: 'client', clientId: 'codex', methodId: 'native' },
        deliveries: [{ kind: 'native-client', clientId: 'codex' }],
      },
      {
        method: { owner: 'client', clientId: 'codex', methodId: 'access-token' },
        deliveries: [{ kind: 'process-env', fields: { accessToken: 'CODEX_ACCESS_TOKEN' } }],
      },
      {
        method: { owner: 'provider', providerDefinitionId: 'openai-codex', methodId: 'api-key' },
        deliveries: [
          {
            kind: 'connector',
            target: 'codex.account-login.api-key',
            fields: { apiKey: 'apiKey' },
            constants: { type: 'apiKey' },
          },
        ],
      },
    ]);
  });

  it('targets the concrete Cursor, Gemini, Copilot, Pi, and native OAuth operations', () => {
    expect(getAuth(cursorSdk, 'cursor').bindings).toEqual([
      connectorApiKeyBinding('cursor', 'cursor-sdk.agent-create'),
    ]);
    expect(getAuth(geminiSdk, 'google').bindings).toEqual([
      connectorApiKeyBinding('google', 'gemini-sdk.refresh-auth'),
    ]);
    expect(getAuth(githubCopilotSdk, 'github-copilot').bindings).toEqual([
      {
        method: { owner: 'provider', providerDefinitionId: 'github-copilot', methodId: 'token' },
        deliveries: [
          {
            kind: 'connector',
            target: 'github-copilot-sdk.constructor',
            fields: { token: 'githubToken' },
          },
        ],
      },
    ]);
    for (const providerDefinitionId of ['anthropic', 'openai', 'opencode-go']) {
      expect(getAuth(piSdk, providerDefinitionId).bindings).toEqual([
        connectorApiKeyBinding(providerDefinitionId, 'pi-sdk.provider-auth'),
      ]);
    }
  });

  it('scrubs every declared process sink and documented competing auth control', () => {
    const definitions = [claudeAgentSdk, claudeCodeCli, claudeCodeTmux, codexAppServer];
    for (const definition of definitions) {
      for (const provider of definition.providers) {
        const auth = getAuth(definition, provider.definitionId);
        const processSinks = auth.bindings.flatMap(({ deliveries }) =>
          deliveries.flatMap((delivery) => (delivery.kind === 'process-env' ? Object.values(delivery.fields) : [])),
        );
        expect(auth.scrubEnvVars, `${definition.name}/${provider.definitionId}`).toEqual(
          expect.arrayContaining(processSinks),
        );
      }
    }

    for (const definition of [claudeAgentSdk, claudeCodeCli, claudeCodeTmux]) {
      for (const provider of definition.providers) {
        expect(getAuth(definition, provider.definitionId).scrubEnvVars).toEqual(
          expect.arrayContaining([...claudeAuthControls]),
        );
      }
    }

    expect(getAuth(codexAppServer, 'openai-codex').scrubEnvVars).toEqual(
      expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']),
    );
  });

  it('scrubs the complete Gemini ambient credential set', () => {
    for (const provider of geminiSdk.providers) {
      expect([...getAuth(geminiSdk, provider.definitionId).scrubEnvVars].sort()).toEqual(
        [...GEMINI_SDK_SENSITIVE_ENV_VARS].sort(),
      );
    }
  });
});
