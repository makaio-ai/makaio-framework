# @makaio/provider-z-ai

Type-only provider package for Z.AI (GLM) — the reference implementation for dual-protocol providers. This package declares the provider identity, endpoint URLs for both the Anthropic-compatible and OpenAI-compatible inference APIs, credential environment variable, and default model IDs. It contains no runtime logic; the model catalog is populated from the YAML lab registry at boot time. Three adapters serve this provider: the Anthropic SDK adapter, the OpenAI Node adapter, and the Claude Agent SDK adapter.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `z-ai` |
| `name` | `Z.AI (GLM)` |
| `protocol` | `anthropic`, `openai` (dual-protocol) |
| `defaultModel` | `glm-4.7` |
| `fastModel` | `glm-4.7` |

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `Z_AI_API_KEY` | API key for the Z.AI inference API |

## Endpoints

| Protocol | URL |
|----------|-----|
| `anthropic` | `https://api.z.ai/api/anthropic` |
| `openai` | `https://api.z.ai/api/openai` |

The two entries let adapters select whichever wire protocol they support. Both point at the same Z.AI backend under different compatibility paths.

## Served By

- [`@makaio/ai-adapters-anthropic-sdk`](../../adapters/implementations/anthropic-sdk) — uses the `anthropic` endpoint.
- [`@makaio/ai-adapters-openai-node`](../../adapters/implementations/openai-node) — uses the `openai` endpoint.
- [`@makaio/ai-adapters-claude-agent-sdk`](../../adapters/implementations/claude-agent-sdk) — uses the `anthropic` endpoint via the Claude Agent SDK provider layer.

## Installation

`@makaio/provider-z-ai` is a private workspace package used internally by the framework.

---

*Part of the [Makaio AI Framework](../../README.md)*
