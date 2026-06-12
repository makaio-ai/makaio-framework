/**
 * Tests for the non-baseline engine generation-leg descriptor.
 *
 * The descriptor is pure data, so the assertions pin its declared fields and
 * the dialect-lookup helper directly — no mocks, no filesystem.
 */
import { describe, it, expect } from 'vitest';
import {
  findGenerationLegForDialect,
  NON_BASELINE_GENERATION_LEGS,
  type StorageEngineGenerationLeg,
} from '../engine/generation';

describe('non-baseline generation legs', () => {
  it('declares the Postgres leg with its package, chain dir, config, and normalize script', () => {
    const postgres = findGenerationLegForDialect('postgres');
    expect(postgres).toEqual<StorageEngineGenerationLeg>({
      dialect: 'postgres',
      enginePackageName: '@makaio/storage-pg',
      chainDirName: 'drizzle-postgres',
      drizzleConfigSpecifier: 'drizzle.config.ts',
      normalizeScriptSpecifier: 'scripts/normalize-migrations.ts',
    });
  });

  it('returns the same entry held in the descriptor list', () => {
    expect(findGenerationLegForDialect('postgres')).toBe(
      NON_BASELINE_GENERATION_LEGS.find((leg) => leg.dialect === 'postgres'),
    );
  });

  it('has no leg for the baseline sqlite dialect', () => {
    expect(findGenerationLegForDialect('sqlite')).toBeUndefined();
  });
});
