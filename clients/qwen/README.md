# @makaio/client-qwen

Static client definition for Qwen Code. This package declares the user-facing identity of the `qwen` binary within the framework. Qwen Code uses the Agent Client Protocol (ACP) for communication, meaning tools are discovered dynamically at runtime by the adapter rather than declared statically here. This is a minimal definition-first package with no runtime entrypoint.

## Client Identity

| Field | Value |
|-------|-------|
| `id` | `qwen` |
| `name` | `Qwen Code` |
| `version` | `0.1.0` |
| `description` | Qwen Code CLI — an agentic coding assistant via ACP |
| `binary.name` | `qwen` |
| `binary.supportedVersions` | `*` |
| `defaultApprovalPolicy` | `always-ask` |
| `configIsolation.envVar` | `QWEN_HOME` |
| `configIsolation.defaultPath` | `~/.qwen` |

## Authentication

No native method is currently declared. Qwen OAuth is discontinued, and the
runtime does not yet materialize a safe connector-owned `QWEN_HOME` for the
remaining interactive/API-key authentication choices.

## Native Tools

None declared statically. Qwen Code exposes tools via the Agent Client Protocol (ACP), which are discovered dynamically at runtime by the `qwen-acp` adapter.

## Served By (Adapters)

No production adapter is advertised until a Qwen authentication method has an
isolated, client-owned lease implementation.

## Exports

### Main entrypoint (`.`)

| Export | Kind | Description |
|--------|------|-------------|
| `clientDefinition` | `ClientDefinition` | Static client definition (identity, approval policy) |
| `qwenPackage` | `MakaioExtension` | Package descriptor for framework extension discovery |

### Server entrypoint (`./server`)

Default export is `qwenPackage` — the single package registered when this client is activated as a server entry.

## Installation

`@makaio/client-qwen` is a private workspace package used internally by the framework.
