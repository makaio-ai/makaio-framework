---
title: Models & Providers
description: Configure AI models, providers, and credentials in the Makaio Framework.
---

Models and providers are the configuration layer between adapters and AI services. A
`ProviderDefinition` declares what an AI service offers — its endpoints, default models,
and provider-owned authentication methods. A `ProviderConfig` selects exactly one auth
method and stores credential references or native-account identity. Canonical model names
let you address any model through a unified string format that the framework resolves to the
right adapter and provider at runtime.

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
  authMethods: ProviderAuthMethodDefinition[];
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
  authMethods: [{
    id: 'api-key',
    mode: 'explicit',
    label: 'API key',
    fields: [{
      id: 'apiKey',
      label: 'API key',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment', variable: 'ANTHROPIC_API_KEY' }],
    }],
  }],
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
  authMethods: [{
    id: 'api-key',
    mode: 'explicit',
    label: 'API key',
    fields: [{
      id: 'apiKey',
      label: 'API key',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment', variable: 'Z_AI_API_KEY' }],
    }],
  }],
}
```

Example — GitHub Copilot (SDK-only provider, no HTTP endpoints):

```ts
{
  id: 'github-copilot',
  name: 'GitHub Copilot',
  authMethods: [{
    id: 'token',
    mode: 'explicit',
    label: 'Token',
    fields: [{
      id: 'token',
      label: 'Token',
      required: true,
      secret: true,
      sourceHints: [{ kind: 'environment', variable: 'COPILOT_TOKEN' }],
    }],
  }],
  // endpoints intentionally omitted — uses proprietary SDK transport
}
```

Provider definitions are contributed by provider extensions and discovered during boot. Adapters
declare the provider definition IDs they support and attach runtime-only auth bindings to each
adapter/provider reference. Client definitions separately declare client-owned methods, including
`inferred` native auth and explicit tokens. A client's optional `defaultAuth` selects an inferred
method for its managed default provider configuration.

## Provider Configs

A `ProviderConfigFile` binds one normalized authentication selection and settings to a provider
definition.

```ts
interface ProviderConfigFile {
  $schema: 'makaio/provider-config/v2';
  definitionId: string;
  name?: string;
  auth:
    | {
        mode: 'explicit';
        method: AuthMethodRef;
        credentialRefs: Record<string, AuthCredentialRef>;
      }
    | {
        mode: 'inferred';
        method: ClientAuthMethodRef;
        account?: { managerId: string; accountId: string };
      }
    | { mode: 'none'; method: AuthMethodRef };
  managedBy?: { kind: 'client'; clientId: string };
  endpointOverrides?: {
    anthropic?: string;
    openai?: string;
  };
  modelFilterMode?: 'show-all' | 'allowlist';
  modelVisibility?: Record<string, ModelVisibility>;
  isDefault?: boolean;
  enabled?: boolean;
}
```

Files are stored at: `$MAKAIO_HOME/provider-configs/<providerConfigId>.json`

`AuthCredentialRef` accepts resolvable references such as `env:VAR`,
`keychain:service:account`, `file:/path`, or
`stored:providerConfig:<configId>:<key>`. Plaintext secrets never appear in config files.
Managed native-account identity is carried by `auth.account`, not encoded as a credential ref.

## Credentials

Authentication has three explicit modes:

- `explicit` selects a declared provider- or client-owned method and stores one credential ref
  per required field. Environment source hints such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, or `CODEX_ACCESS_TOKEN` help configuration surfaces create
  `env:` refs; they are not ambient runtime fallbacks.
- `inferred` selects a client-owned native method. The client materializes its declared home,
  profile, or Keychain state into a connector-scoped config lease. Absence of that state is a
  typed auth failure.
- `none` is a deliberate no-auth selection for providers that declare it.

Each adapter/provider reference declares how a selected method is delivered: mapped process
environment fields, an adapter-owned connector operation, native-client state, or no delivery.
There is no single credential variable per adapter. One adapter may accept provider API keys,
client OAuth/access tokens, and native auth through different owner-qualified methods.

Before connector construction, Adapter Core resolves credential refs once, removes the complete
adapter auth source/sink environment set, applies only the selected delivery, and creates any
required client config lease. SDK constructors receive structured connector deliveries; spawned
clients receive the final scrubbed environment only.

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
3. The adapter subsystem captures one adapter-qualified runtime snapshot containing the safe
   provider config, refs-only provider context, selected adapter/provider auth binding, protocol,
   client identity, and runtime package metadata.
4. Adapter Core binds the owner-qualified auth method and resolves explicit credential refs once
   inside the trusted runtime boundary, or prepares the selected native-client lease.
5. The connector receives one immutable auth snapshot plus its exact selected protocol endpoint.
   It never guesses credentials from ambient environment variables or chooses the first available
   provider endpoint.

Virtual references (`~my-alias`) are expanded at the agent-resolution layer before
reaching the canonical-model resolver. The framework-owned resolver handles only `bare`
and `qualified` forms.

<!-- web:hide -->

## Key Source Files

| File | Purpose |
|------|---------|
| `../../../core/contracts/src/canonical-model/parser.ts` | `parseCanonicalModel()` and `isCanonicalModelParseError()` |
| `../../../core/contracts/src/canonical-model/types.ts` | Canonical model types and Zod schemas |
| `../../../core/contracts/src/canonical-model/schemas.ts` | Bus schemas for `canonicalModel.resolve` |
| `../../../core/contracts/src/provider/definition.ts` | Provider definition and protocol schemas |
| `../../../core/contracts/src/auth/definitions.ts` | Provider/client authentication method schemas |
| `../../../core/contracts/src/auth/selection.ts` | Normalized provider-config auth selection |
| `../../../core/contracts/src/auth/adapter-binding.ts` | Runtime-only adapter delivery bindings |
| `../../../core/contracts/src/config/provider-config-file.ts` | `ProviderConfigFile` v2 schema |
| `../../../adapters/core/src/config/adapter-auth-runtime.ts` | Central auth materialization and lease ownership |
| `../../../runtimes/node/src/boot-model-registry.ts` | Model registry fetcher chain |
| `../../../extensions/prompt/README.md` | CLI model reference examples |

<!-- /web:hide -->
