# @makaio/client-gemini

Static client definition for the Google Gemini CLI. This package declares the user-facing identity of the `gemini` binary within the framework — its stable ID, approval policy, and config isolation settings. Gemini exposes tools dynamically at runtime rather than declaring them statically, so no native tools are catalogued here. This is a minimal definition-first package with no runtime entrypoint.

## Client Identity

| Field | Value |
|-------|-------|
| `id` | `gemini` |
| `name` | `Gemini` |
| `version` | `0.1.0` |
| `description` | Google Gemini CLI — AI assistant |
| `binary.name` | `gemini` |
| `binary.supportedVersions` | `*` |
| `defaultApprovalPolicy` | `always-ask` |
| `configIsolation.envVar` | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` |
| `configIsolation.defaultPath` | `~/.gemini/settings.json` |
| `configIsolation.pathKind` | `file` |

## Authentication

The Gemini client currently declares no native auth method because its runtime
does not yet materialize an isolated Gemini credential lease. The Gemini SDK
adapter supports the Google provider's explicit `api-key` method and delivers
that value directly to the SDK auth operation without ambient fallback.

## Native Tools

None declared statically. Gemini exposes tools dynamically at runtime via the `gemini-sdk` adapter.

## Served By (Adapters)

| Adapter ID | Package |
|-----------|---------|
| `gemini-sdk` | `@makaio/ai-adapters-gemini-sdk` — Google Gemini SDK integration |

## Exports

### Main entrypoint (`.`)

| Export | Kind | Description |
|--------|------|-------------|
| `clientDefinition` | `ClientDefinition` | Static client definition (identity, approval policy) |
| `geminiPackage` | `MakaioExtension` | Package descriptor for framework extension discovery |

### Server entrypoint (`./server`)

Default export is `geminiPackage` — the single package registered when this client is activated as a server entry.

## Installation

`@makaio/client-gemini` is a private workspace package used internally by the framework.
