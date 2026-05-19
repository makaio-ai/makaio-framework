import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { registerAdapterNameResolver } from './register-adapter-name-resolver.js';

describe('registerAdapterNameResolver', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    cleanup = registerAdapterNameResolver(MakaioBus);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    MakaioBus.__resetHandlers?.();
  });

  it('passes through requests that already include adapterId', async () => {
    let seenAdapterId: string | undefined;
    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `${ctx.payload.adapterName}-id` });
    });
    MakaioBus.on(AdapterSubjects.getCapabilities, (ctx) => {
      seenAdapterId = ctx.payload.adapterId;
      ctx.setResult({ capabilities: [], nativeTools: [] });
    });

    await MakaioBus.request(AdapterSubjects.getCapabilities, {
      adapterName: 'claude-code',
      adapterId: 'existing-id',
    });

    expect(seenAdapterId).toBe('existing-id');
  });

  it('resolves adapterName to adapterId through adapterRuntime.resolveId', async () => {
    let seenAdapterId: string | undefined;
    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `${ctx.payload.adapterName}-id` });
    });
    MakaioBus.on(AdapterSubjects.getCapabilities, (ctx) => {
      seenAdapterId = ctx.payload.adapterId;
      ctx.setResult({ capabilities: [], nativeTools: [] });
    });

    await MakaioBus.request(AdapterSubjects.getCapabilities, {
      adapterName: 'claude-code',
    });

    expect(seenAdapterId).toBe('claude-code-id');
  });

  it('passes through when runtime identity is unavailable', async () => {
    let seenAdapterId: string | undefined;
    MakaioBus.on(AdapterSubjects.getCapabilities, (ctx) => {
      seenAdapterId = ctx.payload.adapterId;
      ctx.setResult({ capabilities: [], nativeTools: [] });
    });

    await MakaioBus.request(AdapterSubjects.getCapabilities, {
      adapterName: 'unknown-adapter',
    });

    expect(seenAdapterId).toBeUndefined();
  });
});
