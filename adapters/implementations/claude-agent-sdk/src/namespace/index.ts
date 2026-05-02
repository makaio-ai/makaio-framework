import { createClaudeConnectorNamespace } from '@makaio/ai-adapters-claude-shared';
import type { ClaudeConnectorBus } from '@makaio/ai-adapters-claude-shared';

/** @public Namespace registered for the `adapter:claude-code` connector implementation. */
export const ClaudeCodeConnectorNamespace = createClaudeConnectorNamespace('adapter:claude-code');
/** @public Typed subject tree exposed by {@link ClaudeCodeConnectorNamespace}. */
export const ClaudeCodeConnectorSubjects = ClaudeCodeConnectorNamespace.subjects;
/** @public Scoped bus type alias for the `adapter:claude-code` connector namespace. */
export type ClaudeCodeConnectorBus = ClaudeConnectorBus<'adapter:claude-code'>;
