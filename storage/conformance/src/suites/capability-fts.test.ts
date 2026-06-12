/**
 * Conformance suite: full-text-search capability.
 *
 * Both built-in dialect configs (SQLite and Postgres) implement FTS for real:
 * - SQLite: FTS5 virtual table with bm25 scoring and porter stemming.
 * - Postgres: tsvector stored generated column (`messages.content_tsv`,
 *   english regconfig) with ts_rank scoring and ts_headline excerpts.
 *
 * The suite pins the response SHAPE per dialect and never asserts cross-dialect
 * result equality — ranking algorithms differ by design (bm25 vs ts_rank,
 * different score ranges). Ordering and relevance invariants (score DESC, the
 * obviously-more-relevant document wins) are asserted within a single dialect
 * run only.
 *
 * Configs with `fts: false` skip the whole suite visibly (describe.skip) and
 * run none of its setup — no database is provisioned and no handlers are
 * registered. The gate reads `config.capabilities.fts`, never dialect literals.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { makeStubExtensionContext } from '@makaio/test-utils';
import {
  SessionStorageSubjects,
  MessageStorageSubjects,
  registerDrizzleSessionStorage,
  registerDrizzleAgentStorage,
  registerFtsSearchHandler,
  registerDrizzleTurnStorage,
  registerDrizzleMessageStorage,
} from '@makaio/services-core';
import { installMessagesFtsTestSchema } from '@makaio/services-core/session/testing';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import type { StorageDatabaseContext } from '../harness/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a session row for FTS fixtures.
 *
 * When `isImported` is given, it is bound dialect-correctly (native boolean
 * on Postgres, 0/1 integer on SQLite); when omitted the column stays NULL.
 * @param ctx - Active database context.
 * @param sessionId - Session ID to create.
 * @param options - Optional creation timestamp and import flag.
 */
async function seedSession(
  ctx: StorageDatabaseContext,
  sessionId: string,
  options: { timestamp?: number; isImported?: boolean } = {},
): Promise<void> {
  const ts = options.timestamp ?? Date.now();
  if (options.isImported === undefined) {
    await ctx.executor.run(
      sql`INSERT INTO sessions (session_id, created_at, last_activity_at, status)
          VALUES (${sessionId}, ${ts}, ${ts}, 'active')`,
    );
    return;
  }
  const isImportedValue = ctx.dialect === 'postgres' ? options.isImported : options.isImported ? 1 : 0;
  await ctx.executor.run(
    sql`INSERT INTO sessions (session_id, created_at, last_activity_at, status, is_imported)
        VALUES (${sessionId}, ${ts}, ${ts}, 'active', ${isImportedValue})`,
  );
}

/**
 * Seed a user message row for FTS fixtures.
 *
 * The FTS index stays in sync automatically: the FTS5 INSERT trigger on SQLite
 * and the stored generated column `content_tsv` on Postgres are both maintained
 * by the database engine — never write them directly.
 * @param ctx - Active database context.
 * @param messageId - Message ID to create.
 * @param sessionId - Owning session ID.
 * @param content - Plain-text message content (FTS-indexed).
 * @param timestamp - Message timestamp in epoch milliseconds.
 */
async function seedMessage(
  ctx: StorageDatabaseContext,
  messageId: string,
  sessionId: string,
  content: string,
  timestamp: number,
): Promise<void> {
  await ctx.executor.run(
    sql`INSERT INTO messages (message_id, session_id, role, content_text, blocks, timestamp)
        VALUES (${messageId}, ${sessionId}, 'user', ${content}, '[]', ${timestamp})`,
  );
}

/**
 * Seed a session row and one message whose content embeds a distinctive token.
 * @param ctx - Active database context.
 * @param sessionId - Session ID to create.
 * @param token - Distinctive token to embed in message content.
 */
