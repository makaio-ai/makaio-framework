import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { MakaioBus, __resetWarnedSubjects } from '../index.js';
import { busContextOf } from '../kernel-api.js';

const WarningNamespace = createBusNamespace('warning-test', {
  event: z.object({ value: z.string() }),
  request: {
    request: z.object({ value: z.string() }),
    response: z.object({ ok: z.boolean() }),
  },
});

const ChannelLikeNamespace = createBusNamespace('channel:test-channel', {
  message: z.object({ value: z.string() }),
});

describe('unregistered namespace warning', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMakaioDebug = process.env['MAKAIO_DEBUG'];

  beforeEach(() => {
    process.env['MAKAIO_DEBUG'] = 'true';
    MakaioBus.__resetHandlers?.();
    busContextOf(MakaioBus)?.namespaceRegistry.__resetNamespaces?.();
    __resetWarnedSubjects?.();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalMakaioDebug === undefined) {
      delete process.env['MAKAIO_DEBUG'];
    } else {
      process.env['MAKAIO_DEBUG'] = originalMakaioDebug;
    }
    vi.restoreAllMocks();
  });

  it('warns once for an unregistered event subject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await MakaioBus.emit(MakaioBus.own('root'), WarningNamespace.subjects.event, { value: 'one' });
    await MakaioBus.emit(MakaioBus.own('root'), WarningNamespace.subjects.event, { value: 'two' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Subject 'warning-test.event' used"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Use manifest namespaces or ctx.namespaces.lease(definition). ' +
          'Hosts use IHostMakaioBus.registerNamespace(definition).',
      ),
    );
  });

  it('warns for unregistered request handlers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cleanup = MakaioBus.on(WarningNamespace.subjects.request, (ctx) => ctx.setResult({ ok: true }));
    cleanup();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Subject 'warning-test.request' used"));
  });

  it('does not warn for registered subjects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    MakaioBus.registerNamespace(WarningNamespace);

    await MakaioBus.emit(MakaioBus.own('root'), WarningNamespace.subjects.event, { value: 'registered' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn in production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';

    await MakaioBus.emit(MakaioBus.own('root'), WarningNamespace.subjects.event, { value: 'prod' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when MAKAIO_DEBUG is not enabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env['MAKAIO_DEBUG'];

    await MakaioBus.emit(MakaioBus.own('root'), WarningNamespace.subjects.event, { value: 'quiet' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for direct-channel namespaces', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await MakaioBus.emit(MakaioBus.own('root'), ChannelLikeNamespace.subjects.message, { value: 'encrypted' });

    expect(warn).not.toHaveBeenCalled();
  });
});
