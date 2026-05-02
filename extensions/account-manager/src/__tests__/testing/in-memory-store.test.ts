import { describe, expect, it } from 'vitest';
import { InMemoryAccountMetadataStore } from './in-memory-store.js';

describe('InMemoryAccountMetadataStore', () => {
  it('advances metadata generation across ordinary metadata patches', async () => {
    const store = new InMemoryAccountMetadataStore();

    await store.upsert('claude-code', {
      id: 'acc-generated',
      label: 'Generated',
      metadata: { planType: 'free' },
      active: true,
      detectedAt: 100,
      lastSeenAt: 200,
    });

    await expect(store.getWithMetadataGeneration('claude-code', 'acc-generated')).resolves.toMatchObject({
      metadataGeneration: 0,
      account: { metadata: { planType: 'free' } },
    });

    await expect(store.patchMetadata('claude-code', 'acc-generated', 0, { planType: 'plus' })).resolves.toMatchObject({
      metadata: { planType: 'plus' },
    });

    await expect(store.getWithMetadataGeneration('claude-code', 'acc-generated')).resolves.toMatchObject({
      metadataGeneration: 1,
      account: { metadata: { planType: 'plus' } },
    });
    await expect(store.patchMetadata('claude-code', 'acc-generated', 0, { rateLimitTier: 'team' })).resolves.toBeNull();
  });

  it('applies JSON merge-patch semantics for null values', async () => {
    const store = new InMemoryAccountMetadataStore();

    await store.upsert('claude-code', {
      id: 'acc-merge',
      label: 'Merge',
      metadata: {
        planType: 'free',
        nested: {
          expiresAt: 123,
          seats: 1,
        },
      },
      active: true,
      detectedAt: 100,
      lastSeenAt: 200,
    });

    await expect(
      store.patchMetadata('claude-code', 'acc-merge', 0, {
        nested: {
          expiresAt: null,
          seats: 4,
        },
      }),
    ).resolves.toMatchObject({
      metadata: {
        planType: 'free',
        nested: {
          seats: 4,
        },
      },
    });
  });

  it('does not advance metadata generation for a semantic no-op nested patch', async () => {
    const store = new InMemoryAccountMetadataStore();

    await store.upsert('claude-code', {
      id: 'acc-noop',
      label: 'Noop',
      metadata: { nested: { seats: 4 } },
      active: true,
      detectedAt: 100,
      lastSeenAt: 200,
    });

    await expect(
      store.patchMetadata('claude-code', 'acc-noop', 0, {
        nested: { seats: 4 },
      }),
    ).resolves.toMatchObject({
      metadata: { nested: { seats: 4 } },
    });
    await expect(store.getMetadataGeneration('claude-code', 'acc-noop')).resolves.toBe(0);
  });
});
