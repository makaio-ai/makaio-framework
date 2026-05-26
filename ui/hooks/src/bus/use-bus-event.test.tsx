// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { BusProvider } from './bus-provider.js';
import { useBusEvent } from './use-bus-event.js';

const TestNamespace = createBusNamespace('ui-hooks-bus-event-test', {
  changed: z.object({ value: z.string() }),
});

function wrapper(bus: IMakaioBus) {
  return ({ children }: { children: ReactNode }) => <BusProvider bus={bus}>{children}</BusProvider>;
}

describe('useBusEvent', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('subscribes to events and uses the latest handler without resubscribing', async () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const { rerender } = renderHook(({ handler }) => useBusEvent(TestNamespace.subjects.changed, handler), {
      initialProps: { handler: firstHandler },
      wrapper: wrapper(MakaioBus),
    });

    rerender({ handler: secondHandler });

    await act(async () => {
      await MakaioBus.emit(TestNamespace.subjects.changed, { value: 'next' });
    });

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler.mock.calls[0]?.[0].payload).toEqual({ value: 'next' });
  });

  it('unsubscribes when the component unmounts', async () => {
    const handler = vi.fn();

    const { unmount } = renderHook(() => useBusEvent(TestNamespace.subjects.changed, handler), {
      wrapper: wrapper(MakaioBus),
    });

    unmount();

    await act(async () => {
      await MakaioBus.emit(TestNamespace.subjects.changed, { value: 'after-unmount' });
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
