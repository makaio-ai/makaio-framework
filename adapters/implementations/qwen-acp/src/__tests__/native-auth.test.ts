import { describe, expect, it } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { assertQwenNativeAuth, QwenNativeAuthDeliveryError } from '../native-auth.js';

describe('Qwen ACP native auth', () => {
  it('accepts a manually supplied isolated auth-only snapshot for connector tests', () => {
    expect(() =>
      assertQwenNativeAuth({ processEnv: {}, connectorDeliveries: [], configInheritance: 'auth-only' }),
    ).not.toThrow();
  });

  it('rejects missing or non-native delivery modes without exposing values', () => {
    const snapshots: Array<ResolvedAdapterAuth | undefined> = [
      undefined,
      { processEnv: {}, connectorDeliveries: [], configInheritance: 'empty' },
      {
        processEnv: { QWEN_TOKEN: 'private-token' },
        connectorDeliveries: [],
        configInheritance: 'auth-only',
      },
    ];
    for (const snapshot of snapshots) {
      let error: unknown;
      try {
        assertQwenNativeAuth(snapshot);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(QwenNativeAuthDeliveryError);
      expect((error as Error).message).not.toContain('private-token');
    }
  });
});
