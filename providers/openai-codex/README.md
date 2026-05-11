# @makaio/provider-openai-codex

Type-only package that declares the OpenAI Codex provider identity for the Makaio framework. It exports a single `providerDefinition: ProviderDefinitionInput` for the Codex App-Server. Codex is a subprocess-based provider — it communicates through the Codex app-server binary via a local subprocess and does not expose a network HTTP endpoint, so no `endpoints` or `credentialEnvVars` are declared. No runtime logic, network calls, or model catalog is included — the model catalog is populated from the YAML lab registry at boot time. The `openaiCodexPackage` descriptor wraps the definition for unified package discovery.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `openai-codex` |
| `name` | `OpenAI Codex` |
| `defaultModel` | `gpt-5.1-codex-mini` |
| `fastModel` | `gpt-5.4-mini` |

No `endpoints` or `credentialEnvVars` are declared — the subprocess transport manages credentials internally.

## Served By

| Adapter | Provider IDs covered |
|---------|----------------------|
| `@makaio/ai-adapters-codex-app-server` | `openai-codex` |

## Installation

`@makaio/provider-openai-codex` is a private workspace package used internally by the framework.
