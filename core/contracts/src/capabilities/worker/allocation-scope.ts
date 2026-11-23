import { z } from 'zod';

/** Raw setting value: lower-case letters, digits, `-`; at most 63 characters. */
export const AllocationScopeValueSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

declare const allocationScopeBrand: unique symbol;

/**
 * Durable ownership domain of one installation across all its processes.
 *
 * Minted in one place only: the host, from the operator setting and the stored
 * confirmed binding after comparing them. Providers receive it and never
 * construct it. The brand is a type-level aid; the proof of origin is the single
 * minting path.
 */
export interface AllocationScope {
  readonly value: string;
  readonly [allocationScopeBrand]: true;
}

/** Why the scope blocks provider-managed providers. */
export const ALLOCATION_SCOPE_BLOCK_REASONS = [
  'setting-missing',
  'setting-invalid',
  'binding-missing',
  'binding-mismatch',
] as const;
export const AllocationScopeBlockReasonSchema = z.enum(ALLOCATION_SCOPE_BLOCK_REASONS);
export type AllocationScopeBlockReason = z.infer<typeof AllocationScopeBlockReasonSchema>;
