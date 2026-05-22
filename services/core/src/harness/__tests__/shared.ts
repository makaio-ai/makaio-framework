import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { createDbCleanup, createTempDb, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import type { HarnessInput } from '../storage/namespace.js';
import { registerDrizzleHarnessStorage } from '../storage/handler.js';

const CREATE_HARNESS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS harness_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    adapter_name TEXT,
    client_id TEXT,
    env TEXT,
    credentials TEXT,
    cwd TEXT,
    approval_policy TEXT NOT NULL DEFAULT 'always-ask',
    native_tools_enabled TEXT NOT NULL,
    native_tools_disabled TEXT NOT NULL,
    registry_tools_enabled TEXT NOT NULL,
    registry_tools_disabled TEXT NOT NULL,
    skills_enabled TEXT,
    skills_disabled TEXT,
    tool_capability_map TEXT,
    capability_overrides TEXT,
    tool_approval_overrides TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (adapter_name IS NOT NULL OR client_id IS NOT NULL)
  )
`;

/**
 * Creates a test harness input with sensible defaults.
 * @param overrides - Fields to override from defaults
 * @returns HarnessInput for testing
 */
export function createHarness(overrides: Partial<HarnessInput> = {}): HarnessInput {
  return {
    id: `harness-${Math.random().toString(36).slice(2)}`,
    name: 'Codex Native',
    description: 'Default codex harness',
    adapterName: 'codex-app-server',
    approvalPolicy: 'always-ask',
    nativeTools: {
      enabled: ['bash'],
      disabled: [],
    },
    registryTools: {
      enabled: [],
      disabled: [],
    },
    skills: undefined,
    isDefault: false,
    enabled: true,
    ...overrides,
  };
}

export type { TestDbContextWithCleanup as TestDbContext };

/**
 * Creates an isolated test database with harness storage handlers registered.
 * @returns Test database context with cleanup function
 */
export async function createTestDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath } = await createTempDb('harness');

  await db.run(CREATE_HARNESS_TABLE_SQL);

  const handlerCleanup = registerDrizzleHarnessStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));
  const cleanup = createDbCleanup(handlerCleanup, close, dbPath);

  return { db, close, dbPath, cleanup };
}
