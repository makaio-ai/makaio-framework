import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { MakaioBus, __resetWarnedSubjects } from '../index.js';

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

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.getContext()?.namespaceRegistry.__resetNamespaces?.();
    __resetWarnedSubjects?.();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    mock.restore();
  });

  it('warns once for an unregistered event subject', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    await MakaioBus.emit(WarningNamespace.subjects.event, { value: 'one' });
    await MakaioBus.emit(WarningNamespace.subjects.event, { value: 'two' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Subject 'warning-test.event' used"));
  });

  it('warns for unregistered request handlers', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    const cleanup = MakaioBus.on(WarningNamespace.subjects.request, (ctx) => ctx.setResult({ ok: true }));
    cleanup();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Subject 'warning-test.request' used"));
  });

  it('does not warn for registered subjects', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    MakaioBus.registerNamespace(WarningNamespace);

    await MakaioBus.emit(WarningNamespace.subjects.event, { value: 'registered' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn in production', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';

    await MakaioBus.emit(WarningNamespace.subjects.event, { value: 'prod' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for direct-channel namespaces', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    await MakaioBus.emit(ChannelLikeNamespace.subjects.message, { value: 'encrypted' });

    expect(warn).not.toHaveBeenCalled();
  });
});
