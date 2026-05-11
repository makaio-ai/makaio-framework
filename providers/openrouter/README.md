# @makaio/provider-openrouter

Type-only provider package for OpenRouter — a unified API gateway that proxies 300+ AI models across providers. This package declares the provider identity, endpoint URL, and credential environment variable. It contains no runtime logic; the model catalog is populated from the YAML lab registry at boot time. Because OpenRouter is a firehose provider with a very large model catalog, `defaultModelFilterMode` is set to `'allowlist'` — models are hidden by default and must be explicitly allowed. The OpenAI Node adapter serves this provider.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `openrouter` |
| `name` | `OpenRouter` |
| `protocol` | `openai` |
| `defaultModel` | — (none; allowlist mode) |
| `fastModel` | — (none; allowlist mode) |
| `defaultModelFilterMode` | `allowlist` |

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | API key for the OpenRouter inference API |

## Endpoints

| Protocol | URL |
|----------|-----|
| `openai` | `https://openrouter.ai/api/v1` |

## Served By

- [`@makaio/ai-adapters-openai-node`](../../adapters/implementations/openai-node) — drives OpenRouter via the OpenAI Chat Completions wire protocol.

## Installation

`@makaio/provider-openrouter` is a private workspace package used internally by the framework.
