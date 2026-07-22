---
title: Connect Your AI Tools
description: How Makaio normalizes infrastructure across Claude Code, Codex, Gemini, and other AI tools through adapters, the bus, and shipped extensions.
---

<!-- web:hide -->

# Connect Your AI Tools

<!-- /web:hide -->

You use Claude Code, Codex, or Gemini every day — probably several at once. Each
tool has its own credentials, its own session history, its own usage limits. When
you switch between them, context stays behind. When you build something on top of
one, it only works with that one.

Makaio fixes this by providing a shared runtime layer underneath your tools.
Adapters normalize provider differences. Extensions tap into tool events through
the bus. Storage, credentials, and streaming work the same regardless of which
provider sits behind them.

The result: build once, works everywhere. A usage tracker you write for Claude
Code also works with Codex and Gemini — same bus events, same storage, different
adapter.

## What ships out of the box

The framework includes extensions that connect your tools without writing code:

| Extension | What it does |
|-----------|-------------|
| [account-manager](../extensions/account-manager/) | Auto-discovers your Claude Code and Codex accounts, tracks usage windows and rate limits, lets you switch between accounts from CLI or desktop UI |
| [client-hooks](../extensions/client-hooks/) | Bridges hook events from any AI client tool into the Makaio bus, including the [response pipeline](architecture/client-hook-responses.md) that lets extensions approve, deny, or enrich tool calls |
| [claude-code-statusline](../extensions/claude-code-statusline/) | Captures Claude Code's native statusline data (tokens, costs, session info) and emits it on the bus |
| [prompt](../extensions/prompt/) | Provider-agnostic CLI for sending prompts: `makaio prompt send "..." --model sonnet` — works with any connected adapter |

Install the runtime, add the extensions you want, and your tools are connected:

```bash
makaio serve

# In another terminal
makaio extension install ./extensions/account-manager
makaio extension install ./extensions/client-hooks

# See your accounts and usage across providers
makaio account-manager
```

## How it works

Every AI tool interaction flows through the **bus** — a typed event and RPC
system that all extensions share:

```text
Claude Code ──→ client-hooks ──→ Bus ──→ account-manager (usage tracking)
                                    ──→ your extension (whatever you build)

Codex ────────→ client-hooks ──→ Bus ──→ same account-manager
                                    ──→ same extension — no changes needed
```

Your tool doesn't talk to Claude Code or Codex directly. It subscribes to bus
events (`agent.complete`, `agent.usage`, `tool.execute`) and reacts to them.
When a new provider adapter lands, your tool works with it automatically.

## Already built something?

If you've already built a usage tracker, session viewer, or workflow tool
for one provider, you don't have to start over. The migration path:

1. **Keep your UI.** Makaio doesn't own your frontend: it provides the data
   layer underneath.
2. **Replace your API calls** with bus subscriptions. Instead of polling the
   Anthropic API for usage, subscribe to `agent.usage` events on the bus.
3. **Gain every provider** the framework supports. Your Claude-only tool now
   also works with Codex, Gemini and Qwen — through the same events.

The [account-manager](../extensions/account-manager/) extension is a good
reference for how a full-featured extension composes credential discovery, usage
tracking, and provider switching from the bus primitives.

## Next steps

| Want to... | Go to |
|------------|-------|
| Run the framework | [Getting Started](./getting-started.md) |
| Build your own extension | [Creating Extensions](./creating-extensions.md) |
| Understand the bus | [Bus Architecture](./architecture/bus/index.md) |
| See all shipped extensions | [extensions/](/extensions/) |
