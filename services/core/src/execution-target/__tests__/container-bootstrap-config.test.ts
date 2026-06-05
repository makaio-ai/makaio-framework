import { describe, expect, it } from 'vitest';
import { ContainerBootstrapConfigSchema } from '@makaio/services-core/execution-target';

describe('ContainerBootstrapConfigSchema', () => {
  describe('valid payloads', () => {
    it('accepts an empty object (all fields optional)', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });

    it('accepts a full payload with all fields', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({
        busAuthSecret: 'hmac-secret-abc',
        relayPeer: { id: 'host-machine-1', signingPublicKey: 'host-signing-public-key' },
        relayIdentity: {
          id: 'wfx-1',
          signingPublicKey: 'worker-signing-public-key',
          signingPrivateKeyPem: 'worker-signing-private-key',
        },
        gitToken: 'ghp_token123',
        credentialEnv: { apiKey: 'sk-abc' },
        providerEnv: { ANTHROPIC_API_KEY: 'sk-abc' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.busAuthSecret).toBe('hmac-secret-abc');
        expect(result.data.relayPeer).toEqual({ id: 'host-machine-1', signingPublicKey: 'host-signing-public-key' });
        expect(result.data.relayIdentity).toEqual({
          id: 'wfx-1',
          signingPublicKey: 'worker-signing-public-key',
          signingPrivateKeyPem: 'worker-signing-private-key',
        });
        expect(result.data.gitToken).toBe('ghp_token123');
        expect(result.data.credentialEnv).toEqual({ apiKey: 'sk-abc' });
        expect(result.data.providerEnv).toEqual({ ANTHROPIC_API_KEY: 'sk-abc' });
      }
    });

    it('accepts gitToken only', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({ gitToken: 'ghp_abc' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.gitToken).toBe('ghp_abc');
        expect(result.data.credentialEnv).toBeUndefined();
        expect(result.data.busAuthSecret).toBeUndefined();
      }
    });

    it('accepts credentialEnv with multiple entries', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({
        credentialEnv: { apiKey: 'sk-1', orgId: 'org-2' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.credentialEnv).toEqual({ apiKey: 'sk-1', orgId: 'org-2' });
      }
    });
  });

  describe('invalid payloads', () => {
    it('rejects a non-string gitToken', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({ gitToken: 42 });
      expect(result.success).toBe(false);
    });

    it('rejects credentialEnv with a non-string value', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({ credentialEnv: { key: 99 } });
      expect(result.success).toBe(false);
    });

    it('rejects providerEnv with a non-string value', () => {
      const result = ContainerBootstrapConfigSchema.safeParse({ providerEnv: { KEY: true } });
      expect(result.success).toBe(false);
    });

    it('rejects non-object input', () => {
      const result = ContainerBootstrapConfigSchema.safeParse('not-an-object');
      expect(result.success).toBe(false);
    });
  });

  describe('optional-field round-trip', () => {
    it('round-trips a sparse payload without adding unexpected fields', () => {
      const input = { gitToken: 'tok' };
      const result = ContainerBootstrapConfigSchema.parse(input);
      expect(result).toEqual({ gitToken: 'tok' });
      expect(Object.keys(result)).toEqual(['gitToken']);
    });
  });
});
