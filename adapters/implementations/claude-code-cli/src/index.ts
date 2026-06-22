/**
 * Claude Code CLI AI Adapter
 *
 * Provides integration with Claude via the `claude` CLI binary using
 * stdio JSON streaming instead of the Agent SDK.
 *
 * Architecture (three-layer):
 * - ClaudeCodeCliAdapter: Domain-level adapter extending AIAdapter
 * - ClaudeCodeCliAgent: AIAgent subclass that wires connector events to global subjects
 * - ClaudeCliConnector: Spawns `claude -p` processes and consumes JSONL stdout
 *
 * The CLI emits identical event shapes to the SDK — the shared claude-shared
 * namespace schemas describe them exactly — so the shared agent base class
 * handles all event routing without modification.
 *
 * MCP integration is handled via bus RPC to `McpSubjects.session.register` /
 * `McpSubjects.session.unregister`. The singleton HTTP MCP server is managed
 * by `McpServerBridgeService` — the adapter is a pure consumer.
 */

// Adapter class and factory
export {
  ClaudeCodeCliAdapter,
  createClaudeCliAdapter,
  ClaudeCodeCliAdapterName,
  type ClaudeCodeCliAdapterConfig,
} from './adapter.js';

// Agent class
export { ClaudeCodeCliAgent } from './agent.js';

// Connector class
export { ClaudeCliConnector } from './connector.js';

// Namespace and subjects
export {
  ClaudeCodeCliConnectorSubjects,
  ClaudeCodeCliConnectorNamespace,
  type ClaudeCodeCliConnectorBus,
} from './namespace/index.js';

// Types
export type { ClaudeCliAgentConfig } from './types.js';

// Schemas
export { ClaudeCodeCliProviderConfigSchema, type ClaudeCodeCliProviderConfig } from './schemas.js';
