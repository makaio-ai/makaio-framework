import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import { SessionSubjects } from '@makaio/contracts';

/**
 * Resolve adapter name for a subagent spawn request.
 *
 * If adapterName is provided it is normalized and returned.
 * Otherwise this inherits from the parent session lead agent (or first agent).
 * @param call - Call context of the handled spawn request
 * @param bus - Bus used to read parent session state
 * @param parentSessionId - Parent session identifier
 * @param adapterName - Explicit adapter name from spawn config
 * @returns Resolved adapter name, or undefined when inheritance is unavailable
 */
export async function resolveInheritedAdapterName(
  call: CallContext,
  bus: IMakaioBus,
  parentSessionId: string,
  adapterName?: string,
): Promise<string | undefined> {
  const explicitAdapterName = adapterName?.trim();
  if (explicitAdapterName) return explicitAdapterName;

  const { session } = await bus.request(call, SessionSubjects.get, { sessionId: parentSessionId });
  const inheritedAgent = session?.agents.find((agent) => agent.agentId === session.leadAgentId) ?? session?.agents[0];
  return inheritedAgent?.adapterName?.trim();
}
