import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { ValidationError } from '../errors/validation-error.js';

describe('validation modes', () => {
  beforeEach(() => {
    MakaioBus.getContext()?.namespaceRegistry.__resetNamespaces?.();
  });

  it('strict mode throws on invalid payload', async () => {
    const ns = MakaioBus.registerNamespace(
      createBusNamespace('val-strict', {
        event: z.object({ name: z.string() }),
      }),
    );
    const bus = await ns.scopedBus();

    await expect(bus.emit(ns.subjects.event, { name: 123 } as never)).rejects.toThrow(ValidationError);
  });

  it('lenient mode calls onSchemaViolation instead of throwing', async () => {
    const violations: Array<{ subject: string; issues: Array<{ path: string; message: string }> }> = [];
    const ns = MakaioBus.registerNamespace(
      createBusNamespace(
        'val-lenient',
        { event: z.object({ name: z.string() }) },
        {
          busValidationMode: 'lenient',
          onSchemaViolation: (report) => {
            violations.push({
              subject: report.subject,
              issues: (report.issues as Array<{ path: PropertyKey[]; message: string }>).map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            });
          },
        },
      ),
    );
    const bus = await ns.scopedBus();

    const received: unknown[] = [];
    bus.on(ns.subjects.event, ({ payload }) => {
      received.push(payload);
    });

    await bus.emit(ns.subjects.event, { name: 123 } as never);

    expect(violations).toHaveLength(1);
    expect(violations[0].subject).toBe('val-lenient.event');
    expect(received).toHaveLength(1); // event still delivered
  });

  it('skip mode performs no validation at all', async () => {
    const ns = MakaioBus.registerNamespace(
      createBusNamespace('val-skip', { event: z.object({ name: z.string() }) }, { busValidationMode: 'skip' }),
    );
    const bus = await ns.scopedBus();

    const received: unknown[] = [];
    bus.on(ns.subjects.event, ({ payload }) => {
      received.push(payload);
    });

    await bus.emit(ns.subjects.event, { name: 123 } as never);

    expect(received).toHaveLength(1); // no throw, no callback
  });

  it('strict is the default when no mode is specified', async () => {
    const ns = MakaioBus.registerNamespace(
      createBusNamespace('val-default', {
        event: z.object({ name: z.string() }),
      }),
    );
    const bus = await ns.scopedBus();

    await expect(bus.emit(ns.subjects.event, { name: 123 } as never)).rejects.toThrow(ValidationError);
  });
});

describe('request validation modes', () => {
  beforeEach(() => {
    MakaioBus.getContext()?.namespaceRegistry.__resetNamespaces?.();
  });

  it('strict mode throws on invalid request payload', async () => {
    const ns = MakaioBus.registerNamespace(
      createBusNamespace('req-strict', {
        rpc: { request: z.object({ input: z.string() }), response: z.object({ output: z.string() }) },
      }),
    );
    const bus = await ns.scopedBus();

    await expect(bus.request(ns.subjects.rpc, { input: 123 } as never)).rejects.toThrow(ValidationError);
  });

  it('lenient mode calls onSchemaViolation for request payloads', async () => {
    const violations: string[] = [];
    const ns = MakaioBus.registerNamespace(
      createBusNamespace(
        'req-lenient',
        { rpc: { request: z.object({ input: z.string() }), response: z.object({ output: z.string() }) } },
        {
          busValidationMode: 'lenient',
          onSchemaViolation: (report) => violations.push(report.subject),
        },
      ),
    );
    const bus = await ns.scopedBus();
    bus.on(ns.subjects.rpc, (ctx) => ctx.setResult({ output: 'ok' }));

    const result = await bus.request(ns.subjects.rpc, { input: 123 } as never);

    expect(violations).toContain('req-lenient.rpc');
    expect(result).toEqual({ output: 'ok' });
  });

  it('skip mode performs no validation for request payloads', async () => {
    const ns = MakaioBus.registerNamespace(
      createBusNamespace(
        'req-skip',
        { rpc: { request: z.object({ input: z.string() }), response: z.object({ output: z.string() }) } },
        {
          busValidationMode: 'skip',
        },
      ),
    );
    const bus = await ns.scopedBus();
    bus.on(ns.subjects.rpc, (ctx) => ctx.setResult({ output: 'ok' }));

    const result = await bus.request(ns.subjects.rpc, { input: 123 } as never);

    expect(result).toEqual({ output: 'ok' });
  });
});

