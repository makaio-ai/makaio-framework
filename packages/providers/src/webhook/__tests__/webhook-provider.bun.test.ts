import { describe, it, expect, expectTypeOf } from 'bun:test';
import type { IMakaioBus } from '@makaio/bus-core';
import type { IWebhookProvider, WebhookEvent } from '../index.js';

/**
 * Minimal concrete implementation of IWebhookProvider for interface-contract testing.
 *
 * `core/providers/src/webhook` currently exports only the shared interface and
 * event type. This test intentionally validates the public contract shape in
 * isolation; concrete provider behavior belongs in provider-specific packages.
 */
class TestWebhookProvider implements IWebhookProvider {
  public readonly capabilities = {
    platform: 'github' as const,
    supportedEvents: ['push', 'pull_request', 'issue_comment'],
  };

  private readonly secret: string;

  public constructor(secret: string = 'test-secret') {
    this.secret = secret;
  }

  public async verifySignature(payload: string, signature: string): Promise<boolean> {
    return Boolean(payload) && signature.includes(this.secret);
  }

  public async parseWebhook(payload: unknown): Promise<WebhookEvent> {
    if (typeof payload !== 'object' || payload === null) {
      return {
        platform: 'github',
        event: 'unknown',
        action: undefined,
        data: undefined,
      };
    }

    const raw = payload as Record<string, unknown>;
    return {
      platform: 'github',
      event: String(raw['event'] ?? 'unknown'),
      action: raw['action'] !== undefined ? String(raw['action']) : undefined,
      data: raw['data'],
    };
  }

  public registerHandlers(_bus: IMakaioBus): void {
    // Registration logic would call bus.on() for each supported event.
    // This contract test only asserts the public method shape is callable.
  }
}

describe('IWebhookProvider contract (via TestWebhookProvider)', () => {
  describe('capabilities', () => {
    it('exposes a platform string', () => {
      const provider = new TestWebhookProvider();
      expect(provider.capabilities.platform).toBe('github');
    });

    it('exposes a non-empty supportedEvents array', () => {
      const provider = new TestWebhookProvider();
      expect(provider.capabilities.supportedEvents.length).toBeGreaterThan(0);
    });
  });

  describe('verifySignature', () => {
    it('returns true for a valid payload and matching signature', async () => {
      const provider = new TestWebhookProvider('mysecret');
      const result = await provider.verifySignature('{"action":"opened"}', 'sha256=mysecret');
      expect(result).toBe(true);
    });

    it('returns false for empty payload', async () => {
      const provider = new TestWebhookProvider('mysecret');
      const result = await provider.verifySignature('', 'sha256=mysecret');
      expect(result).toBe(false);
    });

    it('returns false when signature does not contain secret', async () => {
      const provider = new TestWebhookProvider('mysecret');
      const result = await provider.verifySignature('{"action":"opened"}', 'sha256=wrong');
      expect(result).toBe(false);
    });
  });

  describe('parseWebhook', () => {
    it('extracts event from payload', async () => {
      const provider = new TestWebhookProvider();
      const event = await provider.parseWebhook({ event: 'push', data: { ref: 'refs/heads/main' } });

      expect(event.platform).toBe('github');
      expect(event.event).toBe('push');
      expect(event.data).toEqual({ ref: 'refs/heads/main' });
    });

    it('extracts optional action from payload', async () => {
      const provider = new TestWebhookProvider();
      const event = await provider.parseWebhook({ event: 'pull_request', action: 'opened', data: {} });

      expect(event.action).toBe('opened');
    });

    it('leaves action undefined when absent in payload', async () => {
      const provider = new TestWebhookProvider();
      const event = await provider.parseWebhook({ event: 'push', data: {} });

      expect(event.action).toBeUndefined();
    });

    it('returns an unknown event for non-object payloads', async () => {
      const provider = new TestWebhookProvider();
      const event = await provider.parseWebhook(null);

      expect(event.platform).toBe('github');
      expect(event.event).toBe('unknown');
      expect(event.action).toBeUndefined();
      expect(event.data).toBeUndefined();
    });
  });

  describe('registerHandlers', () => {
    it('is callable with a bus argument', () => {
      const provider = new TestWebhookProvider();
      const mockBus = {} as IMakaioBus;

      // Verify the method exists and is callable without throwing
      expect(() => provider.registerHandlers(mockBus)).not.toThrow();
    });

    it('registerHandlers on the interface accepts an IMakaioBus', () => {
      // This is an interface-shape assertion, not a behavioral registration test.
      const provider: IWebhookProvider = new TestWebhookProvider();
      expectTypeOf(provider.registerHandlers).parameters.toEqualTypeOf<[IMakaioBus]>();
    });
  });
});

describe('WebhookEvent type shape', () => {
  it('supports all required fields and optional action', () => {
    const event: WebhookEvent = {
      platform: 'github',
      event: 'push',
      data: { commits: [] },
    };

    expect(event.platform).toBe('github');
    expect(event.event).toBe('push');
    expect(event.action).toBeUndefined();
  });

  it('supports optional action field', () => {
    const event: WebhookEvent = {
      platform: 'gitlab',
      event: 'merge_request',
      action: 'merge',
      data: {},
    };

    expect(event.action).toBe('merge');
  });
});
