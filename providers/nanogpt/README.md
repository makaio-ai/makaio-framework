# @makaio/provider-nanogpt

Type-only provider package for NanoGPT — a specialized OpenAI-compatible inference gateway. This package declares the provider identity, endpoint URL, credential environment variable, and filter mode. It contains no runtime logic; the model catalog is populated from the YAML lab registry at boot time. Because NanoGPT is a specialized provider, `defaultModelFilterMode` is set to `'allowlist'` — models are hidden by default and must be explicitly allowed. The OpenAI Node adapter serves this provider.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `nanogpt` |
| `name` | `NanoGPT` |
| `protocol` | `openai` |
| `defaultModel` | — (none; allowlist mode) |
| `fastModel` | — (none; allowlist mode) |
| `defaultModelFilterMode` | `allowlist` |

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `NANOGPT_API_KEY` | API key for the NanoGPT inference API |

## Endpoints

| Protocol | URL |
|----------|-----|
| `openai` | `https://nano-gpt.com/api/v1` |

## Served By

- [`@makaio/ai-adapters-openai-node`](../../adapters/implementations/openai-node) — drives NanoGPT via the OpenAI Chat Completions wire protocol.

## Installation

`@makaio/provider-nanogpt` is a private workspace package used internally by the framework.

---

*Part of the [Makaio AI Framework](../../README.md)*
