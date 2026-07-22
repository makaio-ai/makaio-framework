import { describe, expect, it } from 'vitest';
import { buildSubscribeMessage, buildUnsubscribeMessage, type SubscriptionEntry } from '../subscribe-message.js';

describe('buildSubscribeMessage', () => {
  it('produces a subscribe-typed message with subjects record', () => {
    const subscriptions = new Map<string, SubscriptionEntry>([['session.created', { priorities: [] }]]);

    const message = buildSubscribeMessage(subscriptions);

    expect(message.type).toBe('subscribe');
    expect(message.subjects).toEqual({ 'session.created': [] });
    expect(message.deliveryClasses).toEqual({ 'session.created': 'relayable' });
  });

  it('preserves handler priorities for multiple subjects', () => {
    const subscriptions = new Map<string, SubscriptionEntry>([
      ['ui.navigate', { priorities: [100, 200] }],
      ['adapter.event', { priorities: [50] }],
      ['session.created', { priorities: [] }],
    ]);

    const message = buildSubscribeMessage(subscriptions);

    expect(message.subjects).toEqual({
      'ui.navigate': [100, 200],
      'adapter.event': [50],
      'session.created': [],
    });
  });

  it('preserves explicit delivery classes and defaults omitted entries to relayable', () => {
    const subscriptions = new Map<string, SubscriptionEntry>([
      ['hook.response', { priorities: [100], deliveryClass: 'first-hop-only' }],
      ['session.created', { priorities: [] }],
    ]);

    expect(buildSubscribeMessage(subscriptions).deliveryClasses).toEqual({
      'hook.response': 'first-hop-only',
      'session.created': 'relayable',
    });
  });

  it('includes filters in the message when entries have filters', () => {
    const subscriptions = new Map<string, SubscriptionEntry>([
      [
        'mcp.event',
        {
          priorities: [],
          filter: { agentId: 'agent-123' },
        },
      ],
    ]);

    const message = buildSubscribeMessage(subscriptions);

    expect(message.filters).toEqual({
      'mcp.event': { agentId: 'agent-123' },
    });
  });

  it('omits the filters key entirely when no entries have filters', () => {
    const subscriptions = new Map<string, SubscriptionEntry>([['session.created', { priorities: [10] }]]);

    const message = buildSubscribeMessage(subscriptions);

    expect(Object.hasOwn(message, 'filters')).toBe(false);
  });

  it('only populates filters for subjects that have a filter defined', () => {
    const subscriptions = new Map<string, SubscriptionEntry>([
      ['session.created', { priorities: [] }],
      [
        'mcp.event',
        {
          priorities: [100],
          filter: { status: { $in: ['active', 'pending'] } },
        },
      ],
    ]);

    const message = buildSubscribeMessage(subscriptions);

    expect(message.subjects).toEqual({
      'session.created': [],
      'mcp.event': [100],
    });
    expect(message.filters).toEqual({
      'mcp.event': { status: { $in: ['active', 'pending'] } },
    });
  });

  it('produces a valid message with an empty subscriptions map', () => {
    const message = buildSubscribeMessage(new Map());

    expect(message.type).toBe('subscribe');
    expect(message.subjects).toEqual({});
    expect(message.deliveryClasses).toEqual({});
    expect(Object.hasOwn(message, 'filters')).toBe(false);
  });
});

describe('buildUnsubscribeMessage', () => {
  it('produces an unsubscribe-typed message with the given subjects record', () => {
    const subjects = { 'session.created': [] };

    const message = buildUnsubscribeMessage(subjects);

    expect(message.type).toBe('unsubscribe');
    expect(message.subjects).toEqual({ 'session.created': [] });
  });

  it('preserves handler priorities for multiple subjects', () => {
    const subjects = {
      'ui.navigate': [100, 200],
      'adapter.event': [50],
    };

    const message = buildUnsubscribeMessage(subjects);

    expect(message.subjects).toEqual({
      'ui.navigate': [100, 200],
      'adapter.event': [50],
    });
  });

  it('produces a valid message with an empty subjects record', () => {
    const message = buildUnsubscribeMessage({});

    expect(message.type).toBe('unsubscribe');
    expect(message.subjects).toEqual({});
  });
});
