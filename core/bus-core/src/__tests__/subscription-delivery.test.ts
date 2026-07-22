import { describe, expect, it } from 'vitest';
import { normalizeSubscriptionDeliveryClass } from '../registries/subscription-delivery.js';
import { createBusContext } from '../bus.js';
import { getMatchingRemoteEntries } from '../methods/request/getMatchingHandlers.js';

describe('subscription delivery metadata', () => {
  it('accepts only the explicit relayable value as relayable', () => {
    expect(normalizeSubscriptionDeliveryClass('relayable')).toBe('relayable');
  });

  it.each([undefined, null, '', 'unknown', 1])('normalizes malformed value %j to first-hop-only', (value) => {
    expect(normalizeSubscriptionDeliveryClass(value)).toBe('first-hop-only');
  });

  it('excludes only transports guarded by matching first-hop-only provenance on inbound dispatch', () => {
    const context = createBusContext();
    context.remoteRequestHandlers.set('hooks.*', [
      { transport: 'first-hop-owner', priority: 200 },
      { transport: 'relayable-owner', priority: 100 },
    ]);
    context.remoteSubscriptionDeliveryClasses.set(
      'hooks.*',
      new Map([
        ['first-hop-owner', 'relayable'],
        ['relayable-owner', 'relayable'],
      ]),
    );
    context.remoteSubscriptionDeliveryClasses.set('hooks.response', new Map([['first-hop-owner', 'first-hop-only']]));

    expect(getMatchingRemoteEntries(context, 'hooks.response', true)).toEqual([
      { transport: 'relayable-owner', priority: 100 },
    ]);
    expect(getMatchingRemoteEntries(context, 'hooks.response')).toEqual([
      { transport: 'first-hop-owner', priority: 200 },
      { transport: 'relayable-owner', priority: 100 },
    ]);
  });
});
