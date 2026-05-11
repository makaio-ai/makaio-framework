# @makaio/provider-alibaba

Type-only package that declares the Alibaba Model Studio provider identity for the Makaio framework. It exports a single `providerDefinition: ProviderDefinitionInput` with dual-protocol endpoints — both an Anthropic-compatible and an OpenAI-compatible inference endpoint — letting adapters choose whichever wire protocol they support. This is a firehose provider: `defaultModelFilterMode` is set to `'allowlist'`, so models are hidden by default and must be explicitly allowed. No runtime logic, network calls, or model catalog is included. The `alibabaPackage` descriptor wraps the definition for unified package discovery.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `alibaba` |
| `name` | `Alibaba Model Studio` |
| `defaultModel` | `qwen3.5-plus` |
| `fastModel` | `minimax-m2.5` |
| `defaultModelFilterMode` | `allowlist` |

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `BAILIAN_CODING_PLAN_API_KEY` | API key for authenticating with Alibaba Model Studio |

## Endpoints

| Protocol | URL |
|----------|-----|
| `anthropic` | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` |
| `openai` | `https://coding-intl.dashscope.aliyuncs.com/v1` |

## Served By

| Adapter | Protocol used |
|---------|---------------|
| `@makaio/ai-adapters-anthropic-sdk` | `anthropic` |
| `@makaio/ai-adapters-openai-node` | `openai` |

## Installation

`@makaio/provider-alibaba` is a private workspace package used internally by the framework.
