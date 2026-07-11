# @makaio/client-github-copilot

Static client definition for GitHub Copilot. This package declares the user-facing identity of the `copilot` binary within the framework. GitHub Copilot is an SDK-only integration — the `copilot` binary is used for CLI detection during onboarding but no native tools are exposed by the client itself. All tool invocations default to `always-ask` to ensure explicit user approval. This is a minimal definition-first package with no runtime entrypoint.

> [!IMPORTANT]
> Since GitHub Copilot [changed its pricing model](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/),
> this provider package is currently no longer actively maintained.

## Client Identity

| Field | Value |
|-------|-------|
| `id` | `github-copilot` |
| `name` | `GitHub Copilot` |
| `version` | `0.1.0` |
| `description` | GitHub Copilot — AI pair programming assistant |
| `binary.name` | `copilot` |
| `binary.supportedVersions` | `*` |
| `defaultApprovalPolicy` | `always-ask` |
| `configIsolation.envVar` | `COPILOT_HOME` |
| `configIsolation.defaultPath` | `~/.copilot` |

## Authentication

This client declares no client-owned auth method or managed default. The
`github-copilot` provider owns the explicit `token` method; `COPILOT_TOKEN` is
one environment source hint for its required `token` field. The adapter maps
that field to the SDK constructor and suppresses competing token inputs.

## Native Tools

None. GitHub Copilot is an SDK-only integration. The `copilot` binary is only used for detection; all tool invocations flow through the adapter layer and require explicit approval.

## Served By (Adapters)

| Adapter ID | Package |
|-----------|---------|
| `github-copilot-sdk` | `@makaio/ai-adapters-github-copilot-sdk` — GitHub Copilot SDK integration |

## Exports

### Main entrypoint (`.`)

| Export | Kind | Description |
|--------|------|-------------|
| `clientDefinition` | `ClientDefinition` | Static client definition (identity, approval policy) |
| `githubCopilotPackage` | `MakaioExtension` | Package descriptor for framework extension discovery |

### Server entrypoint (`./server`)

Default export is `githubCopilotPackage` — the single package registered when this client is activated as a server entry.

## Installation

`@makaio/client-github-copilot` is a private workspace package used internally by the framework.
