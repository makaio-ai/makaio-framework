# @makaio/adapter-claude-code-tmux

Claude Code tmux adapter for the Makaio framework. It launches `claude` as a
long-lived interactive tmux session and uses Claude Code hooks for lifecycle
correlation.

## Architecture

The adapter follows the framework adapter stack:

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Domain | `ClaudeCodeTmuxAdapter` | Handles adapter lifecycle and agent creation |
| Agent | `ClaudeCodeTmuxAgent` | Bridges connector events into framework agent events |
| Connector | `ClaudeCodeTmuxConnector` | Owns the tmux process, hook subscription, MCP registration, and turn queue |

The connector generates the Claude Code session ID before launch, uses it as the
adapter session ID, and passes the same value to Claude Code with `--session-id`.
Hook events are subscribed through the bus with a `payload.session_id` filter so
only events for that expected Claude session reach the connector.

Runtime observation is emitted by the agent layer with
`client.runtime.observe` after the connector has a confirmed adapter session ID.
That keeps the connector on the scoped adapter bus while still making the
runtime-observation side effect explicit for clients-core.

The connector subscribes to hook events immediately after `TmuxBackend.spawn()`
returns and before awaiting `SessionStart`. There is no earlier subscription
point because the `TmuxSession` wrapper needs the spawned PTY handle, but the
Claude session ID is generated before spawn so the hook filter is already fixed.

In-turn interruption is supported: immediate replacement sends Escape to the
live tmux pane, waits for Stop or the interrupt settling window, clears any
draft input, and then submits the replacement prompt.

Hook wiring is session-isolated. `client.sessionConfig.create` must be handled;
the returned session config directory is passed to Claude Code wiring with
user scope so hooks are written to that directory instead of project
`.claude/settings.json`.

Provider support is limited to Claude Code-authenticated Anthropic providers:
`anthropic` and `anthropic-oauth`.

## MCP

The adapter registers a pinned session with `McpSubjects.session.register` and
writes a session-scoped `makaio-<short-id>` HTTP server entry into the project
`.mcp.json` before spawning Claude Code. On close it removes that generated
entry and unregisters the pinned MCP session.

## File Index

| File | Purpose |
|------|---------|
| `src/adapter.ts` | Adapter factory and framework adapter lifecycle |
| `src/agent.ts` | Agent layer that translates connector events |
| `src/connector.ts` | tmux process, MCP, hook, and queue orchestration |
| `src/session.ts` | PTY wrapper and hook bus subscription |
| `src/turn.ts` | Hook-driven turn state machine |
| `src/utils/hook-event-router.ts` | Raw Claude hook dispatcher |
| `src/utils/mcp-settings.ts` | `.mcp.json` bus request helpers |
| `src/package.ts` | Extension package descriptor |
| `src/server.ts` | Server entrypoint for package discovery |
