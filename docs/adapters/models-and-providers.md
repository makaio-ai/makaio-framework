---
title: Models & Providers
description: Configure AI models, providers, and credentials in the Makaio Framework.
---

Models and providers are the configuration layer between adapters and AI services. A
`ProviderDefinition` declares what an AI service offers — its endpoints, default models,
and credential conventions. A `ProviderConfig` binds user credentials and settings to a
definition. Canonical model names let you address any model through a unified string
format that the framework resolves to the right adapter and provider at runtime.

## Canonical Model Names

The framework uses a single string format to address any model:

```
canonical          := "~" virtual_model_name
                    | routing "::" model_name
                    | model_name

routing            := segment
                    | segment "/" segment

segment            := [a-z0-9][a-z0-9._-]*
model_name         := <any non-empty string>
virtual_model_name := [a-z0-9][a-z0-9_-]*
```

### Canonical string forms

| Format | Example | Resolves to |
|--------|---------|-------------|
| Bare | `sonnet` | Default adapter for this model |
| Qualified | `anthropic::sonnet` | Explicit provider routing |
| Qualified (full) | `openai-node/openai::gpt-5.2` | Explicit adapter + provider |
| Virtual | `~my-alias` | Host-defined alias |

More examples:

- `gpt-5.2` — default OpenAI adapter
- `gemini-2.5-pro` — Google AI adapter
- `anthropic::sonnet` — explicit Anthropic provider
- `openai-node/openai::gpt-5.2` — explicit adapter and provider

Routing segments are lowercased during parsing. Model names are passed through verbatim
because provider model identifiers are case-sensitive.

### Usage in code

Via the TypeScript SDK:

```ts
const response = await client.request(SessionSubjects.sendMessage, {
  sessionId: crypto.randomUUID(),
  agent: { kind: 'canonical-model', model: 'claude-code::haiku' },
  message: 'Hello!',
});
```

Via the prompt extension CLI:

```bash
makaio prompt send "What is 2+2?" --model sonnet
makaio prompt send "Hello" -m openai-node/openai::gpt-5.2
```

### Parse result types

`parseCanonicalModel()` returns one of:

```ts
{ kind: 'bare';     model: string }
{ kind: 'qualified'; segment1: string; segment2?: string; model: string }
{ kind: 'virtual';  name: string }
```

A `{ kind: 'parse-error'; code: string; message: string; input: string }` is returned
for invalid input. Use `isCanonicalModelParseError()` to narrow the result.

Source: `@makaio/contracts` — `parseCanonicalModel()` and `isCanonicalModelParseError()`
from `contracts/canonical-model`.

## Provider Definitions

A `ProviderDefinition` is a static declaration of an AI inference provider. Adapters
declare which providers they serve; the framework resolves models and credentials through
these definitions.

```ts
interface ProviderDefinition {
  id: string;           // Stable identifier (e.g., 'anthropic', 'openai')
  name: string;         // Display name
  description?: string;
  endpoints?: {
    anthropic?: string; // Anthropic Messages API base URL
    openai?: string;    // OpenAI Chat Completions API base URL
  };
  defaultModel?: string;           // Default model for general tasks
  fastModel?: string;              // Fast/cheap model for background work
  defaultModelFilterMode?: 'show-all' | 'allowlist';
  availableModels: AIModel[];      // Populated at runtime from model registry
  credentialEnvVars?: Record<string, string>; // Credential field → env var
}
```

`availableModels` defaults to `[]` in parsed definitions — the registry service populates
it from the YAML model catalog at boot. Static provider packages use `ProviderDefinitionInput`
and omit this field.

Example — Anthropic:

```ts
{
  id: 'anthropic',
  name: 'Anthropic',
  description: 'Official Anthropic API',
  endpoints: { anthropic: 'https://api.anthropic.com' },
  defaultModel: 'claude-sonnet-4-6',
  fastModel: 'claude-haiku-4-5',
  credentialEnvVars: { apiKey: 'ANTHROPIC_API_KEY' },
}
```

Example — Z.AI (dual-protocol provider exposing both wire formats):

```ts
{
  id: 'z-ai',
  name: 'Z.AI (GLM)',
  endpoints: {
    anthropic: 'https://api.z.ai/api/anthropic',
    openai: 'https://api.z.ai/api/openai',
  },
  credentialEnvVars: { apiKey: 'Z_AI_API_KEY' },
}
```

Example — GitHub Copilot (SDK-only provider, no HTTP endpoints):

```ts
{
  id: 'github-copilot',
  name: 'GitHub Copilot',
  credentialEnvVars: { token: 'COPILOT_TOKEN' },
  // endpoints intentionally omitted — uses proprietary SDK transport
}
```

Provider definitions are contributed by provider extensions and discovered during boot. Adapters
declare the provider definition IDs they support.

## Provider Configs

A `ProviderConfigFile` binds user credentials and settings to a provider definition.