async function seedFtsData(ctx: StorageDatabaseContext, sessionId: string, token: string): Promise<void> {
  const now = Date.now();
  await seedSession(ctx, sessionId, { timestamp: now });
  await seedMessage(ctx, 'msg-' + sessionId, sessionId, 'conformance fts token ' + token + ' unique-marker', now);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('capability-fts', (config) => {
  // Every test in this file is FTS-only, so the capability gate wraps the
  // entire suite body: when `capabilities.fts` is false, the single skipped
  // describe keeps the skip visible in the report while none of the hooks
  // inside — database provisioning included — ever run. Gating structurally
  // here, instead of guarding individual hook bodies, keeps every piece of
  // setup unreachable for non-FTS configs by construction.
  const describeFts = config.capabilities.fts ? describe : describe.skip;

  describeFts('fts === true (capable path)', () => {
    const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: true });
    const cleanups: Array<() => void> = [];

    beforeAll(async () => {
      const ctx = getCtx();
      const extCtx = makeStubExtensionContext(MakaioBus);

      if (config.dialect === 'sqlite') {
        // FTS5 virtual table and sync triggers are SQLite's storage mechanism.
        // Postgres gets content_tsv from the central chain applied above.
        await installMessagesFtsTestSchema(ctx.db);
      }

      // Register the handlers that serve the three subjects under test.
      // Order: session before FTS search handler.
      cleanups.push(registerDrizzleSessionStorage(MakaioBus, ctx.db, extCtx));
      cleanups.push(registerDrizzleAgentStorage(MakaioBus, ctx.db, extCtx));
      cleanups.push(registerDrizzleTurnStorage(MakaioBus, ctx.db, extCtx));
      cleanups.push(registerDrizzleMessageStorage(MakaioBus, ctx.db, extCtx));
      // storage:session.search is served by the dedicated FTS handler.
      cleanups.push(registerFtsSearchHandler(MakaioBus, ctx.db));
    });

    afterAll(() => {
      // Unregister handlers in reverse order; the context helper's afterAll
      // (registered earlier, therefore run later) destroys the database.
      for (let i = cleanups.length - 1; i >= 0; i--) {
        cleanups[i]?.();
      }
    });

    const TOKEN = 'xyzconformanceftstoken';
    const SESSION_ID = 'conformance-fts-session-1';

    describe('seeded-data queries', () => {
      beforeAll(async () => {
        await seedFtsData(getCtx(), SESSION_ID, TOKEN);
      });

      it('storage:message.search returns a hit for a matching token', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.search, {
          query: TOKEN,
        });
        expect(result.messages.length).toBeGreaterThan(0);
        expect(result.total).toBeGreaterThan(0);
      });

      it('storage:message.search returns empty shape for a no-match query', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.search, {
          query: 'zzznomatchftscontentzzz',
        });
        expect(result).toMatchObject({ messages: [], total: 0 });
      });

      it('storage:message.ftsSearch returns a scored hit with <mark> excerpt', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.ftsSearch, {
          query: TOKEN,
        });
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.total).toBeGreaterThan(0);

        const hit = result.results[0];
        expect(hit).toBeDefined();
        // Score must be positive (SQLite negates bm25() and orders DESC; ts_rank is naturally positive).
        expect(hit!.score).toBeGreaterThan(0);
        // The excerpt must carry a well-formed <mark>...</mark> highlight for the matched token.
        expect(hit!.excerpt).toMatch(/<mark>[^<]+<\/mark>/);
      });

      it('storage:message.ftsSearch returns empty shape for a no-match query', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.ftsSearch, {
          query: 'zzznomatchftsbm25zzz',
        });
        expect(result).toMatchObject({ results: [], total: 0 });
      });

      it('storage:session.search returns sessions+total shape for a matching token', async () => {
        const result = await MakaioBus.request(SessionStorageSubjects.search, {
          query: TOKEN,
        });
        expect(result.total).toBeGreaterThan(0);
        expect(result.sessions.length).toBeGreaterThan(0);
      });

      it('storage:session.search returns empty shape for a no-match query', async () => {
        const result = await MakaioBus.request(SessionStorageSubjects.search, {
          query: 'zzznomatchsessionsearchzzz',
        });
        expect(result).toMatchObject({ sessions: [], total: 0 });
      });
    });

    // ─── Stemming ────────────────────────────────────────────────────────────
    // Porter stemming on FTS5, english regconfig on Postgres — both reduce
    // 'running' to the 'run' stem, so a query for 'run' must return a message
    // containing 'running'.

    describe('stemming', () => {
      const STEM_TOKEN = 'xyzstemmingtoken';
      const STEM_SESSION = 'conformance-fts-stem-session';

      beforeAll(async () => {
        const ctx = getCtx();
        const now = Date.now();
        await seedSession(ctx, STEM_SESSION, { timestamp: now });
        await seedMessage(
          ctx,
          'msg-stem-' + STEM_SESSION,
          STEM_SESSION,
          'the indexer is running smoothly ' + STEM_TOKEN,
          now,
        );
      });

      it('query for stem "run" returns a message containing "running" (porter / english regconfig)', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.search, {
          query: 'run',
          sessionId: STEM_SESSION,
        });
        expect(result.messages.length).toBeGreaterThan(0);
        expect(result.messages[0]!.contentText).toContain('running');
      });
    });

    // ─── Score ordering ──────────────────────────────────────────────────────
    // Two messages in one session: message B is a short document consisting
    // only of the shared token repeated five times; message A mentions the
    // token once among filler. Both ranking algorithms deterministically rank
    // B strictly above A for this fixture (bm25: higher term frequency in a
    // shorter document; ts_rank: higher token density), so the winner IS
    // asserted — a ranking that degenerates to a constant (or otherwise stops
    // being relevance-sensitive) must fail here. Score MAGNITUDES remain
    // dialect-specific and are never compared across dialects.

    describe('score ordering', () => {
      const SCORE_TOKEN = 'xyzscoreordertoken';
      const SCORE_SESSION = 'conformance-fts-score-session';

      beforeAll(async () => {
        const ctx = getCtx();
        const now = Date.now();
        await seedSession(ctx, SCORE_SESSION, { timestamp: now });
        // Message A: token appears once among filler text. The earlier
        // timestamp means a relevance-insensitive ordering that falls through
        // to the timestamp tie-break would surface A first — which the
        // winner assertion below rejects.
        await seedMessage(
          ctx,
          'msg-score-a-' + SCORE_SESSION,
          SCORE_SESSION,
          'some filler text about nothing ' + SCORE_TOKEN + ' filler filler filler',
          now,
        );
        // Message B: token repeated several times to boost relevance.
        await seedMessage(
          ctx,
          'msg-score-b-' + SCORE_SESSION,
          SCORE_SESSION,
          SCORE_TOKEN + ' ' + SCORE_TOKEN + ' ' + SCORE_TOKEN + ' ' + SCORE_TOKEN + ' ' + SCORE_TOKEN,
          now + 1,
        );
      });

      it('ftsSearch ranks the token-dense message strictly above the single-occurrence one', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.ftsSearch, {
          query: SCORE_TOKEN,
          sessionId: SCORE_SESSION,
        });
        expect(result.results.length).toBe(2);
        for (const r of result.results) {
          expect(r.score).toBeGreaterThan(0);
        }
        // The obviously-more-relevant document must win with a strictly
        // higher score on both dialects.
        expect(result.results[0]!.messageId).toBe('msg-score-b-' + SCORE_SESSION);
        expect(result.results[0]!.score).toBeGreaterThan(result.results[1]!.score);
      });

      it('message.search returns the token-dense message first (relevance DESC)', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.search, {
          query: SCORE_TOKEN,
          sessionId: SCORE_SESSION,
        });
        expect(result.messages.length).toBe(2);
        // search carries no score field, so ordering is the only observable
        // relevance signal — pin it to the same deterministic winner.
        expect(result.messages[0]!.messageId).toBe('msg-score-b-' + SCORE_SESSION);
      });
    });

    // ─── Pagination / total ───────────────────────────────────────────────────
    // Three matching messages in one session; queries with limit=2 must return
    // two rows but report total=3 (total is independent of the page window).

    describe('pagination/total', () => {
      const PAGE_TOKEN = 'xyzpaginationtoken';
      const PAGE_SESSION = 'conformance-fts-page-session';

      beforeAll(async () => {
        const ctx = getCtx();
        const now = Date.now();
        await seedSession(ctx, PAGE_SESSION, { timestamp: now });
        for (let i = 1; i <= 3; i++) {
          await seedMessage(
            ctx,
            'msg-page-' + String(i) + '-' + PAGE_SESSION,
            PAGE_SESSION,
            'page test content ' + PAGE_TOKEN + ' item ' + String(i),
            now + i,
          );
        }
      });

      // The three documents are near-identical, so ts_rank scores them equally
      // on Postgres and ordering falls through to the documented
      // (timestamp ASC, message_id ASC) tie-break — the page is exactly the
      // two earliest messages, in order. bm25 on SQLite carries no such
      // tie-break, so page membership is asserted on the Postgres leg only.
      const expectedPostgresPage = ['msg-page-1-' + PAGE_SESSION, 'msg-page-2-' + PAGE_SESSION];

      it('message.ftsSearch { limit: 2 } returns 2 results but total === 3', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.ftsSearch, {
          query: PAGE_TOKEN,
          sessionId: PAGE_SESSION,
          limit: 2,
        });
        expect(result.results.length).toBe(2);
        expect(result.total).toBe(3);
        if (config.dialect === 'postgres') {
          expect(result.results.map((r) => r.messageId)).toEqual(expectedPostgresPage);
        }
      });

      it('message.search { limit: 2 } returns 2 messages but total === 3', async () => {
        const result = await MakaioBus.request(MessageStorageSubjects.search, {
          query: PAGE_TOKEN,
          sessionId: PAGE_SESSION,
          limit: 2,
        });
        expect(result.messages.length).toBe(2);
        expect(result.total).toBe(3);
        if (config.dialect === 'postgres') {
          expect(result.messages.map((m) => m.messageId)).toEqual(expectedPostgresPage);
        }
      });
    });

    // ─── isImported filters ───────────────────────────────────────────────────
    // Two sessions share a common token. One is seeded with is_imported set
    // (seedSession binds it dialect-correctly), the other with is_imported
    // omitted (NULL). session.search must route each filter to exactly one
    // session.

    describe('isImported filters', () => {
      const IMPORT_TOKEN = 'xyzimportfiltertoken';
      const IMPORT_SESSION_YES = 'conformance-fts-import-yes';
      const IMPORT_SESSION_NO = 'conformance-fts-import-no';

      beforeAll(async () => {
        const ctx = getCtx();
        const now = Date.now();

        await seedSession(ctx, IMPORT_SESSION_YES, { timestamp: now, isImported: true });
        await seedMessage(ctx, 'msg-import-yes', IMPORT_SESSION_YES, 'import filter test content ' + IMPORT_TOKEN, now);

        // is_imported omitted → NULL
        await seedSession(ctx, IMPORT_SESSION_NO, { timestamp: now });
        await seedMessage(ctx, 'msg-import-no', IMPORT_SESSION_NO, 'import filter test content ' + IMPORT_TOKEN, now);
      });

      it('session.search { isImported: true } returns only the imported session', async () => {
        const result = await MakaioBus.request(SessionStorageSubjects.search, {
          query: IMPORT_TOKEN,
          isImported: true,
        });
        expect(result.sessions.length).toBe(1);
        expect(result.sessions[0]!.sessionId).toBe(IMPORT_SESSION_YES);
      });

      it('session.search { isImported: false } returns only the non-imported session', async () => {
        const result = await MakaioBus.request(SessionStorageSubjects.search, {
          query: IMPORT_TOKEN,
          isImported: false,
        });
        expect(result.sessions.length).toBe(1);
        expect(result.sessions[0]!.sessionId).toBe(IMPORT_SESSION_NO);
      });
    });

    // ─── Preview tie-break ────────────────────────────────────────────────────
    // One session, two USER messages with the SAME timestamp. message_id
    // 'msg-tiebreak-aaa' (content starting 'alpha ...') is inserted before
    // 'msg-tiebreak-zzz' (content 'omega ...'). Both contain the tie-break
    // token. Rowid insertion order on SQLite and message_id lexicographic order
    // on Postgres agree by construction (aaa < zzz), so preview must pick
    // the 'alpha ...' message on both dialects.

    describe('preview tie-break', () => {
      const TIEBREAK_TOKEN = 'xyztiebreaktoken';
      const TIEBREAK_SESSION = 'conformance-fts-tiebreak-session';
      // Identical timestamp forces the tie-break path.
      const TIEBREAK_TS = 1_700_000_000_000;

      beforeAll(async () => {
        const ctx = getCtx();
        await seedSession(ctx, TIEBREAK_SESSION, { timestamp: TIEBREAK_TS });
        // Insert 'aaa' first so it gets a lower rowid (SQLite tie-break) and also
        // sorts lexicographically before 'zzz' (Postgres message_id tie-break).
        await seedMessage(
          ctx,
          'msg-tiebreak-aaa',
          TIEBREAK_SESSION,
          'alpha the earliest message ' + TIEBREAK_TOKEN,
          TIEBREAK_TS,
        );
        await seedMessage(
          ctx,
          'msg-tiebreak-zzz',
          TIEBREAK_SESSION,
          'omega the later message ' + TIEBREAK_TOKEN,
          TIEBREAK_TS,
        );
      });

      it('session.search preview picks the "alpha" message and messageCount === 2', async () => {
        const result = await MakaioBus.request(SessionStorageSubjects.search, {
          query: TIEBREAK_TOKEN,
        });

        const session = result.sessions.find((s) => s.sessionId === TIEBREAK_SESSION);
        expect(session).toBeDefined();
        expect(session!.preview.messageCount).toBe(2);
        // Tie-break must select the message inserted first ('aaa' < 'zzz').
        expect(session!.preview.firstUserMessage).toMatch(/^alpha /);
      });
    });
  });
});
