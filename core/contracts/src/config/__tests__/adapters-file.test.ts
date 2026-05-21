import { describe, expect, it } from 'vitest';
import { AdaptersFileSchema } from '../adapters-file.js';

describe('AdaptersFileSchema', () => {
  it('parses minimal adapters.json entries', () => {
    const parsed = AdaptersFileSchema.parse({
      $schema: 'makaio/adapters-config/v1',
      adapters: {
        'anthropic-sdk': {
          providers: {
            anthropic: {
              providerId: 'anthropic',
              credentials: { apiKey: 'env:ANTHROPIC_API_KEY' },
              isDefault: true,
            },
          },
        },
      },
    });

    expect(parsed.adapters['anthropic-sdk']?.providers.anthropic?.providerId).toBe('anthropic');
  });

  it('rejects the legacy per-adapter file shape', () => {
    const result = AdaptersFileSchema.safeParse({
      $schema: 'makaio/adapter-config/v2',
      providers: {},
    });

    expect(result.success).toBe(false);
  });
});
