/**
 * Conformance suite: accepted jsonb NUL-character divergence.
 *
 * Pins the ACCEPTED divergence between sqlite (jsonCol → TEXT, round-trips NUL
 * bytes) and postgres (jsonCol → jsonb, which rejects the Unicode escape
 * sequence for U+0000). This divergence is intentional and documented in
 * `@makaio/storage-drizzle/columns/sqlite`: jsonb cannot store NUL bytes.
 *
 * Tests:
 * 1. (sqlite only) INSERT with a NUL-containing JSON payload succeeds and
 *    SELECT round-trips the NUL byte faithfully.
 * 2. (postgres only) INSERT with a NUL-containing JSON payload REJECTS with
 *    SQLSTATE '22P05' or a message matching the unsupported-escape pattern.
 * 3. (both dialects) A NUL-free structured payload round-trips identically
 *    with deep structural equality (key order immaterial).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { resolveSchema } from '@makaio/storage-drizzle';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { fixtureKvDdl, fixtureKv } from '../harness/fixture-table.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('divergence-jsonb-nul', (config) => {
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: true });

  beforeAll(async () => {
    // Create the fixture table in this suite's isolated database/schema.
    const ctx = getCtx();
    await ctx.executor.run(sql.raw(fixtureKvDdl(ctx.dialect)));
  });

  // ─── NUL-free round-trip (both dialects) ─────────────────────────────────

  it('NUL-free structured payload round-trips identically on both dialects', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const id = `nul-free-${Date.now()}`;
    const payload: Record<string, unknown> = {
      key: 'value',
      count: 42,
      nested: { a: true, b: null },
    };

    await ctx.db.insert(kv).values({ id, label: 'nul-free', payload });

    const rows = await ctx.db.select().from(kv).where(eq(kv.id, id));
    expect(rows).toHaveLength(1);
    // Deep equality: key order is immaterial per the jsonCol round-trip contract.
    expect(rows[0]!.payload).toEqual(payload);
  });

  // ─── SQLite: NUL round-trip ───────────────────────────────────────────────

  describe('sqlite NUL byte round-trip', () => {
    // Gate on dialect via config — describe() is synchronous, the context is
    // not provisioned yet at collection time.
    const runSqliteTests = config.dialect === 'sqlite' ? it : it.skip;

    runSqliteTests('INSERT with NUL-containing payload succeeds and SELECT round-trips the NUL byte', async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const id = `nul-sqlite-${Date.now()}`;
      // Build NUL at runtime — never embed the literal six-character escape.
      const nul = String.fromCharCode(0);
      const payload = { note: 'a' + nul + 'b' };

      // On SQLite, jsonCol stores as TEXT; NUL bytes survive the round-trip.
      await ctx.db.insert(kv).values({ id, label: 'nul', payload });

      const rows = await ctx.db.select().from(kv).where(eq(kv.id, id));
      expect(rows).toHaveLength(1);
      const stored = rows[0]!.payload as { note: string };
      // Confirm the embedded NUL is faithfully restored.
      expect(stored.note.charCodeAt(0)).toBe('a'.charCodeAt(0));
      expect(stored.note.charCodeAt(1)).toBe(0);
      expect(stored.note.charCodeAt(2)).toBe('b'.charCodeAt(0));
    });
  });

  // ─── Postgres: NUL rejection ──────────────────────────────────────────────

  describe('postgres NUL byte rejection', () => {
    // Gate on dialect via config — describe() is synchronous, the context is
    // not provisioned yet at collection time.
    const runPgTests = config.dialect === 'postgres' ? it : it.skip;

    runPgTests(
      // Accepted divergence: jsonb cannot store NUL — documented in
      // @makaio/storage-drizzle/columns/sqlite. Any future change that allows
      // NUL on PG must be a conscious product-owner decision and this test
      // must be updated at that point.
      'INSERT with NUL-containing payload REJECTS with SQLSTATE 22P05 or unsupported-escape message',
      async () => {
        const ctx = getCtx();
        const { kv } = resolveSchema(ctx.db, fixtureKv);
        const id = `nul-pg-${Date.now()}`;
        // Build NUL at runtime — never embed the literal six-character escape.
        const nul = String.fromCharCode(0);
        const payload = { note: 'a' + nul + 'b' };

        await expect(ctx.db.insert(kv).values({ id, label: 'nul', payload })).rejects.toSatisfy((err: unknown) => {
          // Walk the cause chain to find the postgres error.
          let current: unknown = err;
          while (current instanceof Error) {
            const e = current as Error & { code?: unknown };
            // Accept SQLSTATE 22P05 (invalid_parameter_value / unsupported escape).
            if (e.code === '22P05') return true;
            // Message fallback for drivers that do not surface the SQLSTATE code.
            // Only the message text is matched: spelling the escaped NUL sequence here
            // would itself re-arm the encoding trap this suite exists to pin.
            if (/unsupported Unicode escape sequence/i.test(e.message)) return true;
            current = (e as Error & { cause?: unknown }).cause;
          }
          return false;
        });

        // Weak-net: confirm the row was not persisted.
        const rows = await ctx.db.select().from(kv).where(eq(kv.id, id));
        expect(rows).toHaveLength(0);
      },
    );
  });
});
