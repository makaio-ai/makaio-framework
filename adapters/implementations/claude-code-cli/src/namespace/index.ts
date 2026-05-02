import { createClaudeConnectorNamespace } from '@makaio/ai-adapters-claude-shared';
import type { ClaudeConnectorBus } from '@makaio/ai-adapters-claude-shared';

export const ClaudeCodeCliConnectorNamespace = createClaudeConnectorNamespace('adapter:claude-code-cli');
export const ClaudeCodeCliConnectorSubjects = ClaudeCodeCliConnectorNamespace.subjects;
export type ClaudeCodeCliConnectorBus = ClaudeConnectorBus<'adapter:claude-code-cli'>;
