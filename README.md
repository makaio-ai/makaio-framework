<div align="center">
  <img src="docs/assets/logo.svg" alt="Makaio Logo" width="120" />
  <h1>Makaio Framework</h1>
  <p><strong>A typed, bus-centric runtime for orchestrating AI agents, tools, and sessions across providers.</strong></p>

  [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  [![CI](https://github.com/makaio-ai/makaio-framework/actions/workflows/ci.yml/badge.svg)](https://github.com/makaio-ai/makaio-framework/actions/workflows/ci.yml)

  [Website](https://makaio.ai) · [Getting Started](https://makaio.ai/guides/getting-started/) · [Why Makaio](https://makaio.ai/why/)
</div>

---

> [!TIP]
> **Give your AI agent full context.** Point it at [`makaio.ai/llms.txt`](https://makaio.ai/llms.txt) — everything it needs to answer questions, write extensions, or explore the architecture with you.

---


Most AI tooling today solves one layer: call an LLM, stream a response, maybe loop on tool calls. That works until you need multiple providers in one system, agents that communicate across processes, storage you can swap without rewriting services, or extensions that load at runtime without forking the host.

Makaio Framework is a typed runtime for building and hosting AI agent systems. It gives you a bus-centric architecture where agents, services, tools, and storage communicate through typed events and RPC — across threads, processes, or machines.

---

### Connect your AI tools

> [!NOTE]
> Makaio normalizes the infrastructure beneath your AI tools — adapters, credentials, streaming, storage. Build a usage tracker, session viewer, or approval workflow once, and it works across Claude Code, Codex, Gemini, and more. Already built something for one provider? Move it to Makaio and it works with all of them.
>
> → [Connect your tooling](docs/connect.md) · [Shipped extensions](extensions/index.md)

### Extend the ecosystem

> [!NOTE]
> Scaffold an extension in one command, contribute CLI commands, background services, tools, or UI surfaces. The framework provides adapters for 8 providers, bus-mediated storage, and a full runtime — you focus on what your extension does.
>
> → [Create an extension](docs/creating-extensions.md) · [Extension model](docs/architecture/extensions/index.md)

### Compose, intercept, extend

> [!NOTE]
> Everything flows through a typed bus — tool calls, agent events, storage requests. Intercept tool inputs for redaction, route sensitive analysis to local models, chain handlers with priority middleware. Build sophisticated automations without forking the framework.
>
> → [Bus architecture](docs/architecture/bus/index.md) · [Writing an adapter](docs/creating-adapters.md)

### Evaluating agent frameworks?

> [!NOTE]
> Makaio is not another LangChain wrapper. It's runtime infrastructure: a typed event bus with cross-process transports, a 3-layer adapter contract with conformance tests, and an extension system where capabilities load at runtime. Compare it to the orchestration layer beneath your agents, not the agents themselves.
>
> → [How this differs](#how-this-differs) · [Architecture](#architecture)

---

## Install

Makaio Framework is currently source-first. From a source checkout:

```bash
yarn install
yarn dev
```

The development script starts the framework runtime and web host. Verify the
CLI directly from source:

```bash
yarn tsx apps/cli/src/cli-entry.ts --help
```

## Quick Start

Start the runtime and manage extensions — no code required:

```bash
# Start the Makaio runtime (bus + services + adapters)
makaio serve

# In another terminal — install extensions
makaio extension install ./extensions/account-manager   # Local source checkout
makaio extension install ./my-local-extension           # Your local extension

# See what's installed
makaio extension list
```

Extensions contribute CLI commands, background services, tools, UI surfaces, and more — all discovered at runtime via `descriptor.json`. During the pre-release phase, framework-shipped extensions are installed from local paths; published npm package names will be documented once those packages are public.

The [account-manager](extensions/account-manager/README.md) extension adds credential management across AI tools. The [prompt](extensions/prompt/README.md) extension adds `makaio prompt send` — a provider-agnostic CLI for sending prompts, useful as a drop-in replacement for `claude -p` in scripts and CI pipelines.

## Why a Shared Framework

Everyone building AI-powered applications ends up writing the same infrastructure: provider adapters that break every SDK update, streaming pipelines, tool execution loops, session management, storage layers. Then the model landscape shifts — a new provider launches, an API version bumps, a protocol like ACP emerges — and every project maintains its own copy of the same adapter fixes.

This is that shared copy. One set of adapters with conformance tests, one extension model, one typed bus. You build your application, workflow, or agent system on top. When Anthropic ships a new API version or OpenAI changes their streaming format, the fix lands here once — not in every project independently.

## How This Differs

Existing solutions occupy specific layers:

| Layer | Examples | What they solve |
|-------|----------|-----------------|
| Provider abstraction | Vercel AI SDK, LiteLLM | Unified interface to call any LLM |
| Agent orchestration | LangGraph, AutoGen, CrewAI | Build and run multi-agent workflows |
| Coding assistants | Claude Code, Cursor, Copilot | AI-powered development in a single tool |

Makaio Framework operates below and across these layers. It provides the runtime infrastructure that agent systems need regardless of which provider, orchestration pattern, or host surface they use:

- A **typed event bus** with pub/sub, RPC, namespaces, and cross-process transports
- A **3-layer adapter contract** (Adapter → Agent → Connector) with conformance tests
- An **extension system** where capabilities load at runtime, not compile time
- **Bus-mediated storage** so backends are swappable without touching service code
- **Host composition** — CLI and desktop share the same boot pipeline

The bus isn't a notification layer added to a procedural core. It's the architectural backbone: services subscribe, adapters publish, storage handlers respond to requests, and transports bridge it all across process boundaries.

## Build on Makaio

Start any provider's agent with a bus request. Control tool access. React to events. All typed, all provider-agnostic:

> `@makaio/framework` is the intended public aggregate package. Until that package is published, these imports describe the release surface rather than an installable npm package.

```ts
import { MakaioBus } from '@makaio/framework/bus';
import { AgentSubjects, SessionSubjects } from '@makaio/framework/contracts';

const sessionId = crypto.randomUUID();

// Start a session-backed turn — same shape regardless of provider
const { messageId } = await MakaioBus.request(SessionSubjects.sendMessage, {
  sessionId,
  agent: {
    kind: 'adapter',
    adapterName: 'anthropic-sdk', // swap to 'openai-node', 'gemini-sdk', etc.
    systemPrompt: 'You are a security reviewer. Be concise.',
    // Omit model to use the provider default, or pass an adapter-specific ID from the model registry.
  },
  message: 'Review the changes in src/ for security issues',
});

// Control what the agent can do — approve, deny, or abort
const unsub = MakaioBus.on(
  AgentSubjects.toolApprove,
  (ctx) => {
    if (ctx.payload.toolName === 'write_file') {
      ctx.setResult({ action: 'deny', message: 'Read-only review.', shouldAbort: false });
    } else {
      ctx.setResult({ action: 'allow' });
    }
  },
  { filter: { sessionId } },
);

// Wait for completion — typed result
const completed = await MakaioBus.once(AgentSubjects.complete, {
  filter: { sessionId, messageId },
  timeoutMs: 120_000,
});

console.info(completed.payload.message);
unsub();
```

Switch `adapterName` and the same session orchestration code runs against Claude, Codex, Gemini, or Qwen. Keep `model` omitted for provider defaults unless you have resolved a concrete adapter-specific model ID from the model registry. The [adapter conformance test suite](adapters/implementations/__tests__/) guarantees consistent behavior across all of them.

### Architecture

```text
┌─────────────────────────────────────────────────────────┐
│              Your Application / Host                    │
│           CLI, Electron, or custom host                 │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│            Runtime + Extension Coordinator              │
│     Dependency ordering · Lifecycle · Surfaces          │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                    Makaio Bus                           │
│  Typed pub/sub + RPC · Namespaces · Scoped/Filtered     │
│  Transport registry (WebSocket, loopback, custom)       │
└───────┬────────────────┼───────────────────┬────────────┘
        │                │                   │
┌───────▼──────┐  ┌──────▼───────┐  ┌────────▼─────────┐
│   Services   │  │   Storage    │  │      Tools       │
│  Session,    │  │  Bus-backed  │  │  Typed schemas,  │
│  Orchestrator│  │  handlers    │  │  registry,       │
│  Registry    │  │  (swappable) │  │  approval flow   │
└──────────────┘  └──────────────┘  └──────────────────┘
        │
┌───────▼─────────────────────────────────────────────────┐
│              Adapter Layer (3-part)                     │
│  AIAdapter        → lifecycle, session management       │
│  AIAgent          → turn execution, tool orchestration  │
│  AIAgentConnector → provider SDK / CLI / ACP bridge     │
└─────────────────────────────────────────────────────────┘
```

Everything communicates through the [bus](docs/architecture/bus/index.md). The transport registry means the bus spans process boundaries — a VS Code extension, a mobile app, or a CI pipeline can participate as a bus client over WebSocket without importing the framework.

### Adapters

Each adapter implements the 3-layer contract (Adapter → Agent → Connector) and passes a shared [conformance test suite](adapters/implementations/__tests__/) that verifies lifecycle, streaming, tool approval, and error handling.

| Adapter | Provider | Protocol | Status |
|---------|----------|----------|--------|
| `anthropic-sdk` | Anthropic (Claude) | API SDK | Stable |
| `openai-node` | OpenAI (GPT) | API SDK | Stable |
| `gemini-sdk` | Google (Gemini) | API SDK | Stable |
| `claude-code-cli` | Anthropic (Claude Code) | CLI subprocess | Stable |
| `claude-code` | Anthropic (Claude Agent SDK implementation) | API SDK | Stable |
| `codex-app-server` | OpenAI (Codex) | ACP | Experimental |
| `qwen-acp` | Alibaba (Qwen) | ACP | Experimental |
| `github-copilot-sdk` | GitHub (Copilot) | API SDK | [ABANDONED](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/) |

**Status definitions:**

- **Stable** — Actively maintained, conformance tests pass, used in production
- **Experimental** — Working implementation, API surface may change
- **Community** — Maintained by contributors, not the core team

Writing a new adapter means implementing `AIAgentConnector` (the provider bridge), wrapping it in an `AIAgent` and `AIAdapter`, and running the conformance suite. See [Creating Adapters](docs/creating-adapters.md).

### SDKs

The bus protocol is language-neutral. SDKs let any process participate — subscribe to events, handle requests, emit — without importing the TypeScript framework:

| SDK | Language | Transport | Status |
|-----|----------|-----------|--------|
| [`@makaio/sdk`](sdks/typescript/) | TypeScript | Framework-native facade | Pre-release, unpublished package |
| [`makaio-sdk`](sdks/python/) | Python | WebSocket + stdio (asyncio) | Pre-release, unpublished package |
| [`makaio-sdk`](sdks/rust/) | Rust | WebSocket + stdio (tokio) | Unpublished crate (`publish = false`) |

All SDKs expose the same logical surface:

```
connect(url, options?)       // WebSocket connection with optional HMAC auth and dispatch mode
subscribe(subject, handler)  // event subscription (local + remote dispatch)
onRequest/on_request(...)    // request handler with middleware chaining (TypeScript uses onRequest; Python/Rust use on_request)
request(subject, payload)    // typed RPC (local-first dispatch by default)
emit(subject, payload)       // fire-and-forget (dispatches to local + remote subscribers)
close()                      // clean shutdown
```

All three SDKs support HMAC authentication (auto-probed from `/health`), local-first request dispatch with middleware chaining via `RequestContext.next()`, typed subject descriptors generated from the protocol manifest, and WebSocket transport. Python and Rust additionally support stdio transport for detached extension processes.

Subscription cleanup is language-shaped: TypeScript returns unsubscribe functions, Python subscription handles expose `close()`, and Rust uses `unsubscribe()` for event subscriptions and `unregister()` for request handlers.

Cross-language SDKs are generated from a [shared protocol manifest](sdks/manifest/) derived from `@makaio/contracts`, validated against a [shared conformance suite](sdks/conformance/). The TypeScript SDK is a thin facade over the framework's bus packages.

## Documentation

**Use Makaio:**

| Topic | Link |
|-------|------|
| Getting started | [docs/getting-started.md](docs/getting-started.md) |
| CLI reference | [apps/cli/README.md](apps/cli/README.md) |
| Configuration | [docs/configuration.md](docs/configuration.md) |

**Build on Makaio:**

| Topic | Link |
|-------|------|
| Writing an extension | [docs/creating-extensions.md](docs/creating-extensions.md) |
| Writing an adapter | [docs/creating-adapters.md](docs/creating-adapters.md) |
| Extension model | [docs/architecture/extensions/index.md](docs/architecture/extensions/index.md) |
| Bus architecture | [docs/architecture/bus/](docs/architecture/bus/index.md) |
| Client hook response pipeline | [docs/architecture/client-hook-responses.md](docs/architecture/client-hook-responses.md) |
| Transport (WebSocket, cross-process) | [docs/architecture/transport.md](docs/architecture/transport.md) |

**Host and deploy:**

| Topic | Link |
|-------|------|
| Host applications | [docs/architecture/apps.md](docs/architecture/apps.md) |

## Repository Layout

Representative high-level tree for the framework distribution. It lists the main workspace groups and notable packages; individual provider, extension, and test packages may change as the framework evolves.

```text
├── adapters/
│   ├── core/                  Adapter contracts, conformance test suite
│   ├── shared/                Shared ACP, Claude, and stream-session helpers
│   └── implementations/       One directory per provider adapter
├── apps/
│   ├── cli/                   Headless CLI server + bus client
│   ├── electron/              Electron desktop host
│   ├── electrobun/            Electrobun desktop host (experimental)
│   ├── host-shared/           Shared desktop host boot/rendering logic
│   └── mcp-server/            MCP server bridge
├── build-tooling/             Shared Vite/tsdown configs for packages and extensions
├── clients/                   External tool client integrations (Claude Code, Codex, Gemini, Copilot, Qwen)
├── core/
│   ├── bus-core/              Typed event bus — pub/sub, RPC, namespaces, scoped/filtered buses
│   ├── contracts/             Zod schemas, subject taxonomy, wire format
│   ├── makaio-core/           Foundational types, errors, OptionalResult
│   └── tools-core/            Tool contract, defineTool(), defineToolset(), executor
├── docs/                      Framework documentation
├── extensions/                Framework-shipped extensions
├── packages/
│   ├── bus-server/            HTTP + WebSocket server lifecycle
│   ├── bus-server-vite/       Vite dev-server bus integration
│   ├── expression/            Expression evaluator over contracts
│   ├── file-watcher/          File watching abstraction
│   ├── hooks/                 Bus-event hook system
│   ├── kernel/                ExtensionCoordinator, service lifecycle, boot observability
│   ├── machine-identity/      Stable machine ID (keypair)
│   ├── providers/             Config/provider runtime helpers
│   ├── rules/                 Runtime rule helpers
│   ├── service-base/          BaseService lifecycle primitive
│   ├── test-utils/            Test helpers, bus fixtures, SQLite test harness
│   └── utils/                 Shared utilities
├── services/
│   ├── core/                  Core services: session, orchestrator, tool registry, model registry
│   ├── log-import/            Session log import service
│   └── package-manager/       Package discovery and management service
├── storage/
│   ├── core/                  Storage namespace contracts
│   ├── drizzle/               Drizzle/SQLite client helpers, FTS, transactions
│   ├── handlers/              Bus-backed CRUD + list handler factories
│   ├── migrations/            Migration runner + schema discovery
│   └── preferences/           User preferences storage
├── subsystems/
│   ├── adapter/               Adapter contribution loading, runtime registry, identity
│   ├── client/                Managed client/runtime/binary services
│   ├── mcp-http-server/       MCP-over-HTTP bridge
│   ├── native-session-supervisor/ Native client session observation
│   └── workflow-engine/       DAG workflow executor with checkpoint recovery
├── providers/                 Provider metadata packages (model catalogs, capability tags)
├── runtimes/
│   ├── bun/                   Bun host assembly helpers
│   └── node/                  Node host assembly: bootMakaioRuntime(), discovery, DB init
├── sdks/
│   ├── typescript/            @makaio/sdk — TypeScript facade
│   ├── python/                Python SDK (asyncio, WebSocket + stdio)
│   ├── rust/                  Rust SDK (tokio, WebSocket + stdio)
│   ├── manifest/              Language-neutral protocol definition (generated)
│   └── conformance/           Shared wire-level conformance fixtures
├── transports/
│   ├── ws/                    WebSocket transport (HMAC auth, E2E encryption, relay)
│   └── message-channel/       MessageChannel transport (SharedWorker, iframe)
└── ui/
    ├── kernel/                UI contracts, registries (widgets, pages, navigation)
    ├── theme/                 SCSS design system: tokens, themes, mixins
    ├── components/            Pure UI components (no hooks, no bus)
    ├── hooks/                 React hooks, stores, providers (BusProvider, useBus)
    └── views/                 Composed views and shell components
```

## Contributing

We welcome contributions — adapters, extensions, tools, bug fixes, and documentation. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, contribution surfaces, and PR guidelines.

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

## License

[MIT](LICENSE)