```ts
interface ProviderConfigFile {
  $schema: 'makaio/provider-config/v1';
  definitionId: string;                          // Reference to ProviderDefinition.id
  name?: string;                                 // Display override
  credentials?: Record<string, CredentialRef>;   // Bound credentials
  endpointOverrides?: {
    anthropic?: string;
    openai?: string;
  };
  modelFilterMode?: 'show-all' | 'allowlist';
  modelVisibility?: Record<string, ModelVisibility>;
  isSentinel?: boolean;
  isDefault?: boolean;
  enabled?: boolean;
}
```

Files are stored at: `$MAKAIO_HOME/provider-configs/<providerConfigId>.json`

`CredentialRef` is a typed string with prefixes such as `env:VAR`, `keychain:service:account`,
`file:/path`, `stored:providerConfig:<configId>:<key>`, or
`account-manager:["<clientId>","<accountId>"]`. Plaintext secrets never appear in config files.

## Credentials

Providers declare which environment variables hold credentials via `credentialEnvVars` in
their definition. The framework reads these as a last-resort fallback when credentials are
not provided via saved config or runtime input.

| Provider | Credential field | Environment variable |
|----------|-----------------|---------------------|
| Anthropic | `apiKey` | `ANTHROPIC_API_KEY` |
| OpenAI | `apiKey` | `OPENAI_API_KEY` |
| OpenRouter | `apiKey` | `OPENROUTER_API_KEY` |
| GitHub Copilot | `token` | `COPILOT_TOKEN` |
| Google AI | `apiKey` | `GEMINI_API_KEY` |
| Z.AI | `apiKey` | `Z_AI_API_KEY` |
| Alibaba Model Studio | `apiKey` | `BAILIAN_CODING_PLAN_API_KEY` |

Providers that use the framework's credential service for OAuth flows (such as
`anthropic-oauth`) intentionally omit `credentialEnvVars` — they do not accept raw
API keys and have no env var fallback.

For subprocess adapters, `buildCredentialEnv()` transforms resolved credentials into
environment variables before spawning the child process.

## Model Registry

Models are not baked into adapter packages. The model registry is populated dynamically at
boot from multiple sources, tried in this order:

1. User overlay directory (`$MAKAIO_HOME/models/`) — applied on top of the resolved base
   registry; never used as a fallback.
2. `MAKAIO_MODEL_REGISTRY_SOURCES` environment variable entries, in declared order.
3. Explicit local seeds and dev workspace seeds.
4. Official framework CDN registry (`https://makaio-ai.github.io/makaio-framework/model-registry.yaml`),
   cached per source URL.
5. Host-provided packaged fallback seeds and boot-relative bundled seed.

Adding a model to a provider requires no adapter publish — update the registry source and
the framework picks it up on next boot.

To point the framework at a custom registry during development:

```bash
MAKAIO_MODEL_REGISTRY_SOURCES=/path/to/my-registry.yaml makaio serve
```

For multiple ordered sources, pass a JSON string array:

```bash
MAKAIO_MODEL_REGISTRY_SOURCES='["/local/seed.yaml","https://example.com/registry.yaml"]' makaio serve
```

## Resolution Flow

When the framework receives `model: 'anthropic::sonnet'`:

1. `parseCanonicalModel('anthropic::sonnet')` returns
   `{ kind: 'qualified', segment1: 'anthropic', model: 'sonnet' }`.
2. A bus request on `canonicalModel.resolve` maps the routing segments to an adapter name
   and provider config ID.
3. The adapter subsystem locates the enabled adapter and its live instance.
4. The adapter resolves credentials using its provider config and credential references.
5. The connector receives the model name and credentials and calls the provider API. Subprocess
   adapters may use `buildCredentialEnv()` to pass resolved credentials through environment
   variables.

Virtual references (`~my-alias`) are expanded at the agent-resolution layer before
reaching the canonical-model resolver. The framework-owned resolver handles only `bare`
and `qualified` forms.

<!-- web:hide -->

## Key Source Files

| File | Purpose |
|------|---------|
| `../../packages/contracts/src/canonical-model/parser.ts` | `parseCanonicalModel()` and `isCanonicalModelParseError()` |
| `../../packages/contracts/src/canonical-model/types.ts` | Canonical model types and Zod schemas |
| `../../packages/contracts/src/canonical-model/schemas.ts` | Bus schemas for `canonicalModel.resolve` |
| `../../packages/contracts/src/provider/definition.ts` | `ProviderDefinition` interface and Zod schema |
| `../../packages/contracts/src/config/provider-config-file.ts` | `ProviderConfigFile` interface and Zod schema |
| `../../packages/contracts/src/config/credential-ref.ts` | `CredentialRef` type and builder helpers |
| `../../adapters/core/src/config/build-credential-env.ts` | `buildCredentialEnv()` |
| `../../runtimes/node/src/boot-model-registry.ts` | Model registry fetcher chain |
| `../../extensions/prompt/README.md` | CLI model reference examples |

<!-- /web:hide -->
