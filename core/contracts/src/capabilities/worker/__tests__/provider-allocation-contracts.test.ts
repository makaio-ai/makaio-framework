import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_LISTING_MAX_LIMIT,
  ALLOCATION_SCOPE_BLOCK_REASONS,
  AllocationListingRequestSchema,
  AllocationObservationPageSchema,
  AllocationObservationSchema,
  AllocationScopeBlockSchema,
  AllocationScopeValueSchema,
  WORKER_PROVIDER_ID_MAX_LENGTH,
  WorkerProviderIdSchema,
} from '@makaio/contracts/capabilities';

const firstObservation = {
  allocationRef: { version: 1, providerId: 'worker.local:primary', providerData: {} },
  jobRunId: 'run-first',
  state: 'running',
} as const;

describe('worker provider identity', () => {
  it('parses IDs using the public capability contract', () => {
    const id = '@example/worker.local:Blue_2.1';
    expect(WorkerProviderIdSchema.parse(id)).toBe(id);
    expect(WorkerProviderIdSchema.safeParse('a'.repeat(WORKER_PROVIDER_ID_MAX_LENGTH - 2) + ':x').success).toBe(true);
  });

  it.each([
    '',
    ':key',
    'kind:',
    'kind:key:two',
    'kind:_key',
    'kind:key/part',
    'my kind:key',
  ])('rejects invalid ID %s', (id) => {
    expect(WorkerProviderIdSchema.safeParse(id).success).toBe(false);
  });

  it('rejects an identifier that cannot fit in recovery evidence', () => {
    expect(WorkerProviderIdSchema.safeParse('a'.repeat(WORKER_PROVIDER_ID_MAX_LENGTH) + ':x').success).toBe(false);
  });
});