describe('namespace validation config resolution', () => {
  beforeEach(() => {
    MakaioBus.getContext()?.namespaceRegistry.__resetNamespaces?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the longest matching namespace validation config', () => {
    const parentViolation = vi.fn();
    const childViolation = vi.fn();

    MakaioBus.registerNamespace(
      createBusNamespace(
        'validation-parent',
        { event: z.object({ name: z.string() }) },
        { busValidationMode: 'lenient', onSchemaViolation: parentViolation },
      ),
    );
    MakaioBus.registerNamespace(
      createBusNamespace(
        'validation-parent.child',
        { event: z.object({ name: z.string() }) },
        { busValidationMode: 'lenient', onSchemaViolation: childViolation },
      ),
    );

    expect(MakaioBus.getContext()?.namespaceRegistry.getValidationConfig('validation-parent.child.event')).toEqual({
      mode: 'lenient',
      onViolation: childViolation,
    });
  });

  it('lets an explicit strict child override a lenient parent namespace', () => {
    const parentViolation = vi.fn();

    MakaioBus.registerNamespace(
      createBusNamespace(
        'validation-strict-parent',
        { event: z.object({ name: z.string() }) },
        { busValidationMode: 'lenient', onSchemaViolation: parentViolation },
      ),
    );
    MakaioBus.registerNamespace(
      createBusNamespace(
        'validation-strict-parent.child',
        { event: z.object({ name: z.string() }) },
        { busValidationMode: 'strict' },
      ),
    );

    expect(
      MakaioBus.getContext()?.namespaceRegistry.getValidationConfig('validation-strict-parent.child.event'),
    ).toEqual({
      mode: 'strict',
    });
  });

  it('warns when duplicate namespace registration changes validation config', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    MakaioBus.registerNamespace(createBusNamespace('validation-duplicate', { event: z.object({ name: z.string() }) }));
    MakaioBus.registerNamespace(
      createBusNamespace(
        'validation-duplicate',
        { event: z.object({ name: z.string() }) },
        { busValidationMode: 'skip' },
      ),
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different validation settings'));
  });

  it('warns when duplicate namespace registration changes a same-key schema', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    MakaioBus.registerNamespace(
      createBusNamespace('validation-schema-duplicate', { event: z.object({ name: z.string() }) }),
    );
    MakaioBus.registerNamespace(
      createBusNamespace('validation-schema-duplicate', { event: z.object({ name: z.string().min(1) }) }),
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('changed schemas: event'));
  });
});

describe('broadcast validation modes', () => {
  beforeEach(() => {
    MakaioBus.getContext()?.namespaceRegistry.__resetNamespaces?.();
  });

  it('strict mode throws on invalid broadcast request payload', async () => {
    const ns = MakaioBus.registerNamespace(
      createBusNamespace('broadcast-strict', {
        collect: { request: z.object({ input: z.string() }), response: z.object({ output: z.string() }) },
      }),
    );

    await expect(MakaioBus.broadcast(ns.subjects.collect, { input: 123 } as never)).rejects.toThrow(ValidationError);
  });

  it('lenient mode reports broadcast request and response violations without dropping responses', async () => {
    const violations: Array<{ subject: string; paths: string[] }> = [];
    const ns = MakaioBus.registerNamespace(
      createBusNamespace(
        'broadcast-lenient',
        { collect: { request: z.object({ input: z.string() }), response: z.object({ output: z.string() }) } },
        {
          busValidationMode: 'lenient',
          onSchemaViolation: (report) => {
            violations.push({
              subject: report.subject,
              paths: (report.issues as Array<{ path: PropertyKey[] }>).map((issue) => issue.path.join('.')),
            });
          },
        },
      ),
    );
    const bus = await ns.scopedBus();
    bus.on(ns.subjects.collect, (ctx) => {
      ctx.identify?.('local');
      ctx.setResult({ output: 123 } as never);
    });

    const results = await MakaioBus.broadcast(ns.subjects.collect, { input: 123 } as never);

    expect(violations).toEqual([
      { subject: 'broadcast-lenient.collect', paths: ['input'] },
      { subject: 'broadcast-lenient.collect', paths: ['output'] },
    ]);
    expect(results).toEqual([{ nodeId: 'local', payload: { output: 123 } }]);
  });

  it('strict mode throws on invalid broadcast response payload', async () => {
    const ns = MakaioBus.registerNamespace(
      createBusNamespace('broadcast-response-strict', {
        collect: { request: z.object({ input: z.string() }), response: z.object({ output: z.string() }) },
      }),
    );
    const bus = await ns.scopedBus();
    bus.on(ns.subjects.collect, (ctx) => {
      ctx.identify?.('local');
      ctx.setResult({ output: 123 } as never);
    });

    await expect(MakaioBus.broadcast(ns.subjects.collect, { input: 'valid' })).rejects.toThrow(ValidationError);
  });

  it('validates broadcast responses after incremental extendResult calls complete', async () => {
    const ns = MakaioBus.registerNamespace(
      createBusNamespace('broadcast-extend', {
        collect: {
          request: z.object({ input: z.string() }),
          response: z.object({ output: z.string(), count: z.number() }),
        },
      }),
    );
    const bus = await ns.scopedBus();
    bus.on(ns.subjects.collect, (ctx) => {
      ctx.identify?.('extended');
      ctx.extendResult({ output: 'ok' });
      ctx.extendResult({ count: 1 });
    });

    const results = await MakaioBus.broadcast(ns.subjects.collect, { input: 'valid' });

    expect(results).toEqual([{ nodeId: 'extended', payload: { output: 'ok', count: 1 } }]);
  });
});
