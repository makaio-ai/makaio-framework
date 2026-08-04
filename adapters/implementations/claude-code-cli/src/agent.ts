import {
  ClaudeCodeAgent as ClaudeCodeAgentBase,
  type ClaudeConnectorNamespace,
} from '@makaio/ai-adapters-claude-shared';
import { ClaudeCliConnector } from './connector.js';
import { ClaudeCodeCliConnectorNamespace } from './namespace/index.js';

/**
 * Claude Code CLI Agent - Concrete agent for the adapter:claude-code-cli namespace.
 *
 * Extends the shared ClaudeCodeAgent base class, providing only the
 * namespace-specific subjects seam. All event wiring, content block handling,
 * and usage tracking are inherited from the base.
 *
 * Event Flow:
 * - ClaudeCliConnector emits JSONL events to scoped bus (adapter:claude-code-cli.*)
 * - ClaudeCodeAgentBase (base) processes and routes to global bus (agent.*)
 * - Downstream consumers subscribe to normalized agent.* subjects
 */
export class ClaudeCodeCliAgent extends ClaudeCodeAgentBase<'adapter:claude-code-cli', ClaudeCliConnector> {
  /**
   * Return the connector namespace subjects for this adapter.
   *
   * Provides the adapter:claude-code-cli subjects to the shared base class
   * so it can subscribe to the correct scoped bus events.
   * @returns Subjects from the adapter:claude-code-cli namespace
   */
  protected getSubjects(): ClaudeConnectorNamespace<'adapter:claude-code-cli'>['subjects'] {
    return ClaudeCodeCliConnectorNamespace.subjects;
  }
}
