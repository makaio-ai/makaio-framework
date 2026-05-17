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

## MCP

The adapter registers a pinned session with `McpSubjects.session.register` and
writes a `makaio` HTTP server entry into the project `.mcp.json` before spawning
Claude Code. On close it removes that generated entry and unregisters the pinned
MCP session.

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
