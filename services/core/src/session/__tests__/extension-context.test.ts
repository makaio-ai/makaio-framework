import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionExtensionContextImpl } from '../extension-context.js';

describe('SessionExtensionContextImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes read-only properties', () => {
    const ctx = new SessionExtensionContextImpl(MakaioBus, 'session-123', 'my-extension', 'turn-456', 'parent-789');

    expect(ctx.sessionId).toBe('session-123');
    expect(ctx.extensionId).toBe('my-extension');
    expect(ctx.turnId).toBe('turn-456');
    expect(ctx.parentSessionId).toBe('parent-789');
  });

  it('contributeContext collects contributions', () => {
    const ctx = new SessionExtensionContextImpl(MakaioBus, 'session-123', 'my-extension');

    ctx.contributeContext('handoff', 'summary text');
    ctx.contributeContext('predictedTools', ['read', 'write']);

    const contributions = ctx.getContributions();
    expect(contributions.handoff).toBe('summary text');
    expect(contributions.predictedTools).toEqual(['read', 'write']);
  });
});
