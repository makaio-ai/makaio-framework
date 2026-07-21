import type { IMakaioBus } from '@makaio/bus-core';
import { AgentStorageSubjects } from '@makaio/services-core/session';

/**
 * Publish an optional agent activity-status update without coupling turn progress to storage availability.
 * @param bus - Global bus that may route to an agent-storage owner.
 * @param agentId - Agent whose activity status changed.
 * @param status - Current activity state.
 */
export function updateAgentActivityStatusBestEffort(bus: IMakaioBus, agentId: string, status: 'active' | 'idle'): void {
  void bus.requestOptional(AgentStorageSubjects.updateStatus, { agentId, status }).catch(() => undefined);
}
