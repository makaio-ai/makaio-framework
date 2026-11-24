/**
 * Conformance suite: the journal's fixed generic tables (A1).
 *
 * Proves the schema declared in `@makaio/services-core/journal/storage`
 * (`journal_entries`, `journal_position_counter`, `journal_reader_cursors`,
 * `journal_reader_states`, `journal_edge_cursors`) against a real database
 * that went through the central migration chain, on every driver the harness
 * provides. Covers only the schema itself (existence, uniqueness, named
 * checks, defaults, nullability, JSON round-tripping, and the one upsert
 * statement the position counter is built for) — no store functions, no
 * multi-process probes; those are later steps.
 *
 * Constraint violations are asserted by rejection
 * (`expect(...).rejects.toThrow()`): the harness exposes no dialect-specific
 * error classification, so a bare rejection is the portable signal across
 * bun:sqlite, libsql and node-postgres.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { resolveSchema } from '@makaio/storage-drizzle';
import { applyMigrations } from '@makaio/storage-migrations';
import {
  journalStorageSchema,
  type InsertJournalEdgeCursorRow,
  type InsertJournalEntryRow,
  type InsertJournalReaderStateRow,
} from '@makaio/services-core/journal/storage';
import type { JsonValue, Origin } from '@makaio/contracts';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { readCentralChain } from '../harness/chains.js';
import type { StorageDatabaseContext } from '../harness/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Unique id per case so cases never collide on a unique column.
 * @param prefix - Human-readable case prefix.
 * @returns A unique id.
 */
function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Adopt a drizzle query builder (a thenable, not a genuine `Promise`) into a
 * real `Promise`. vitest's `expect(...).resolves`/`.rejects` accept a bare
 * thenable, but under Bun's test runner (this suite's other lane,
 * `journal-schema.bun.test.ts`) the same matchers require an actual `Promise`
 * instance — a query builder passed to them directly fails before it is even
 * awaited.
 * @param thenable - Drizzle query builder (or any other thenable) to adopt.
 * @returns A genuine `Promise` that settles the same way.
 * @typeParam T - Resolved value type.
 */
function toPromise<T>(thenable: PromiseLike<T>): Promise<T> {
  return Promise.resolve(thenable);
}

/**
 * Monotonically increasing position for this suite's own entries and reader
 * states. The journal's own invariant that position order must equal commit
 * order (I1, handed to the store functions in a later step) is out of scope
 * here — this suite only needs a value unique per row unless a case
 * deliberately collides one on purpose.
 */
let nextPosition = 1;

/**
 * Allocate the next position value for a row this suite inserts directly
 * (bypassing `journal_position_counter`, which is exercised on its own below).
 * @returns A position unique among this suite's own rows.
 */
function allocatePosition(): number {
  return nextPosition++;
}

/**
 * Build a structurally valid `Origin`, overridable per field, with JSON-shaped
 * claims nested under `caller`/`principal` so origin round-trip cases exercise
 * the same structural variety as the payload cases.
 * @param overrides - Fields to override.
 * @returns A valid `Origin`.
 */
function makeOrigin(overrides: Partial<Origin> = {}): Origin {
  return {
    caller: { kind: 'makaio.host', id: 'journal-schema-suite' },
    principal: { kind: 'makaio.extension', id: 'journal-schema-suite' },
    extension: 'journal-schema-suite',
    ...overrides,
  };
}

/**
 * Build a structurally valid `journal_entries` insert row, overridable per
 * field. Defaults give every field a fresh unique value so two calls never
 * collide on a unique column unless a case deliberately overrides one to
 * collide on purpose.
 * @param overrides - Fields to override.
 * @returns A valid insert row.
 */
