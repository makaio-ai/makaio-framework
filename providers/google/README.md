# @makaio/provider-google

Type-only package that declares the Google AI (Gemini) provider identity for the Makaio framework. It exports two `ProviderDefinitionInput` objects: `providerDefinition` for the API-key variant and `providerDefinitionOAuth` for the OAuth subscription variant. Both variants are SDK-only — they carry no `endpoints` field because Google Gemini communicates through the Google AI SDK rather than a standard HTTP endpoint. No runtime logic, network calls, or model catalog is included — the model catalog is populated from the YAML lab registry at boot time. The `googlePackage` descriptor wraps both definitions for unified package discovery.

## Provider Identity

### API-key variant (`google`)

| Field | Value |
|-------|-------|
| `id` | `google` |
| `name` | `Google AI` |
| `defaultModel` | `gemini-2.5-pro` |
| `fastModel` | `gemini-2.5-flash` |

### OAuth subscription variant (`google-oauth`)

| Field | Value |
|-------|-------|
| `id` | `google-oauth` |
| `name` | `Google AI (Subscription)` |
| `defaultModel` | `gemini-2.5-pro` |
| `fastModel` | `gemini-2.5-flash` |

Neither variant declares `endpoints`. The OAuth variant additionally carries no `credentialEnvVars` — credentials are managed by the account-manager or client binary.

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | API key for the `google` variant |

## Served By

| Adapter | Provider IDs covered |
|---------|----------------------|
| `@makaio/ai-adapters-gemini-sdk` | `google`, `google-oauth` |

## Installation

`@makaio/provider-google` is a private workspace package used internally by the framework.
