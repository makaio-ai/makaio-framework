/**
 * Tests for relay control envelope validation via the registry-backed helpers.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createRelayControlHelpers, type RelayControlHelpers } from '../relay-control-envelope.js';
import { createRelayControlRegistry } from '../relay-control-registry.js';
import { buildRelayControlTestRegistry } from './relay-control-test-registry.js';

let helpers: RelayControlHelpers;

beforeEach(() => {
  helpers = createRelayControlHelpers(buildRelayControlTestRegistry());
});

describe('relay-control-envelope', () => {
  describe('device namespace', () => {
    it('accepts device namespace request with valid subject', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'request',
          namespace: 'device',
          subject: 'relay.verify',
          messageId: 'msg-123',
          correlationId: 'corr-456',
          payload: {
            deviceId: 'device-123',
            signature: 'sig-abc',
            timestamp: Date.now(),
            machineId: 'machine-xyz',
          },
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(true);
    });

    it('rejects device namespace request with invalid subject', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'request',
          namespace: 'device',
          subject: 'invalid-subject',
          messageId: 'msg-123',
          correlationId: 'corr-456',
          payload: {},
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(false);
    });

    it('rejects device namespace event', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'event',
          namespace: 'device',
          subject: 'relay.verify',
          messageId: 'msg-123',
          payload: {},
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(false);
    });
  });

  describe('createRelayControlEnvelope', () => {
    it('creates envelope for device verify request', () => {
      const busMessage = {
        type: 'request' as const,
        namespace: 'device',
        subject: 'relay.verify',
        messageId: 'msg-123',
        correlationId: 'corr-456',
        payload: {
          deviceId: 'device-123',
          signature: 'sig-abc',
          timestamp: Date.now(),
          machineId: 'machine-xyz',
        },
      };

      const envelope = helpers.createRelayControlEnvelope(busMessage);

      expect(envelope).toEqual({
        type: 'relay-control',
        v: 1,
        payload: busMessage,
      });
    });
  });

  describe('existing relay namespace', () => {
    it('still accepts relay namespace events', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'event',
          namespace: 'relay',
          subject: 'error',
          messageId: 'msg-123',
          payload: { code: 'TEST_ERROR' },
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(true);
    });

    it('accepts relay namespace oauth refresh request', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'request',
          namespace: 'relay',
          subject: 'oauth.refresh',
          messageId: 'msg-123',
          correlationId: 'corr-456',
          payload: {
            provider: 'github',
            refreshToken: 'refresh-token',
            account: 'default',
          },
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(true);
    });

    it('rejects relay namespace request with unknown subject', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'request',
          namespace: 'relay',
          subject: 'oauth.unknown',
          messageId: 'msg-123',
          correlationId: 'corr-456',
          payload: {
            provider: 'github',
            refreshToken: 'refresh-token',
          },
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(false);
    });

    it('rejects relay namespace request without correlationId', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'request',
          namespace: 'relay',
          subject: 'oauth.refresh',
          messageId: 'msg-123',
          payload: {
            provider: 'github',
            refreshToken: 'refresh-token',
          },
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(false);
    });

    it('rejects relay namespace request without messageId', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'request',
          namespace: 'relay',
          subject: 'oauth.refresh',
          correlationId: 'corr-456',
          payload: {
            provider: 'github',
            refreshToken: 'refresh-token',
          },
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(false);
    });
  });

  describe('existing tunnel namespace', () => {
    it('still accepts tunnel namespace requests', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'request',
          namespace: 'tunnel',
          subject: 'register',
          messageId: 'msg-123',
          correlationId: 'corr-456',
          payload: { tunnelId: 'tunnel-123' },
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(true);
    });

    it('accepts tunnel share requests from the explicit allowlist', () => {
      const message = {
        type: 'relay-control',
        v: 1,
        payload: {
          type: 'request',
          namespace: 'tunnel',
          subject: 'share.create',
          messageId: 'msg-share-123',
          correlationId: 'corr-share-456',
          payload: { tunnelId: 'tunnel-123' },
        },
      };

      expect(helpers.isRelayControlEnvelopeMessage(message)).toBe(true);
    });
  });

  it('fails fast when helpers are used with a mutable registry', () => {
    const registry = createRelayControlRegistry();
    registry.registerRequestNamespace('relay', ['oauth.refresh']);
    const mutableHelpers = createRelayControlHelpers(registry);

    expect(() =>
      mutableHelpers.isRelayControlBusMessage({
        type: 'request',
        namespace: 'relay',
        subject: 'oauth.refresh',
        payload: {},
        correlationId: 'corr-1',
        messageId: 'msg-1',
      }),
    ).toThrow(/must be frozen/i);
  });

  it('rejects empty request namespace registrations', () => {
    const registry = createRelayControlRegistry();
    expect(() => registry.registerRequestNamespace('relay', [])).toThrow(/requires at least one subject/i);
  });
});
