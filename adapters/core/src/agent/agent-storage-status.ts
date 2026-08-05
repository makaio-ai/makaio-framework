import type { IMakaioBus } from '@makaio/bus-core';
import { AgentStorageSubjects } from '@makaio/services-core/session';

/**
 * The states an activity stamp is allowed to move between.
 *
 * `active` and `idle` are the two halves of *one* domain — "a turn is running"
 * versus "no turn is running" — and this write is the only writer of either.
 * Every other status (`starting`, `dead`, `disposed`) belongs to the start and
 * teardown lifecycle, which is owned elsewhere, and an activity stamp has
 * nothing to say about it.
 */
const ACTIVITY_STATES = ['idle', 'active'] as const;

/**
 * Publish an optional agent activity-status update without coupling turn progress to storage availability.
 *
 * **Compare-and-swapped, not written.** The call is fire-and-forget, so it can
 * land arbitrarily late — after the start that owns the row has been retired,
 * after a teardown compare-and-swapped it to `dead`, or after a removal disposed
 * it. An unconditional write there is a resurrection: the row advertises an
 * agent this runtime can drive while its connector is stopped and its ownership
 * generation is abandoned, which is exactly the phantom the reserved-start
 * discipline exists to remove. Restricting the expectation to the two activity
 * states makes the stamp advisory **within its own domain** and inert outside
 * it, without introducing any new state.
 *
 * Nothing legitimate is lost by the narrowing. A start reaches its first turn
 * only after its own `starting → idle` commit — the caller-owned paths commit at
 * their settlement, and the adapter-owned path writes the whole `idle` record
 * when its connector is live — so `starting → active` is never a transition a
 * turn has to make. A refused stamp means the row left the activity domain while
 * the turn ran, and the party that moved it out is the one entitled to say where
 * it goes next.
 * @param bus - Global bus that may route to an agent-storage owner.
 * @param agentId - Agent whose activity status changed.
 * @param status - Current activity state.
 */
export function updateAgentActivityStatusBestEffort(bus: IMakaioBus, agentId: string, status: 'active' | 'idle'): void {
  void bus
    .requestOptional(AgentStorageSubjects.updateStatus, { agentId, status, expectedStatus: [...ACTIVITY_STATES] })
    .catch(() => undefined);
}
