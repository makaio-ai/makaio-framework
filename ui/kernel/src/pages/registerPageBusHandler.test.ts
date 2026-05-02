import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { PageSubjects } from './namespace.js';
import { pageDefinitionRegistry } from './PageDefinitionRegistry.js';
import { registerPageBusHandler } from './registerPageBusHandler.js';

const cleanups: Array<() => void> = [];

beforeEach(() => {
  MakaioBus.__resetHandlers?.();
  pageDefinitionRegistry.clear();
});

afterEach(() => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) cleanup();
  }
  pageDefinitionRegistry.clear();
  MakaioBus.__resetHandlers?.();
});

describe('registerPageBusHandler', () => {
  it('returns surfaces="all" only when page has no surface config', async () => {
    pageDefinitionRegistry.register({
      id: 'all-page',
      name: 'All Page',
      mode: 'switch',
      level: 'any',
      component: async () => ({ default: () => null }),
    });

    cleanups.push(registerPageBusHandler(MakaioBus));

    const { pages } = await MakaioBus.request(PageSubjects.list, {});
    const allPage = pages.find((p) => p.id === 'all-page');

    expect(allPage?.surfaces).toBe('all');
  });

  it('does not mislabel capability-only pages as surfaces="all"', async () => {
    pageDefinitionRegistry.register({
      id: 'cap-page',
      name: 'Capability Page',
      mode: 'switch',
      level: 'any',
      surface: { requiredCapabilities: ['dom'] },
      component: async () => ({ default: () => null }),
    });

    cleanups.push(registerPageBusHandler(MakaioBus));

    const { pages } = await MakaioBus.request(PageSubjects.list, {});
    const capPage = pages.find((p) => p.id === 'cap-page');

    expect(capPage?.surfaces).toBeUndefined();
  });
});
