import { AgentNamespace, AgentSchemas } from '../agent/index.js';
import { ApprovalNamespace, ApprovalSchemas } from '../approval/index.js';
import { SessionNamespace, SessionSchemas } from '../session/index.js';
import { ToolNamespace, ToolSchemas } from '../tool/index.js';
import type { ProtocolNamespaceCatalog } from './types.js';

/**
 * Explicit publication policy for the public SDK protocol manifest.
 */
export const PublicProtocolNamespaces = [
  { namespace: AgentNamespace.name, schemas: AgentSchemas },
  { namespace: ApprovalNamespace.name, schemas: ApprovalSchemas },
  {
    namespace: SessionNamespace.name,
    schemas: SessionSchemas,
    subjects: [
      'sendMessage',
      'restartAgents',
      'created',
      'agent.added',
      'turn.await',
      'turn.started',
      'turn.completed',
      'user_message.sent',
    ],
  },
  { namespace: ToolNamespace.name, schemas: ToolSchemas },
] as const satisfies ProtocolNamespaceCatalog;
