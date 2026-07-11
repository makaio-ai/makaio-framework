# @makaio/provider-openai-codex

Type-only package that declares the OpenAI Codex provider identity for the
Makaio framework. It exports one `ProviderDefinitionInput` for Codex App Server.
The app server communicates over a local subprocess rather than a provider HTTP
endpoint. No runtime logic, network calls, or model catalog is included; the
model registry populates the catalog at boot.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `openai-codex` |
| `name` | `OpenAI Codex` |
| `defaultModel` | `gpt-5.5` |
| `fastModel` | `gpt-5.4-mini` |

## Authentication

| Owner | Method | Mode | Source or native state | Codex delivery |
|-------|--------|------|------------------------|----------------|
| Provider `openai-codex` | `api-key` | `explicit` | Required `apiKey`; `OPENAI_API_KEY` is an environment source hint | `account/login/start` with `type: "apiKey"` after initialization |
| Client `codex` | `access-token` | `explicit` | Required `accessToken`; `CODEX_ACCESS_TOKEN` is an environment source hint | Selected subprocess environment |
| Client `codex` | `native` | `inferred` | Persisted Codex file or keychain state | Isolated local `CODEX_HOME` lease |

`OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` are distinct methods. The former is
only a possible source for the provider API key; it is not injected into the
app-server process. Native auth is local-only and is never inferred from
ambient environment variables.

## Served By

| Adapter | Provider IDs covered |
|---------|----------------------|
| `@makaio/ai-adapters-codex-app-server` | `openai-codex` |

## Installation

`@makaio/provider-openai-codex` is a private workspace package used internally by the framework.
