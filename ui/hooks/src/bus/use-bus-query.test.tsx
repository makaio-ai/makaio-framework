// @vitest-environment jsdom
import { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBusNamespace, localSubject, type SubjectDefinition } from '@makaio/core';
import { createBusInstance, MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { BusProvider } from './bus-provider.js';
import { useBusQuery } from './use-bus-query.js';

const TestNamespace = createBusNamespace('ui-hooks-bus-query-test', {
  getValue: {
    request: z.object({ id: z.string() }),
    response: z.object({ value: z.string() }),
  },
  inspectJson: {
    request: z.object({ id: z.string() }),
    response: z.object({ isClassInstance: z.boolean(), value: z.string() }),
  },
  changed: z.object({ id: z.string() }),
});

const RemoteMetadataNamespace = createBusNamespace('ui-hooks-bus-query-metadata-test', {
  changed: z.object({ id: z.string() }),
});

const LocalMetadataNamespace = createBusNamespace('ui-hooks-bus-query-metadata-test', {
  changed: localSubject(z.object({ id: z.string() })),
});

interface MetadataRefetchProps {
  readonly refetchOn: readonly SubjectDefinition[];
}

class ClassRequestPayload {
  public constructor(public readonly id: string) {}
}

function wrapper(bus: IMakaioBus) {
  return ({ children }: { children: ReactNode }) => <BusProvider bus={bus}>{children}</BusProvider>;
}

describe('useBusQuery', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('requests data and exposes loading state', async () => {
    MakaioBus.on(TestNamespace.subjects.getValue, (ctx) => {
      ctx.setResult({ value: `value:${ctx.payload.id}` });
    });

    const { result } = renderHook(
      () =>
        useBusQuery({
          subject: TestNamespace.subjects.getValue,
          request: { id: 'a' },
        }),
      { wrapper: wrapper(MakaioBus) },
    );

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 'value:a' });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('round-trips request payloads through JSON before dispatch', async () => {
    MakaioBus.on(TestNamespace.subjects.inspectJson, (ctx) => {
      ctx.setResult({ isClassInstance: ctx.payload instanceof ClassRequestPayload, value: ctx.payload.id });
    });

    const { result } = renderHook(
      () =>
        useBusQuery({
          subject: TestNamespace.subjects.inspectJson,
          request: new ClassRequestPayload('a'),
        }),
      { wrapper: wrapper(MakaioBus) },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ isClassInstance: false, value: 'a' });
    });
  });

  it('reports non-serializable inline requests without a refetch loop', async () => {
    let renderCount = 0;
    let requestCount = 0;
    MakaioBus.on(TestNamespace.subjects.inspectJson, (ctx) => {
      requestCount += 1;
      ctx.setResult({ isClassInstance: false, value: ctx.payload.id });
    });

    const { result } = renderHook(
      () => {
        renderCount += 1;
        const request: { id: string; self?: unknown } = { id: 'a' };
        request.self = request;
        return useBusQuery({
          subject: TestNamespace.subjects.inspectJson,
          request,
        });
      },
      { wrapper: wrapper(MakaioBus) },
    );

    await waitFor(() => {
      expect(result.current.error?.message).toBe('useBusQuery request must be JSON-serializable.');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requestCount).toBe(0);
    expect(renderCount).toBeLessThanOrEqual(3);
  });

  it('refetches when a configured event fires', async () => {
    let value = 'first';
    MakaioBus.on(TestNamespace.subjects.getValue, (ctx) => {
      ctx.setResult({ value });
    });

    const { result } = renderHook(
      () =>
        useBusQuery({
          subject: TestNamespace.subjects.getValue,
          request: { id: 'a' },
          refetchOn: [TestNamespace.subjects.changed],
        }),
      { wrapper: wrapper(MakaioBus) },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 'first' });
    });

    value = 'second';
    await act(async () => {
      await MakaioBus.emit(TestNamespace.subjects.changed, { id: 'a' });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 'second' });
    });
  });

  it('keeps previous data when skipped after a successful request', async () => {
    MakaioBus.on(TestNamespace.subjects.getValue, (ctx) => {
      ctx.setResult({ value: `value:${ctx.payload.id}` });
    });

    const { result, rerender } = renderHook(
      ({ skip }) =>
        useBusQuery({
          subject: TestNamespace.subjects.getValue,
          request: { id: 'a' },
          skip,
        }),
      { initialProps: { skip: false }, wrapper: wrapper(MakaioBus) },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 'value:a' });
    });

    rerender({ skip: true });
    expect(result.current.data).toEqual({ value: 'value:a' });
  });

  it('does not refetch from events while skipped', async () => {
    let requestCount = 0;
    MakaioBus.on(TestNamespace.subjects.getValue, (ctx) => {
      requestCount += 1;
      ctx.setResult({ value: `value:${ctx.payload.id}` });
    });

    const { result } = renderHook(
      () =>
        useBusQuery({
          subject: TestNamespace.subjects.getValue,
          request: { id: 'a' },
          skip: true,
          refetchOn: [TestNamespace.subjects.changed],
        }),
      { wrapper: wrapper(MakaioBus) },
    );

    await act(async () => {
      await MakaioBus.emit(TestNamespace.subjects.changed, { id: 'a' });
    });

    expect(requestCount).toBe(0);

    await act(async () => {
      result.current.refetch();
    });

    expect(requestCount).toBe(1);
  });

  it('keeps the latest result when an older request resolves later', async () => {
    const resolvers = new Map<string, () => void>();
    MakaioBus.on(TestNamespace.subjects.getValue, async (ctx) => {
      await new Promise<void>((resolve) => {
        resolvers.set(ctx.payload.id, resolve);
      });
      ctx.setResult({ value: `value:${ctx.payload.id}` });
    });

    const { result, rerender } = renderHook(
      ({ id }) =>
        useBusQuery({
          subject: TestNamespace.subjects.getValue,
          request: { id },
        }),
      { initialProps: { id: 'slow' }, wrapper: wrapper(MakaioBus) },
    );

    rerender({ id: 'fast' });

    await act(async () => {
      resolvers.get('fast')?.();
    });
    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 'value:fast' });
    });

    await act(async () => {
      resolvers.get('slow')?.();
    });

    expect(result.current.data).toEqual({ value: 'value:fast' });
  });

  it('resubscribes when refetch subjects differ only by metadata', async () => {
    const bus = createBusInstance();
    let value = 'initial';
    bus.on(TestNamespace.subjects.getValue, (ctx) => {
      ctx.setResult({ value });
    });

    const { result, rerender } = renderHook(
      ({ refetchOn }: MetadataRefetchProps) =>
        useBusQuery({
          subject: TestNamespace.subjects.getValue,
          request: { id: 'a' },
          refetchOn,
        }),
      {
        initialProps: { refetchOn: [RemoteMetadataNamespace.subjects.changed] as readonly SubjectDefinition[] },
        wrapper: wrapper(bus),
      },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 'initial' });
    });

    value = 'remote-refetch';
    await act(async () => {
      await bus.emit(RemoteMetadataNamespace.subjects.changed, { id: 'a' });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 'remote-refetch' });
    });

    rerender({ refetchOn: [LocalMetadataNamespace.subjects.changed] as readonly SubjectDefinition[] });

    value = 'local-refetch';
    await act(async () => {
      await bus.emit(LocalMetadataNamespace.subjects.changed, { id: 'a' });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 'local-refetch' });
    });
  });
});
