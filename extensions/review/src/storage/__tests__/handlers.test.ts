import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { createTempDb, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { ReviewFinding } from '@makaio/contracts';
import { ReviewStorageSubjects } from '../namespace.js';
import { registerReviewStorageHandlers } from '../handlers.js';

const CREATE_REVIEW_FINDINGS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS extension_review_findings (
    id TEXT PRIMARY KEY NOT NULL,
    repository TEXT NOT NULL,
    pr_number INTEGER,
    branch TEXT,
    head_sha TEXT,
    source_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    origin TEXT NOT NULL,
    thread_id TEXT,
    severity TEXT NOT NULL,
    file TEXT,
    start_line INTEGER,
    end_line INTEGER,
    message TEXT NOT NULL,
    agent_prompt TEXT,
    suggested_changes TEXT NOT NULL,
    status TEXT NOT NULL,
    addressed_by TEXT,
    addressed_at INTEGER,
    verified_at INTEGER,
    dismissed_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    raw_comment_id INTEGER
  )
`;

const CREATE_REVIEW_FINDINGS_INDICES_SQL = [
  sql`CREATE INDEX IF NOT EXISTS idx_review_findings_repo_pr ON extension_review_findings(repository, pr_number)`,
  sql`CREATE INDEX IF NOT EXISTS idx_review_findings_status ON extension_review_findings(status)`,
  sql`CREATE INDEX IF NOT EXISTS idx_review_findings_reviewer ON extension_review_findings(reviewer)`,
  sql`CREATE INDEX IF NOT EXISTS idx_review_findings_source ON extension_review_findings(source_id)`,
];

const TARGET = { repository: 'owner/repo', prNumber: 42 };
const NOW = 1_700_000_000_000;

/**
 * Create a valid review finding fixture.
 * @param overrides - Fields to override on the default finding
 * @returns Review finding fixture
 */
function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'finding-1',
    target: TARGET,
    sourceId: 'source-1',
    reviewer: 'coderabbit',
    origin: 'inline',
    threadId: null,
    severity: 'minor',
    file: 'src/file.ts',
    startLine: 1,
    endLine: 1,
    message: 'Finding',
    agentPrompt: null,
    suggestedChanges: [],
    status: 'open',
    addressedBy: null,
    addressedAt: null,
    verifiedAt: null,
    dismissedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    rawCommentId: null,
    ...overrides,
  };
}

describe('registerReviewStorageHandlers', () => {
  let bus: IMakaioBus;
  let db: MakaioDatabase;
  let dbContext: TestDbContext;
  let cleanupHandlers: () => void;

  beforeEach(async () => {
    bus = createBusInstance();
    dbContext = await createTempDb('review-storage');
    db = dbContext.db;
    await db.run(CREATE_REVIEW_FINDINGS_TABLE_SQL);
    for (const indexSql of CREATE_REVIEW_FINDINGS_INDICES_SQL) {
      await db.run(indexSql);
    }
    cleanupHandlers = registerReviewStorageHandlers(bus, db, makeStubExtensionContext(bus));
  });

  afterEach(() => {
    cleanupHandlers();
    dbContext.cleanup();
  });

  it('filters findings by headSha when the target includes a head commit', async () => {
    const result = await bus.request(ReviewStorageSubjects.findings.upsertBatch, {
      findings: [
        makeFinding({ id: 'old-head', target: { ...TARGET, headSha: 'head-old' } }),
        makeFinding({ id: 'new-head', target: { ...TARGET, headSha: 'head-new' } }),
      ],
    });
    expect(result.upserted).toBe(2);

    const scoped = await bus.request(ReviewStorageSubjects.findings.list, {
      target: { ...TARGET, headSha: 'head-new' },
    });
    expect(scoped.findings.map((finding) => finding.id)).toEqual(['new-head']);

    const broad = await bus.request(ReviewStorageSubjects.findings.list, {
      target: TARGET,
    });
    expect(broad.findings).toHaveLength(2);
    expect(broad.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(['old-head', 'new-head']));
  });
});
