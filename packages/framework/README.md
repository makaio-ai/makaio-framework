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

## Documentation

- [Getting Started](https://github.com/makaio-ai/makaio-framework/blob/main/docs/getting-started.md)
- [Writing an Extension](https://github.com/makaio-ai/makaio-framework/blob/main/docs/creating-extensions.md)
- [Writing an Adapter](https://github.com/makaio-ai/makaio-framework/blob/main/docs/creating-adapters.md)
- [Bus Architecture](https://github.com/makaio-ai/makaio-framework/blob/main/docs/architecture/bus/index.md)
- [Full README](https://github.com/makaio-ai/makaio-framework)

## License

[MIT](https://github.com/makaio-ai/makaio-framework/blob/main/LICENSE)
