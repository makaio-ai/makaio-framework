# AI Adapters

This directory contains adapter implementations that connect Makaio to various AI providers.

## Overview

Each subdirectory is an adapter implementation that:
- Implements the 3-layer contract (`AIAdapter` → `AIAgent` → `AIAgentConnector`) from `@makaio/ai-adapters-core`
- Provides normalized access to a specific AI provider
- Registers its capabilities with the Makaio Bus
- Contributes runtime adapter descriptors through its `./server` export, which returns a `MakaioExtension` with `adapters[]`
- Passes the shared conformance test suite

## Structure

```
implementations/
├── anthropic-sdk/          # Anthropic Claude API adapter
├── claude-agent-sdk/       # Anthropic Claude Agent SDK adapter
├── claude-code-cli/        # Claude Code CLI subprocess adapter
├── codex-app-server/       # OpenAI Codex app-server JSON-RPC/JSONL adapter
├── gemini-sdk/             # Google Gemini adapter
├── github-copilot-sdk/     # GitHub Copilot SDK adapter
├── openai-node/            # OpenAI API adapter
├── qwen-acp/              # Alibaba Qwen (ACP) adapter
└── __tests__/             # Shared conformance test suite
```

## Architecture

Adapters follow a capability-based architecture:
- **Core functionality** (agent lifecycle, message sending, turn execution) is required
- **Runtime capabilities** (`tools`, `streaming`, `vision`, structured output, system-prompt variants, etc.) are optional
- Capabilities are discovered through the bus, not enforced by inheritance

## Creating New Adapters

Adapters can be created in this repository or as external packages. They must:
1. Implement `AIAgentConnector` (provider bridge)
2. Wrap it in `AIAgent` (turn execution) and `AIAdapter` (lifecycle)
3. Declare capabilities honestly on the adapter
4. Expose runtime contribution through a `./server` entrypoint whose default export is a `MakaioExtension` package descriptor
5. Pass the conformance test suite

See [Creating Adapters](../../docs/creating-adapters.md) for the full guide.

## Community Adapters

The architecture supports community-created adapters. External adapters depend on `@makaio/ai-adapters-core` and follow the same three-layer pattern.
