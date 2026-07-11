# @makaio/provider-google

Type-only package that declares the Google AI (Gemini) API-key provider
identity for the Makaio framework. It is SDK-only and therefore omits protocol
endpoints. No runtime logic, network calls, or model catalog is included; the
model registry populates the catalog at boot.

## Provider Identity

### API-key variant (`google`)

| Field | Value |
|-------|-------|
| `id` | `google` |
| `name` | `Google AI` |
| `defaultModel` | `gemini-2.5-pro` |
| `fastModel` | `gemini-2.5-flash` |

The provider declares no protocol endpoints because the Gemini adapter uses
the Google AI SDK directly.

## Authentication

| Provider | Method | Mode | Fields and sources |
|----------|--------|------|--------------------|
| `google` | `api-key` | `explicit` | Required `apiKey`; `GEMINI_API_KEY` is an environment source hint |

The source hint is offered only when authoring an explicit credential ref. The
Gemini adapter owns API-key delivery through `Config.refreshAuth` and removes
competing Google auth inputs before applying the selected method. Gemini has
no native-account fallback or connector-owned credential lease.

## Served By

| Adapter | Provider IDs covered |
|---------|----------------------|
| `@makaio/ai-adapters-gemini-sdk` | `google` |

## Installation

`@makaio/provider-google` is a private workspace package used internally by the framework.
