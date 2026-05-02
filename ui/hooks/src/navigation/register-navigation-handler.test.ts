// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusContext, createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { UiSubjects } from '@makaio/ui-kernel';
import { registerNavigationHandler } from './register-navigation-handler.js';

describe('registerNavigationHandler', () => {
  let bus: IMakaioBus;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    cleanup = undefined;
    bus = createBusInstance({ context: createBusContext() });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it('opens the derived browser target and returns navigated', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    cleanup = registerNavigationHandler(bus);

    const result = await bus.request(UiSubjects.navigate, {
      url: 'https://example.com/project/abc-123',
    });

    // deriveBrowserTarget receives the pathname '/project/abc-123' → 'project-abc-123'
    expect(window.open).toHaveBeenCalledWith(
      'https://example.com/project/abc-123',
      'project-abc-123',
      'noopener,noreferrer',
    );
    expect(result).toEqual({ action: 'navigated' });
  });

  it('resolves relative URLs against window.location.href', async () => {
    const mockOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    cleanup = registerNavigationHandler(bus);

    const result = await bus.request(UiSubjects.navigate, { url: '/project/abc-123' });

    expect(result).toEqual({ action: 'navigated' });
    // The resolved URL must use the http: protocol (from window.location.href in jsdom)
    // and include the path. Exact origin depends on jsdom configuration.
    const calledUrl = mockOpen.mock.calls[0]?.[0] as string;
    expect(calledUrl).toMatch(/^https?:\/\/.+\/project\/abc-123$/);
  });

  it('throws for javascript: scheme', async () => {
    const mockOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    cleanup = registerNavigationHandler(bus);

    await expect(bus.request(UiSubjects.navigate, { url: 'javascript:alert(1)' })).rejects.toThrow(
      'Unsafe URL protocol',
    );
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
