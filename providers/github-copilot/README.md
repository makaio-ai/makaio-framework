# @makaio/provider-github-copilot

> [!IMPORTANT]
> Since GitHub Copilot [changed its pricing model](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/),
> this provider package is currently no longer actively maintained.

Type-only package that declares the GitHub Copilot provider identity for the Makaio framework. It exports a single `providerDefinition: ProviderDefinitionInput` for GitHub Copilot's premium request-based AI models. GitHub Copilot communicates through its own proprietary transport and does not expose a standard HTTP endpoint, so no `endpoints` field is declared. This is the reference implementation for SDK-only providers. No runtime logic, network calls, or model catalog is included. The `githubCopilotPackage` descriptor wraps the definition for unified package discovery.

## Provider Identity

| Field | Value |
|-------|-------|
| `id` | `github-copilot` |
| `name` | `GitHub Copilot` |
| `defaultModel` | `gpt-5.1-codex-mini` |
| `fastModel` | `gpt-5.4-mini` |

No `endpoints` are declared — the proprietary SDK transport handles all communication.

## Credential Environment Variables

| Variable | Description |
|----------|-------------|
| `COPILOT_TOKEN` | Authentication token for GitHub Copilot |

## Served By

| Adapter | Provider IDs covered |
|---------|----------------------|
| `@makaio/ai-adapters-github-copilot-sdk` | `github-copilot` |

## Installation

`@makaio/provider-github-copilot` is a private workspace package used internally by the framework.
