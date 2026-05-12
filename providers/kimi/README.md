# @makaio/provider-kimi

Type-only provider package for Kimi — the Moonshot AI coding model. This package declares the provider identity, the coding-specific Anthropic-compatible endpoint URL, credential environment variable, and default model IDs. It contains no runtime logic; the model catalog is populated from the YAML lab registry at boot time. The Claude Agent SDK adapter serves this provider.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `kimi` |
| `name` | `Kimi` |
| `protocol` | `anthropic` |
| `defaultModel` | `kimi-k2.5` |
| `fastModel` | `kimi-k2.5` |

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `KIMI_API_KEY` | API key for the Kimi inference API |

## Endpoints

| Protocol | URL |
|----------|-----|
| `anthropic` | `https://api.kimi.com/coding` |

This is the coding-specific Anthropic-compatible endpoint, distinct from the general Moonshot API at `api.moonshot.ai`.

## Served By

- [`@makaio/ai-adapters-claude-agent-sdk`](../../adapters/implementations/claude-agent-sdk) — drives Kimi via the Anthropic-compatible messages endpoint.

## Installation

`@makaio/provider-kimi` is a private workspace package used internally by the framework.
