<div align="center">
  <img src="https://raw.githubusercontent.com/makaio-ai/makaio-framework/main/docs/assets/logo.svg" alt="Makaio Logo" width="120" />
  <h1>@makaio/framework</h1>
  <p><strong>A typed, bus-centric runtime for orchestrating AI agents, tools, and sessions across providers.</strong></p>

  [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/makaio-ai/makaio-framework/blob/main/LICENSE)
  [![CI](https://github.com/makaio-ai/makaio-framework/actions/workflows/ci.yml/badge.svg)](https://github.com/makaio-ai/makaio-framework/actions/workflows/ci.yml)
</div>

---

## What is this?

Makaio Framework is runtime infrastructure for AI agent systems. It provides a typed event bus where agents, services, tools, and storage communicate through events and RPC — across threads, processes, or machines.

- **8 provider adapters** (Anthropic, OpenAI, Gemini, Codex, Qwen, GitHub Copilot, and more)
- **Typed event bus** with pub/sub, RPC, namespaces, and cross-process transports
- **Extension system** — capabilities load at runtime, not compile time
- **Bus-mediated storage** — swap backends without touching service code
- **Conformance-tested** — every adapter passes a shared test suite

## Install

```bash
npm install @makaio/framework
```

## Usage

```ts
import { MakaioBus } from '@makaio/framework/bus';
import { AgentSubjects, SessionSubjects } from '@makaio/framework/contracts';

const sessionId = crypto.randomUUID();

const { messageId } = await MakaioBus.request(SessionSubjects.sendMessage, {
  sessionId,
  agent: {
    kind: 'adapter',
    adapterName: 'anthropic-sdk', // or 'openai-node', 'gemini-sdk', etc.
    systemPrompt: 'You are a security reviewer. Be concise.',
  },
  message: 'Review the changes in src/ for security issues',
});

const completed = await MakaioBus.once(AgentSubjects.complete, {
  filter: { sessionId, messageId },
  timeoutMs: 120_000,
});

console.info(completed.payload.message);
```

Switch `adapterName` and the same code runs against any supported provider.

## Subpath Exports

| Import | Description |
|--------|-------------|
| `@makaio/framework/bus` | Typed event bus — pub/sub, RPC, namespaces |
| `@makaio/framework/contracts` | Zod schemas, subject taxonomy, wire format |
| `@makaio/framework/core` | Foundational types, errors, OptionalResult |
| `@makaio/framework/kernel` | Extension coordinator, service lifecycle |
| `@makaio/framework/services` | Session, orchestrator, tool registry, model registry |
| `@makaio/framework/adapters` | Adapter layer — lifecycle, session management |
| `@makaio/framework/storage` | Bus-mediated storage contracts and handlers |
| `@makaio/framework/tools` | Tool contract, defineTool(), defineToolset() |
| `@makaio/framework/testing` | Test helpers, bus fixtures, SQLite harness |

## PostgreSQL Backend

SQLite is the default backend and needs no configuration. To run against PostgreSQL instead, install the `@makaio/storage-pg` engine package in your application and point the runtime at your server:

```bash
npm install @makaio/storage-pg
export MAKAIO_DATABASE_URL=postgres://user:password@host:5432/makaio
```

The node-postgres driver (`pg` ^8.x) is a regular dependency of `@makaio/storage-pg` — neither is listed in this package's dependencies or peer dependencies, so selecting SQLite never pulls in a Postgres driver and SQLite-only installs add nothing extra. The driver is pure JavaScript and runs under both Node.js and Bun.

**Selecting the backend.** The connection target resolves in this order (empty and whitespace-only values count as unset):

1. The `database.url` boot option
2. The `MAKAIO_DATABASE_URL` environment variable
3. The `dbPath` option of direct `initializeNodeDatabase` callers (SQLite file path)
4. The `MAKAIO_DATABASE_PATH` environment variable (SQLite file path)
5. `<makaioHome>/makaio.db` (SQLite default)

A `postgres://` or `postgresql://` URL from the first two sources selects PostgreSQL — Node and Bun runtime hosts recognize the scheme and auto-register the installed `@makaio/storage-pg` engine before any database client is created (the `database.engines` boot option stays the explicit registration path). Any other URL scheme there is rejected with an error rather than falling through to SQLite. The connection pool defaults to 4 connections; tune it with the `database.poolMax` boot option.

**Migrations.** The package bundles a runtime-only SQLite migration chain at `dist/drizzle/`: root-level `.sql` files plus `meta/_journal.json`. Applications do not copy, generate, or reconstruct framework migrations; boot applies the packaged chain that matches the selected backend. Drizzle generator snapshots stay in the source repository for future migration generation and are intentionally omitted from published runtime artifacts. The Postgres chain ships inside `@makaio/storage-pg` and is resolved through its storage engine. Concurrent boots against the same Postgres database are safe — migration runs are serialized with a transaction-scoped advisory lock.

**Full-text search** works on both backends through the same contracts: FTS5 on SQLite, `tsvector` on Postgres (web-search query syntax via `websearch_to_tsquery`). Relevance scores are positive on both backends but not comparable across them.

**Supported version.** CI runs the storage conformance suite against PostgreSQL 18 (`postgres:18-alpine`); use 18 or newer.

**Switching an existing SQLite install.** Install `@makaio/storage-pg` and set `MAKAIO_DATABASE_URL`; delete any custom `dbPath` wiring (a URL outranks it, so leftover path configuration is inert). Data is not migrated across backends — the Postgres database starts empty.

## Documentation

- [Getting Started](https://github.com/makaio-ai/makaio-framework/blob/main/docs/getting-started.md)
- [Writing an Extension](https://github.com/makaio-ai/makaio-framework/blob/main/docs/creating-extensions.md)
- [Writing an Adapter](https://github.com/makaio-ai/makaio-framework/blob/main/docs/creating-adapters.md)
- [Bus Architecture](https://github.com/makaio-ai/makaio-framework/blob/main/docs/architecture/bus/index.md)
- [Full README](https://github.com/makaio-ai/makaio-framework)

## License

[MIT](https://github.com/makaio-ai/makaio-framework/blob/main/LICENSE)
