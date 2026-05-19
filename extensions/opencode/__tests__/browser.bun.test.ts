/**
 * Browser entrypoint tests for the OpenCode extension.
 *
 * OpenCode contributes server-side log import only, but its descriptor still
 * declares a browser entrypoint that must satisfy the browser loader factory
 * contract.
 */
import { createBusInstance } from '@makaio/bus-core';
import { describe, expect, it } from 'bun:test';
import browserContribution from '../src/browser.js';

describe('OpenCode browser entrypoint', () => {
  it('exports an empty browser contribution factory', () => {
    expect(typeof browserContribution).toBe('function');

    const contribution = browserContribution({ bus: createBusInstance() });

    expect(contribution).toEqual({});
  });
});