describe('allocation scope and observations', () => {
  it('recognizes only valid operator scope values', () => {
    for (const scope of ['a', 'review-scope', 'a'.repeat(63)])
      expect(AllocationScopeValueSchema.safeParse(scope).success).toBe(true);
    for (const scope of ['', 'a'.repeat(64), '-a', 'a-', 'A', 'a_b'])
      expect(AllocationScopeValueSchema.safeParse(scope).success).toBe(false);
  });

  it('bounds one page request and validates its scope', () => {
    const request = { allocationScope: 'test-scope', jobRunId: 'run-first', limit: ALLOCATION_LISTING_MAX_LIMIT };
    expect(AllocationListingRequestSchema.parse(request)).toEqual(request);
    expect(AllocationListingRequestSchema.safeParse({ ...request, limit: request.limit + 1 }).success).toBe(false);
    expect(AllocationListingRequestSchema.safeParse({ ...request, cursor: '' }).success).toBe(false);
  });

  it('keeps continuation and completeness mutually exclusive', () => {
    const partial = { observations: [firstObservation], nextCursor: 'next' };
    const final = { observations: [firstObservation], completeness: { kind: 'complete' } };
    expect(AllocationObservationPageSchema.parse(partial)).toEqual(partial);
    expect(AllocationObservationPageSchema.parse(final)).toEqual(final);
    expect(AllocationObservationPageSchema.safeParse({ ...partial, ...final }).success).toBe(false);
    expect(AllocationObservationPageSchema.safeParse({ observations: [] }).success).toBe(false);
  });

  it('requires valid provider IDs in the scope block', () => {
    const block = {
      owner: 'worker',
      reason: 'binding-missing',
      observations: [],
      completeness: { kind: 'complete' },
    };
    expect(
      AllocationScopeBlockSchema.safeParse({ ...block, blockedProviderIds: ['worker.local:primary'] }).success,
    ).toBe(true);
    expect(AllocationScopeBlockSchema.safeParse({ ...block, blockedProviderIds: ['primary'] }).success).toBe(false);
  });

  describe('allocation scope block invariants', () => {
    const block = {
      owner: 'example.worker',
      reason: 'binding-missing',
      blockedProviderIds: ['worker.local:primary'],
      observations: [firstObservation],
      completeness: { kind: 'complete' },
    };

    it.each([
      'setting-missing',
      'setting-invalid',
      'binding-mismatch',
    ])('requires empty observations for %s', (reason) => {
      const withoutListing = { ...block, reason, observations: [] };
      expect(AllocationScopeBlockSchema.safeParse(withoutListing).success).toBe(false);
      const completeness = {
        kind: 'unknown',
        evidence: {
          source: 'worker.local:primary',
          summary: 'Listing unavailable',
          observedAt: '2026-11-23T11:00:00Z',
        },
      };
      expect(AllocationScopeBlockSchema.safeParse({ ...withoutListing, completeness }).success).toBe(true);
      expect(AllocationScopeBlockSchema.safeParse({ ...block, reason, completeness }).success).toBe(false);
    });

    it.each([
      1,
      ALLOCATION_LISTING_MAX_LIMIT - 1,
    ])('accepts a complete listing of %s allocations below the cap', (count) => {
      const observations = Array.from({ length: count }, () => firstObservation);
      expect(AllocationScopeBlockSchema.safeParse({ ...block, observations }).success).toBe(true);
    });

    it('projects the blocked observation limit into JSON Schema', () => {
      const projected = z.toJSONSchema(AllocationScopeBlockSchema);
      expect(projected.oneOf).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              observations: expect.objectContaining({ maxItems: 0 }),
            }),
          }),
        ]),
      );
    });

    it('requires unknown completeness when the observation cap is reached', () => {
      const observations = Array.from({ length: ALLOCATION_LISTING_MAX_LIMIT }, () => firstObservation);
      const capped = { ...block, observations };
      expect(AllocationScopeBlockSchema.safeParse(capped).success).toBe(false);
      expect(
        AllocationScopeBlockSchema.safeParse({
          ...capped,
          completeness: {
            kind: 'unknown',
            evidence: { source: 'worker.local:primary', summary: 'Cap reached', observedAt: '2026-11-23T00:00:00Z' },
          },
        }).success,
      ).toBe(true);
    });

    it('rejects observations for a provider outside the block', () => {
      const observation = {
        ...firstObservation,
        allocationRef: { ...firstObservation.allocationRef, providerId: 'worker.local:other' },
      };
      expect(AllocationScopeBlockSchema.safeParse({ ...block, observations: [observation] }).success).toBe(false);
    });

    it('requires the block to contain at least one provider', () => {
      expect(AllocationScopeBlockSchema.safeParse({ ...block, blockedProviderIds: [], observations: [] }).success).toBe(
        false,
      );
    });

    it('requires a valid extension name for the owner', () => {
      expect(AllocationScopeBlockSchema.safeParse({ ...block, owner: '../owner' }).success).toBe(false);
    });
  });

  it.each([
    { nextCursor: 'next' },
    { completeness: { kind: 'complete' } },
  ])('limits the number of returned observations', (pagination) => {
    const observations = Array.from({ length: ALLOCATION_LISTING_MAX_LIMIT }, () => firstObservation);
    expect(AllocationObservationPageSchema.safeParse({ ...pagination, observations }).success).toBe(true);
    expect(
      AllocationObservationPageSchema.safeParse({ ...pagination, observations: [...observations, firstObservation] })
        .success,
    ).toBe(false);
  });

  it('requires a stable provider ID on an observation reference', () => {
    const allocationRef = { ...firstObservation.allocationRef, providerId: 'primary' };
    expect(AllocationObservationSchema.safeParse(firstObservation).success).toBe(true);
    expect(AllocationObservationSchema.safeParse({ ...firstObservation, allocationRef }).success).toBe(false);
  });

  it('validates the supported block reasons and bounds reported observations', () => {
    expect(ALLOCATION_SCOPE_BLOCK_REASONS).toEqual([
      'setting-missing',
      'setting-invalid',
      'binding-missing',
      'binding-mismatch',
    ]);
    const block = {
      owner: 'worker',
      reason: 'binding-missing',
      blockedProviderIds: ['worker.local:primary'],
      observations: Array.from({ length: ALLOCATION_LISTING_MAX_LIMIT }, () => firstObservation),
      completeness: {
        kind: 'unknown',
        evidence: {
          source: 'worker.local:primary',
          summary: 'Listing cap reached',
          observedAt: '2026-11-23T11:00:00Z',
        },
      },
    };
    expect(AllocationScopeBlockSchema.parse(block)).toEqual(block);
    expect(
      AllocationScopeBlockSchema.safeParse({ ...block, observations: [...block.observations, firstObservation] })
        .success,
    ).toBe(false);
  });
});
