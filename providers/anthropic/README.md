# @makaio/provider-anthropic

Type-only package that declares the Anthropic provider identity for the Makaio framework. It exports two `ProviderDefinitionInput` objects: `providerDefinition` for the API-key variant and `providerDefinitionOAuth` for the OAuth subscription variant. No runtime logic, network calls, or model catalog is included — the model catalog is populated from the YAML lab registry at boot time. The `anthropicPackage` descriptor wraps both definitions for unified package discovery.

## Provider Identity

### API-key variant (`anthropic`)

| Field | Value |
|-------|-------|
| `id` | `anthropic` |
| `name` | `Anthropic` |
| `protocol` | `anthropic` |
| `defaultModel` | `claude-sonnet-4-6` |
| `fastModel` | `claude-haiku-4-5` |

### OAuth subscription variant (`anthropic-oauth`)

| Field | Value |
|-------|-------|
| `id` | `anthropic-oauth` |
| `name` | `Anthropic (Subscription)` |
| `defaultModel` | `sonnet` |
| `fastModel` | `haiku` |

The OAuth variant carries no `endpoints` or `credentialEnvVars` — credentials are managed by the account-manager or client binary.

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for the `anthropic` variant |

## Endpoints

| Protocol | URL |
|----------|-----|
| `anthropic` | `https://api.anthropic.com` |

## Served By

| Adapter | Provider IDs covered |
|---------|----------------------|
| `@makaio/ai-adapters-anthropic-sdk` | `anthropic` |
| `@makaio/ai-adapters-claude-agent-sdk` | `anthropic`, `anthropic-oauth` |
| `@makaio/ai-adapters-claude-code-cli` | `anthropic`, `anthropic-oauth` |
| `@makaio/ai-adapters-pi-sdk` | `anthropic` |

## Installation

`@makaio/provider-anthropic` is a private workspace package used internally by the framework.

---

*Part of the [Makaio AI Framework](../../README.md)*
