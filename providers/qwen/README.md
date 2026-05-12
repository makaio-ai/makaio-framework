# @makaio/provider-qwen-acp

Type-only provider package for Qwen OAuth — the Qwen Code CLI integration. This package declares the provider identity, display name, and default model IDs for the Qwen Code subprocess channel. It contains no runtime logic; the model catalog is populated from the YAML lab registry at boot time. The Qwen ACP adapter serves this provider.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `qwen-oauth` |
| `name` | `Qwen OAuth` |
| `protocol` | subprocess / ACP (no network endpoint) |
| `defaultModel` | `qwen3.5-plus(openai)` |
| `fastModel` | `qwen3-coder-plus(openai)` |

## Credential Environment Variables

This provider uses OAuth — no API key environment variable is required. Authentication is managed through the Qwen Code CLI credential flow.

## Endpoints

This provider has no network HTTP endpoints. Qwen Code communicates through the Qwen Code CLI via the Agent Client Protocol (ACP) subprocess transport. The `endpoints` field is intentionally omitted from the provider definition.

## Served By

- [`@makaio/ai-adapters-qwen-acp`](../../adapters/implementations/qwen-acp) — subprocess adapter that drives the Qwen Code CLI over the ACP wire protocol.

## Installation

`@makaio/provider-qwen-acp` is a private workspace package used internally by the framework.