function makeEntryRow(overrides: Partial<InsertJournalEntryRow> = {}): InsertJournalEntryRow {
  return {
    position: allocatePosition(),
    entryId: uniqueId('entry'),
    extension: uniqueId('extension'),
    subject: 'journal-schema.suite.recorded',
    payload: { ok: true },
    schemaVersion: '1',
    key: uniqueId('key'),
    orderKey: null,
    origin: makeOrigin(),
    recordedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Insert a `journal_entries` row and return the row as inserted.
 * @param ctx - Active database context.
 * @param overrides - Fields to override on the default valid row.
 * @returns The row that was inserted.
 */
async function insertEntry(
  ctx: StorageDatabaseContext,
  overrides: Partial<InsertJournalEntryRow> = {},
): Promise<InsertJournalEntryRow> {
  const { journalEntries } = resolveSchema(ctx.db, journalStorageSchema);
  const row = makeEntryRow(overrides);
  await ctx.db.insert(journalEntries).values(row);
  return row;
}

/**
 * Read back a single `journal_entries` row by `entryId`.
 * @param ctx - Active database context.
 * @param entryId - Entry id to look up.
 * @returns The stored row, or `undefined` when absent.
 */
async function readEntry(ctx: StorageDatabaseContext, entryId: string) {
  const { journalEntries } = resolveSchema(ctx.db, journalStorageSchema);
  const rows = await ctx.db.select().from(journalEntries).where(eq(journalEntries.entryId, entryId));
  return rows[0];
}

/**
 * Build a structurally valid `journal_reader_states` insert row, overridable
 * per field.
 * @param overrides - Fields to override.
 * @returns A valid insert row.
 */
function makeReaderStateRow(overrides: Partial<InsertJournalReaderStateRow> = {}): InsertJournalReaderStateRow {
  return {
    reader: uniqueId('reader'),
    entryId: uniqueId('reader-state-entry'),
    position: allocatePosition(),
    orderKey: null,
    state: 'open',
    reason: null,
    notBefore: null,
    claimToken: null,
    claimExpiresAt: null,
    ...overrides,
  };
}

/**
 * Insert a `journal_reader_states` row and return the row as inserted.
 * @param ctx - Active database context.
 * @param overrides - Fields to override on the default valid row.
 * @returns The row that was inserted.
 */
async function insertReaderState(
  ctx: StorageDatabaseContext,
  overrides: Partial<InsertJournalReaderStateRow> = {},
): Promise<InsertJournalReaderStateRow> {
  const { journalReaderStates } = resolveSchema(ctx.db, journalStorageSchema);
  const row = makeReaderStateRow(overrides);
  await ctx.db.insert(journalReaderStates).values(row);
  return row;
}

/**
 * Read back a single `journal_reader_states` row by `(reader, entryId)`.
 * @param ctx - Active database context.
 * @param reader - Reader name.
 * @param entryId - Entry id.
 * @returns The stored row, or `undefined` when absent.
 */
async function readReaderState(ctx: StorageDatabaseContext, reader: string, entryId: string) {
  const { journalReaderStates } = resolveSchema(ctx.db, journalStorageSchema);
  const rows = await ctx.db
    .select()
    .from(journalReaderStates)
    .where(sql`${journalReaderStates.reader} = ${reader} AND ${journalReaderStates.entryId} = ${entryId}`);
  return rows[0];
}

/**
 * Build a structurally valid `journal_edge_cursors` insert row, overridable
 * per field.
 * @param overrides - Fields to override.
 * @returns A valid insert row.
 */
function makeEdgeCursorRow(overrides: Partial<InsertJournalEdgeCursorRow> = {}): InsertJournalEdgeCursorRow {
  return {
    edge: uniqueId('edge'),
    partition: uniqueId('partition'),
    value: 'cursor-value',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('journal schema', (config) => {
  const getCtx = useSuiteDatabaseContext(config);

  // ── 1. Table existence + idempotent central-chain re-apply ───────────────

  it('creates all five journal tables after the real chain, which re-applies idempotently', async () => {
    const ctx = getCtx();
    const schema = resolveSchema(ctx.db, journalStorageSchema);

    // Existence proven by a real query against each table through its
    // canonical columns: a missing table or column fails the query, not this
    // assertion.
    await expect(
      toPromise(ctx.db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entryId, 'does-not-exist'))),
    ).resolves.toEqual([]);
    await expect(
      toPromise(
        ctx.db
          .select()
          .from(schema.journalPositionCounter)
          .where(eq(schema.journalPositionCounter.id, 'does-not-exist')),
      ),
    ).resolves.toEqual([]);
    await expect(
      toPromise(
        ctx.db
          .select()
          .from(schema.journalReaderCursors)
          .where(eq(schema.journalReaderCursors.reader, 'does-not-exist')),
      ),
    ).resolves.toEqual([]);
    await expect(
      toPromise(
        ctx.db.select().from(schema.journalReaderStates).where(eq(schema.journalReaderStates.reader, 'does-not-exist')),
      ),
    ).resolves.toEqual([]);
    await expect(
      toPromise(
        ctx.db.select().from(schema.journalEdgeCursors).where(eq(schema.journalEdgeCursors.edge, 'does-not-exist')),
      ),
    ).resolves.toEqual([]);

    // Re-applying the very same central chain the harness already applied in
    // its own beforeAll must be a no-op, not an error: a rejection here fails
    // the test on its own, with no separate assertion needed.
    await applyMigrations(ctx.db, readCentralChain(ctx.dialect));

    // The tables are still there and still queryable after the re-apply.
    await expect(
      toPromise(ctx.db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entryId, 'does-not-exist'))),
    ).resolves.toEqual([]);
  });

  // ── 2. journal_entries ────────────────────────────────────────────────────

  it('rejects a second entry with the same (extension, key)', async () => {
    const ctx = getCtx();
    const { journalEntries } = resolveSchema(ctx.db, journalStorageSchema);
    const extension = uniqueId('dup-extension-key');
    const key = uniqueId('dup-key');
    await insertEntry(ctx, { extension, key });

    await expect(toPromise(ctx.db.insert(journalEntries).values(makeEntryRow({ extension, key })))).rejects.toThrow();
  });

  it('accepts the same key under another extension', async () => {
    const ctx = getCtx();
    const key = uniqueId('shared-key');
    const first = await insertEntry(ctx, { extension: uniqueId('extension-a'), key });
    const second = await insertEntry(ctx, { extension: uniqueId('extension-b'), key });

    expect(await readEntry(ctx, first.entryId)).toBeDefined();
    expect(await readEntry(ctx, second.entryId)).toBeDefined();
  });

  it('rejects a second entry with a duplicate entry_id', async () => {
    const ctx = getCtx();
    const { journalEntries } = resolveSchema(ctx.db, journalStorageSchema);
    const entryId = uniqueId('dup-entry-id');
    await insertEntry(ctx, { entryId });

    await expect(toPromise(ctx.db.insert(journalEntries).values(makeEntryRow({ entryId })))).rejects.toThrow();
  });

  it('rejects a second entry with a duplicate position', async () => {
    const ctx = getCtx();
    const { journalEntries } = resolveSchema(ctx.db, journalStorageSchema);
    const position = allocatePosition();
    await insertEntry(ctx, { position });

    await expect(toPromise(ctx.db.insert(journalEntries).values(makeEntryRow({ position })))).rejects.toThrow();
  });

  it('round-trips payload and origin JSON structurally (nested object, array, string, number, boolean, null)', async () => {
    const ctx = getCtx();
    const payload = {
      str: 'text',
      num: 42.5,
      bool: true,
      nil: null,
      arr: [1, 'two', [3, false], { nested: 'object' }],
      obj: { a: 1, b: { c: [null, true, 'x'] } },
    };
    const origin = makeOrigin({
      caller: {
        kind: 'makaio.host',
        id: 'journal-schema-suite',
        claims: { nested: { array: [1, 'two', null, true], flag: false } },
      },
      principal: { kind: 'makaio.extension', id: 'journal-schema-suite', claims: { num: 3.14, nil: null } },
    });

    const row = await insertEntry(ctx, { payload, origin });
    const stored = await readEntry(ctx, row.entryId);

    expect(stored?.payload).toEqual(payload);
    expect(stored?.origin).toEqual(origin);
  });

  /**
   * JSON root cases that `journal_entries.payload` must round-trip
   * structurally. Covers every root kind `JsonValue` allows except a bare JSON
   * `null` root — `payload` is `.notNull()`, and drizzle maps a JS `null`
   * value to SQL `NULL` ahead of the column encoder for every column type
   * (`chunk.value === null ? null : chunk.encoder.mapToDriverValue(...)` in
   * `drizzle-orm/sql/sql.js`), so a root-level JSON `null` can never reach a
   * NOT NULL column through the normal insert path; `nil: null` nested one
   * level down (the `nested` case below) already proves `mapFromDriverValue`
   * handles an embedded JSON `null` correctly. The remaining cases include
   * string roots whose own text parses as JSON (`"123"`, `"true"`, `"null"`,
   * `""`) — the shapes a double JSON decode silently corrupts on Postgres
   * (pins the `jsonCol` single-decode-boundary fix in
   * `framework/storage/drizzle/src/columns/postgres.ts`).
   */
  const jsonRootCases: ReadonlyArray<{ readonly name: string; readonly value: JsonValue }> = [
    { name: 'object', value: { a: 1, b: 'two' } },
    { name: 'array', value: [1, 'two', true, null] },
    { name: 'numeric string', value: '123' },
    { name: 'boolean-looking string', value: 'true' },
    { name: 'null-looking string', value: 'null' },
    { name: 'empty string', value: '' },
    { name: 'plain string', value: 'hello world' },
    { name: 'number', value: 42.5 },
    { name: 'true', value: true },
    { name: 'false', value: false },
    { name: 'nested', value: { arr: [1, 'two', [3, false], { nested: 'object' }], nil: null } },
  ];

  it.each(jsonRootCases)('round-trips a JSON root case: $name', async ({ value }) => {
    const ctx = getCtx();
    const row = await insertEntry(ctx, { payload: value });
    const stored = await readEntry(ctx, row.entryId);

    expect(stored?.payload).toEqual(value);
  });

  it('round-trips recorded_at exactly above the int32 range', async () => {
    const ctx = getCtx();
    // 2**32 + a visible tail: well above the int32 (2**31 - 1) boundary that a
    // 32-bit column would have silently wrapped or truncated.
    const recordedAt = 2 ** 32 + 123_456_789;

    const row = await insertEntry(ctx, { recordedAt });
    const stored = await readEntry(ctx, row.entryId);

    expect(stored?.recordedAt).toBe(recordedAt);
  });

  // ── 3. journal_position_counter ───────────────────────────────────────────

  it("rejects a position-counter row with id = 'other' (named singleton check)", async () => {
    const ctx = getCtx();
    const { journalPositionCounter } = resolveSchema(ctx.db, journalStorageSchema);

    await expect(toPromise(ctx.db.insert(journalPositionCounter).values({ id: 'other', value: 0 }))).rejects.toThrow();
  });

  it("upserts row 'journal' via ON CONFLICT DO UPDATE SET value = value + excluded.value RETURNING value, returning consecutive values", async () => {
    const ctx = getCtx();
    const { journalPositionCounter } = resolveSchema(ctx.db, journalStorageSchema);

    /**
     * The one statement the store will use to assign positions from the
     * shared counter: an upsert of row `'journal'` that adds the given
     * increment and returns the new value, in one round trip, identical on
     * both dialects.
     * @param increment - Amount to add to the counter.
     * @returns The counter's new value.
     */
    async function allocate(increment: number): Promise<number> {
      const [row] = await ctx.db
        .insert(journalPositionCounter)
        .values({ id: 'journal', value: increment })
        .onConflictDoUpdate({
          target: journalPositionCounter.id,
          set: { value: sql`${journalPositionCounter.value} + excluded.value` },
        })
        .returning({ value: journalPositionCounter.value });
      if (row === undefined) throw new Error('upsert returned no row');
      return row.value;
    }

    const first = await allocate(1);
    const second = await allocate(1);
    const third = await allocate(1);

    expect(second).toBe(first + 1);
    expect(third).toBe(second + 1);
  });

  // ── 4. journal_reader_states ──────────────────────────────────────────────

  it('rejects a second reading state with the same (reader, entry_id)', async () => {
    const ctx = getCtx();
    const { journalReaderStates } = resolveSchema(ctx.db, journalStorageSchema);
    const reader = uniqueId('dup-reader');
    const entryId = uniqueId('dup-state-entry');
    await insertReaderState(ctx, { reader, entryId });

    await expect(
      toPromise(ctx.db.insert(journalReaderStates).values(makeReaderStateRow({ reader, entryId }))),
    ).rejects.toThrow();
  });

  it('accepts the same entry under another reader', async () => {
    const ctx = getCtx();
    const entryId = uniqueId('shared-state-entry');
    const first = await insertReaderState(ctx, { reader: uniqueId('reader-a'), entryId });
    const second = await insertReaderState(ctx, { reader: uniqueId('reader-b'), entryId });

    expect(await readReaderState(ctx, first.reader, entryId)).toBeDefined();
    expect(await readReaderState(ctx, second.reader, entryId)).toBeDefined();
  });

  it("rejects state = 'other' (named check), inserted through raw SQL bypassing the TS enum", async () => {
    const ctx = getCtx();
    const reader = uniqueId('other-state-reader');
    const entryId = uniqueId('other-state-entry');
    const position = allocatePosition();

    await expect(
      toPromise(
        ctx.executor.run(sql`
        INSERT INTO journal_reader_states
          (reader, entry_id, position, order_key, state, retries, reason, not_before, claim_token, claim_expires_at)
        VALUES
          (${reader}, ${entryId}, ${position}, NULL, 'other', 0, NULL, NULL, NULL, NULL)
      `),
      ),
    ).rejects.toThrow();
  });

  it('defaults retries to 0 when the insert omits it', async () => {
    const ctx = getCtx();
    const reader = uniqueId('retries-default-reader');
    const entryId = uniqueId('retries-default-entry');

    // makeReaderStateRow never sets `retries` itself, so this insert leaves
    // it to the column default — exactly the case under test.
    await insertReaderState(ctx, { reader, entryId });

    expect((await readReaderState(ctx, reader, entryId))?.retries).toBe(0);
  });

  it('accepts null for every nullable field', async () => {
    const ctx = getCtx();
    const reader = uniqueId('nullable-reader');
    const entryId = uniqueId('nullable-entry');
    await insertReaderState(ctx, {
      reader,
      entryId,
      orderKey: null,
      reason: null,
      notBefore: null,
      claimToken: null,
      claimExpiresAt: null,
    });

    const stored = await readReaderState(ctx, reader, entryId);
    expect(stored?.orderKey).toBeNull();
    expect(stored?.reason).toBeNull();
    expect(stored?.notBefore).toBeNull();
    expect(stored?.claimToken).toBeNull();
    expect(stored?.claimExpiresAt).toBeNull();
  });

  // ── 5. journal_edge_cursors ────────────────────────────────────────────────

  it('rejects a second cursor with the same (edge, partition)', async () => {
    const ctx = getCtx();
    const { journalEdgeCursors } = resolveSchema(ctx.db, journalStorageSchema);
    const edge = uniqueId('dup-edge');
    const partition = uniqueId('dup-partition');
    await ctx.db.insert(journalEdgeCursors).values(makeEdgeCursorRow({ edge, partition }));

    await expect(
      toPromise(ctx.db.insert(journalEdgeCursors).values(makeEdgeCursorRow({ edge, partition }))),
    ).rejects.toThrow();
  });

  it('accepts a null value', async () => {
    const ctx = getCtx();
    const { journalEdgeCursors } = resolveSchema(ctx.db, journalStorageSchema);
    const edge = uniqueId('null-value-edge');
    const partition = uniqueId('null-value-partition');
    await ctx.db.insert(journalEdgeCursors).values(makeEdgeCursorRow({ edge, partition, value: null }));

    const [stored] = await ctx.db
      .select()
      .from(journalEdgeCursors)
      .where(sql`${journalEdgeCursors.edge} = ${edge} AND ${journalEdgeCursors.partition} = ${partition}`);
    expect(stored?.value).toBeNull();
  });
});
