/** Bus-safe runtime snapshot conversion. @packageDocumentation */

import type { SupervisorRuntimeSnapshot } from '@makaio/contracts/native-session-supervisor';
import type { SupervisorRuntime } from './types.js';

/**
 * Convert an in-memory {@link SupervisorRuntime} to a bus-safe
 * {@link SupervisorRuntimeSnapshot} for status responses.
 * @param runtime - Full in-memory runtime record.
 * @returns Snapshot suitable for bus transmission.
 */
export function toSnapshot(runtime: SupervisorRuntime): SupervisorRuntimeSnapshot {
  return {
    supervisorSessionId: runtime.supervisorSessionId,
    clientId: runtime.clientId,
    pid: runtime.pid,
    status: runtime.status,
    cwd: runtime.cwd,
    ...(runtime.sessionId !== undefined && { sessionId: runtime.sessionId }),
    ...(runtime.adapterSessionId !== undefined && { adapterSessionId: runtime.adapterSessionId }),
    startedAt: runtime.startedAt,
    ...(runtime.stoppedAt !== undefined && { stoppedAt: runtime.stoppedAt }),
  };
}
