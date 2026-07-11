# @makaio/provider-anthropic

Type-only package that declares the Anthropic provider identity for the Makaio
framework. It exports two `ProviderDefinitionInput` objects:
`providerDefinition` for the API-key provider and `providerDefinitionOAuth` for
the Claude subscription path. No runtime logic, network calls, or model catalog
is included; the model registry populates the catalog at boot. The
`anthropicPackage` descriptor wraps both definitions for package discovery.

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

The subscription definition declares no provider-owned auth method. Compatible
adapters pair it with client-owned Claude Code methods instead.

## Authentication

| Provider | Method | Mode | Fields and sources |
|----------|--------|------|--------------------|
| `anthropic` | `api-key` | `explicit` | Required `apiKey`; `ANTHROPIC_API_KEY` is an environment source hint |
| `anthropic-oauth` | _(client-owned methods only)_ | — | Claude Code `native` or `oauth-token`, as supported by the selected adapter |

An environment source hint is not an automatic fallback and does not prescribe
delivery. The selected adapter maps `apiKey` to its subprocess environment or
SDK constructor and scrubs competing auth inputs first.

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
