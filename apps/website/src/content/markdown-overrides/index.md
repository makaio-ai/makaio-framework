# Makaio Framework

Makaio is a typed, bus-centric TypeScript framework for building and orchestrating AI agents. It connects providers, tools, sessions, and storage through a single runtime bus with schema-validated messaging.

## Quick Navigation

Pick the path that matches what you need:

### I want to get started
- [Getting Started](/guides/getting-started/) — install, run the server, write your first extension

### I want to understand the architecture
- [Why Makaio](/why/) — what it is, where it fits, how it differs from SDKs and agent frameworks
- [Bus Overview](/guides/bus/) — the typed event and RPC system at the core
- [Bus Patterns](/guides/bus/patterns/) — common messaging patterns (events, requests, subscriptions)
- [Configuration](/guides/configuration/) — runtime configuration and environment setup

### I want to build an extension
- [Creating Extensions](/guides/extensions/creating/) — extension structure, manifests, namespace ownership
- [Extension Discovery & Loading](/guides/extensions/discovery/) — how extensions are found and loaded
- [Browser & UI Extensions](/guides/extensions/browser/) — contributing UI components and widgets
- [Extension Distribution](/guides/extensions/distribution/) — packaging and publishing extensions

### I want to connect an AI provider
- [Adapters Overview](/guides/adapters/) — the three-layer adapter stack (Adapter → Agent → Connector)
- [Creating Adapters](/guides/adapters/creating/) — write a new adapter for any AI provider
- [Models & Providers](/guides/adapters/models-and-providers/) — model enumeration and capability tags

### I want to work with tools
- [`@makaio/tools-core`](/packages/tools-core/) — typed tool definitions with Zod I/O schemas
- [`@makaio/extension-filesystem`](/extensions/filesystem/) — filesystem tool implementations
- [`@makaio/extension-shell`](/extensions/shell/) — shell execution tools
- [`@makaio/extension-subagent`](/extensions/subagent/) — subagent delegation tools

### I want to use storage
- [Bus Storage Guide](/guides/bus/storage/) — bus-mediated, backend-agnostic storage
- [`@makaio/storage-core`](/packages/storage/core/) — storage contracts and interfaces
- [`@makaio/storage-drizzle`](/packages/storage/drizzle/) — SQLite/Drizzle backend
- [`@makaio/storage-migrations`](/packages/storage-migrations/) — schema migration system

### I want to integrate from another language
- [SDKs Overview](/sdks/) — multi-language bus protocol clients
- [Python SDK](/sdks/python/) — asyncio bus node with local dispatch, auth, and typed subjects
- [Rust SDK](/sdks/rust/) — Tokio bus node with local dispatch, auth, and typed subjects
- [TypeScript SDK](/sdks/typescript/) — native TypeScript client

### I want the CLI
- [CLI Guide](/guides/cli/) — `makaio serve`, adapter management, tool listing

### I need the reference
- [Bus Subjects Reference](/reference/subjects/) — all bus event and RPC subject contracts
- [API Reference](/reference/api/) — full TypeScript API symbol reference
- [Packages](/packages/bus-core/) — package-level overview and README for every framework package

## Key Packages

| Package | Purpose |
|---------|---------|
| `@makaio/bus-core` | Bus runtime — events, requests, subscriptions |
| `@makaio/contracts` | Shared TypeScript contracts and Zod schemas |
| `@makaio/kernel` | Lifecycle kernel — boot, shutdown, service coordination |
| `@makaio/makaio-core` | Full runtime composition root |
| `@makaio/adapters-core` | Adapter base classes and turn pipeline |
| `@makaio/tools-core` | Tool definition, registration, and execution |
| `@makaio/providers` | Provider type definitions and model enums |
| `@makaio/hooks` | Lifecycle hook system |
| `@makaio/utils` | Shared utilities |

## Source

- [GitHub Repository](https://github.com/makaio-ai/makaio-framework)
- License: MIT (framework), commercial products built on top are in development
