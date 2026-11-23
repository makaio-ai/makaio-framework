import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AllocationTerminationSchema,
  MaxRuntimeAssuranceSchema,
  WorkerProviderIdSchema,
  type AllocationScope,
  type AllocationScopeStatus,
  type AllocationScopeBlock,
  type AllocationTermination,
  type MaxRuntimeAssurance,
  type WorkerProviderId,
} from '@makaio/contracts';
import type * as Capabilities from '@makaio/contracts/capabilities';

const evidence = {
  source: 'host.worker:local',
  summary: 'Observed the allocation',
  observedAt: '2026-11-23T11:00:00Z',
};

describe('public worker provider contracts', () => {
  it('exports matching value and type shapes from the root and capability entry points', () => {
    expectTypeOf<WorkerProviderId>().toEqualTypeOf<Capabilities.WorkerProviderId>();
    expectTypeOf<AllocationScope>().toEqualTypeOf<Capabilities.AllocationScope>();
    expectTypeOf<AllocationScopeBlock>().toEqualTypeOf<Capabilities.AllocationScopeBlock>();
    expectTypeOf<Exclude<AllocationScopeBlock, { reason: 'binding-missing' }>['observations']>().toEqualTypeOf<
      never[]
    >();
    expectTypeOf<
      Exclude<AllocationScopeBlock, { reason: 'binding-missing' }>['completeness']['kind']
    >().toEqualTypeOf<'unknown'>();
    expectTypeOf<AllocationScopeStatus>().toEqualTypeOf<Capabilities.AllocationScopeStatus>();
    expectTypeOf<MaxRuntimeAssurance['boundary']>().toEqualTypeOf<'platform' | 'provider-process'>();
    expectTypeOf<AllocationTermination['state']>().toEqualTypeOf<'ended' | 'ending'>();
    expect(WorkerProviderIdSchema.parse('host.worker:local')).toBe('host.worker:local');
  });

  it.each(['platform', 'provider-process'])('accepts evidence for the %s boundary', (boundary) => {
    expect(MaxRuntimeAssuranceSchema.safeParse({ boundary, evidence }).success).toBe(true);
    expect(MaxRuntimeAssuranceSchema.safeParse({ boundary, evidence, elapsedMs: 1 }).success).toBe(false);
  });

  it.each(['ended', 'ending'])('requires evidence for termination state %s', (state) => {
    expect(AllocationTerminationSchema.safeParse({ state, evidence }).success).toBe(true);
    expect(AllocationTerminationSchema.safeParse({ state }).success).toBe(false);
  });

  it('rejects undeclared lifecycle outcomes', () => {
    expect(MaxRuntimeAssuranceSchema.safeParse({ boundary: 'guest', evidence }).success).toBe(false);
    expect(AllocationTerminationSchema.safeParse({ state: 'requested', evidence }).success).toBe(false);
  });
});
