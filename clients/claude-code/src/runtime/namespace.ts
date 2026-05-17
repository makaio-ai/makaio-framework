import { createClientNamespace } from '@makaio/clients-core';
import { ClaudeCodeConfigSchemas } from '../schemas/config.js';
import { ClaudeCodeStatuslineRawPayloadSchema } from '../schemas/statusline.js';
import { ClaudeCodeWiringSchemas } from '../schemas/wiring.js';

/**
 * Claude Code-specific client namespace for raw client-native events.
 *
 * Uses {@link createClientNamespace} with `additionalSchemas` to register the
 * following subjects:
 * - `hook.received` — raw catch-all hook ingress for all Claude Code hook
 *   events (pre-wired by the shared `createClientNamespace` factory).
 * - `statusline.received` — Claude Code status-line payloads forwarded by
 *   the statusline command bridge.
 * - `config.statusline.list` — read effective + per-scope status-line config.
 * - `config.statusline.set` — write a status-line value at a given scope.
 * - `config.hooks.list` — read effective + per-scope hook config.
 * - `config.hooks.add` — append a hook to a given scope and event.
 * - `config.hooks.remove` — remove hooks matching a command substring.
 * - `config.extensions.list` — list installed extensions with enabled state.
 * - `config.mcpServers.list` — list MCP servers from `.mcp.json`.
 * - `config.mcpServers.add` — add/replace an MCP server in `.mcp.json`.
 * - `config.mcpServers.remove` — remove an MCP server from `.mcp.json`.
 * - `wiring.list` — list all wiring entries with installation status.
 * - `wiring.apply` — install wiring entries into the target scope.
 * - `wiring.remove` — uninstall wiring entries from the target scope.
 *
 * All subjects live in `client:claude-code.*` and are never promoted to
 * the global `client.*` namespace directly.  Downstream normalizers translate
 * `hook.received` events into `client.session.*` observations.
 */
const claudeCodeNamespace = createClientNamespace('claude-code', {
  'statusline.received': ClaudeCodeStatuslineRawPayloadSchema,
  ...ClaudeCodeConfigSchemas,
  ...ClaudeCodeWiringSchemas,
});

/**
 * Typed subjects for the Claude Code client namespace.
 */
export const ClaudeCodeClientSubjects = claudeCodeNamespace.subjects;
