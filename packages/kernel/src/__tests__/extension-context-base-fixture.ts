import { useJournalHostFixture } from '@makaio/storage-conformance';
import type { ExtensionContextBase } from '../extension/types.js';

/**
 * Minimal {@link ExtensionContextBase} fields (excluding coordinator-owned and bus-owned fields)
 * for test coordinators, shared by every kernel test that only needs a `create`-factory-capable
 * coordinator and does not exercise host-specific context fields itself.
 *
 * One definition, not a copy per test file: every field here is plain, platform-independent test
 * data, so a test that needs a different value (a distinct `machineId`, for example) should spread
 * this and override just that field rather than redefine the whole object.
 */
const { constructContext } = useJournalHostFixture();

export const TEST_EXTENSION_CONTEXT_BASE: ExtensionContextBase = {
  constructContext,
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async (_specifier) => null,
};
