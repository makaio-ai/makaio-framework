/**
 * React hook exposing the registered automation trigger catalog.
 *
 * Projects the `automation-triggers.list` RPC response down to the descriptor
 * array the Builder renders, and refetches whenever the registry announces a
 * change so the catalog cannot go stale while an extension activates or stops.
 * @packageDocumentation
 */

import { useMemo } from 'react';
import { AutomationTriggerSubjects, type AutomationTriggerDescriptor } from '@makaio/contracts';
import { useBusQuery, type UseBusQueryResult } from '../bus/use-bus-query.js';

/**
 * Refetch triggers for the catalog query.
 *
 * Hoisted to module scope so the subscription identity is stable across renders
 * instead of being rebuilt from an inline literal on every pass.
 */
const REFETCH_ON = [AutomationTriggerSubjects.changed] as const;

/** Empty request payload, hoisted for a stable query dependency. */
const LIST_REQUEST = {} as const;

/**
 * Result of {@link useAutomationTriggerTypes}.
 *
 * Mirrors {@link UseBusQueryResult} but narrows `data` to the descriptor array,
 * so callers never reach through the RPC envelope.
 */
export type UseAutomationTriggerTypesResult = UseBusQueryResult<readonly AutomationTriggerDescriptor[]>;

/**
 * Query the registered automation trigger descriptors.
 *
 * The descriptors are the only serializable projection of the live trigger
 * registry, so the Builder catalog is derived from executable triggers rather
 * than from a parallel declarative catalog that could drift.
 * @returns Reactive query state whose `data` is the descriptor catalog.
 * @example
 * ```tsx
 * function TriggerPalette() {
 *   const { data, loading, error } = useAutomationTriggerTypes();
 *   if (loading) return <Spinner />;
 *   if (error) return <ErrorNotice error={error} />;
 *   return <ul>{data?.map((trigger) => <li key={trigger.kind}>{trigger.label}</li>)}</ul>;
 * }
 * ```
 */
export function useAutomationTriggerTypes(): UseAutomationTriggerTypesResult {
  const { data, loading, error, refetch } = useBusQuery({
    subject: AutomationTriggerSubjects.list,
    request: LIST_REQUEST,
    refetchOn: REFETCH_ON,
  });

  return useMemo(() => ({ data: data?.triggers, loading, error, refetch }), [data, loading, error, refetch]);
}
