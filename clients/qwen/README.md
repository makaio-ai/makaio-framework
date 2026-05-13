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
| `defaultProviderId` | `qwen-oauth` |
| `configIsolation.envVar` | `QWEN_CODE_SYSTEM_DEFAULTS_PATH` |
| `configIsolation.defaultPath` | `/etc/qwen-code/system-defaults.json` |
| `configIsolation.pathKind` | `file` |

## Native Tools

None declared statically. Qwen Code exposes tools via the Agent Client Protocol (ACP), which are discovered dynamically at runtime by the `qwen-acp` adapter.

## Served By (Adapters)

| Adapter ID | Package |
|-----------|---------|
| `qwen-acp` | `@makaio/ai-adapters-qwen-acp` — Qwen Code CLI via Agent Client Protocol |

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
