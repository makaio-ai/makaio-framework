# @makaio/provider-opencode-go

Type-only provider package for OpenCode Go — a gateway that exposes both OpenAI-compatible and Anthropic-compatible inference endpoints under a single package identity. This package declares two provider definitions: `opencode-go` (OpenAI wire protocol) and `opencode-go-anthropic` (Anthropic wire protocol). It contains no runtime logic; the model catalog is populated from the YAML lab registry at boot time. Both definitions use `defaultModelFilterMode: 'allowlist'`. The OpenAI Node adapter and the Anthropic SDK adapter serve this provider respectively; it is also used as the default test preset for both adapters' conformance suites.

## Provider Identity

### `opencode-go` — OpenAI-compatible

| Field | Value |
|-------|-------|
| `id` | `opencode-go` |
| `name` | `OpenCode Go` |
| `protocol` | `openai` |
| `defaultModel` | `kimi-k2.5` |
| `fastModel` | `glm-5.1` |
| `defaultModelFilterMode` | `allowlist` |

### `opencode-go-anthropic` — Anthropic-compatible

| Field | Value |
|-------|-------|
| `id` | `opencode-go-anthropic` |
| `name` | `OpenCode Go (Anthropic)` |
| `protocol` | `anthropic` |
| `defaultModel` | `minimax-m2.5` |
| `fastModel` | `minimax-m2.7` |
| `defaultModelFilterMode` | `allowlist` |

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_GO_API_KEY` | API key for the OpenCode Go gateway (used by both definitions) |

## Endpoints

| Provider ID | Protocol | URL |
|-------------|----------|-----|
| `opencode-go` | `openai` | `https://opencode.ai/zen/go/v1` |
| `opencode-go-anthropic` | `anthropic` | `https://opencode.ai/zen/go` |

The Anthropic SDK appends `/v1/messages` to the base URL automatically, so the trailing `/v1` is omitted from the Anthropic endpoint.

## Served By

- [`@makaio/ai-adapters-openai-node`](../../adapters/implementations/openai-node) — drives `opencode-go` via the OpenAI Chat Completions wire protocol. This is the default conformance test preset for the OpenAI Node adapter.
- [`@makaio/ai-adapters-anthropic-sdk`](../../adapters/implementations/anthropic-sdk) — drives `opencode-go-anthropic` via the Anthropic Messages wire protocol. This is the default conformance test preset for the Anthropic SDK adapter.

## Installation

`@makaio/provider-opencode-go` is a private workspace package used internally by the framework.
