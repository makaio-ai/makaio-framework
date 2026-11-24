import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts/extension';
import type { NodeExtensionContext } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import { createJournalCapability, JournalContributionProcessor, SubjectDirectory } from '@makaio/services-core/journal';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { makeStubNodeExtensionContext, stubExtensionIdentity } from '@makaio/test-utils';
import { afterAll, beforeAll } from 'vitest';
import type { StorageDatabaseContext } from './config.js';
import { createSqliteConfig } from './sqlite-config.js';
import { useSuiteDatabaseContext } from './suite-context.js';

type NodeContext = NodeExtensionContext<IMakaioBus>;
type JournalFields = Pick<NodeContext, 'database' | 'journal'>;
type SharedContext = IsolatedNodeExtensionContext<IMakaioBus>;
type FixtureDatabase = Pick<StorageDatabaseContext, 'db'>;

/** Context builders backed by the suite's migrated database. */
interface JournalHostFixture {
  getDatabase: () => FixtureDatabase;
  constructContext: (context: SharedContext) => NodeContext;
  makeContext: (bus: IMakaioBus, overrides?: Partial<SharedContext>) => NodeContext;
}

/**
 * Supply real host capabilities for context fixtures that do not activate journal contributions.
 * @param getDatabase - Suite-owned database accessor. By default a migrated SQLite database is provisioned.
 * @returns Full context builders and the accessor for the same database handle.
 */
export function useJournalHostFixture(
  getDatabase: () => FixtureDatabase = useSuiteDatabaseContext(createSqliteConfig()),
): JournalHostFixture {
  const hostBus = createBusInstance();
  const coordinator = new ExtensionCoordinator(hostBus);
  const subjects = new SubjectDirectory(hostBus, coordinator);
  const contributions = new JournalContributionProcessor(subjects);
  let database: JournalFields['database'];

  beforeAll(async () => {
    database = createHostDatabase(getDatabase().db);
    await subjects.init();
  });
  afterAll(async () => {
    try {
      await coordinator.shutdown();
    } finally {
      await subjects.destroy();
    }
  });

  /**
   * Bind the fixture's journal to the context's bus and identity.
   * @param bus - Carrier used by the context.
   * @param extension - Extension to which the context belongs.
   * @param isActive - Lifecycle predicate for the context.
   * @returns The suite's database facade and an extension-bound journal.
   */
  function capabilities(bus: IMakaioBus, extension: string, isActive: () => boolean): JournalFields {
    return {
      database,
      journal: createJournalCapability({
        extension,
        bus,
        host: database,
        subjects,
        contributions,
        isActive,
        startGate: { awaitOpen: async () => {}, isOwnStartRunning: () => false },
      }),
    };
  }

  return {
    /**
     * @param context - Shared fields and carrier supplied by the coordinator.
     * @returns Full Node context using the fixture's database.
     */
    constructContext(context) {
      const extension = context.identity.extensionName;
      return { ...context, ...capabilities(context.bus, extension, () => context.hasExtension(extension)) };
    },
    /**
     * @param bus - Bus to pass through to the stub context.
     * @param overrides - Optional context fields used by the test.
     * @returns Stub Node context with real host capabilities.
     */
    makeContext(bus, overrides = {}) {
      const identity = overrides.identity ?? stubExtensionIdentity('test.stub');
      return makeStubNodeExtensionContext(bus, {
        ...overrides,
        identity,
        ...capabilities(bus, identity.extensionName, () => true),
      });
    },
    getDatabase,
  };
}
