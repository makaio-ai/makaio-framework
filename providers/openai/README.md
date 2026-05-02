# @makaio/provider-openai

Type-only package that declares the OpenAI provider identity for the Makaio framework. It exports a single `providerDefinition: ProviderDefinitionInput` for the official OpenAI API, communicating over the OpenAI Chat Completions wire protocol. No runtime logic, network calls, or model catalog is included — the model catalog and reasoning-effort mappings are populated from the YAML lab registry at boot time. The `openaiPackage` descriptor wraps the definition for unified package discovery.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `openai` |
| `name` | `OpenAI` |
| `protocol` | `openai` |
| `defaultModel` | `gpt-5.2` |
| `fastModel` | `gpt-5.4-mini` |

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | API key for authenticating with the OpenAI API |

## Endpoints

| Protocol | URL |
|----------|-----|
| `openai` | `https://api.openai.com/v1` |

## Served By

| Adapter | Provider IDs covered |
|---------|----------------------|
| `@makaio/ai-adapters-openai-node` | `openai` |
| `@makaio/ai-adapters-pi-sdk` | `openai` |

## Installation

`@makaio/provider-openai` is a private workspace package used internally by the framework.

---

*Part of the [Makaio AI Framework](../../README.md)*
