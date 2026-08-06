// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  AutomationTriggerSubjects,
  createAutomationTriggerDescriptor,
  defineAutomationTrigger,
  type AutomationTriggerDescriptor,
} from '@makaio/contracts';
import { z } from 'zod';
import { BusProvider } from '../bus/bus-provider.js';
import { useAutomationTriggerTypes } from './useAutomationTriggerTypes.js';

/**
 * A real trigger definition, so the descriptor under test is produced by the
 * canonical descriptor projection rather than hand-written in the test.
 */
const definition = defineAutomationTrigger({
  kind: 'coderabbit.review-posted',
  label: 'CodeRabbit review posted',
  description: 'Emits a validated CodeRabbit review event for a configured repository.',
  categories: ['Code review'],
  paramsSchema: z.object({ repository: z.string().min(1) }),
  eventSchema: z.object({ repository: z.string() }),
  activate: async () => () => undefined,
});

/**
 * Registers the catalog RPC and counts how often it is served.
 * @param bus - Bus to register the handler on.
 * @param descriptor - Descriptor returned by the catalog.
 * @returns The request counter and a cleanup function.
 */
function serveCatalog(
  bus: IMakaioBus,
  descriptor: AutomationTriggerDescriptor,
): { readonly reads: () => number; readonly stop: () => void } {
  let listRequests = 0;
  const stop = bus.on(AutomationTriggerSubjects.list, (ctx) => {
    listRequests += 1;
    ctx.setResult({ triggers: [descriptor] });
  });
  return { reads: () => listRequests, stop };
}

/**
 * Builds a provider wrapper bound to the given bus.
 * @param bus - Bus supplied to the hook under test.
 * @returns React wrapper component.
 */
function makeWrapper(bus: IMakaioBus) {
  return ({ children }: { children: ReactNode }) => <BusProvider bus={bus}>{children}</BusProvider>;
}

describe('useAutomationTriggerTypes', () => {
  it('projects the catalog RPC to the descriptor array and refetches on registry changes', async () => {
    const bus = createBusInstance();
    const descriptor = createAutomationTriggerDescriptor(definition);
    const catalog = serveCatalog(bus, descriptor);

    const { result } = renderHook(() => useAutomationTriggerTypes(), { wrapper: makeWrapper(bus) });

    await waitFor(() => expect(result.current.data).toEqual([descriptor]));
    expect(catalog.reads()).toBe(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();

    await bus.emit(AutomationTriggerSubjects.changed, {
      owner: 'coderabbit',
      revision: 2,
      kinds: ['coderabbit.review-posted'],
      reason: 'registered',
    });

    await waitFor(() => expect(catalog.reads()).toBe(2));
    await waitFor(() => expect(result.current.data).toEqual([descriptor]));

    catalog.stop();
  });

  it('surfaces a catalog failure as query error state', async () => {
    const bus = createBusInstance();
    const stop = bus.on(AutomationTriggerSubjects.list, () => {
      throw new Error('registry unavailable');
    });

    const { result } = renderHook(() => useAutomationTriggerTypes(), { wrapper: makeWrapper(bus) });

    await waitFor(() => expect(result.current.error?.message).toContain('registry unavailable'));
    expect(result.current.data).toBeUndefined();

    stop();
  });
});
