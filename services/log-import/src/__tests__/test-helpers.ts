import type { LogImporter, DiscoveryMetadata, ImportSegmentLineage } from '@makaio/ai-adapters-core';

/**
 * Creates a mock LogImporter for testing.
 * @param overrides - Optional method overrides
 * @returns Mock LogImporter instance
 */
export function createMockImporter(overrides?: Partial<LogImporter<unknown, unknown>>): LogImporter<unknown, unknown> {
  return {
    canHandle: () => false,
    getLogDirectory: () => '/test',
    parseRecord: () => null,
    isMakaioManaged: async () => false,
    extractDiscoveryMetadata: async (): Promise<DiscoveryMetadata> => ({
      adapterSessionId: 'test',
      model: null,
      cwd: null,
      title: 'Test session',
      hasMessages: true,
    }),
    extractSessionContext: () => ({
      adapterSessionId: 'test',
      model: 'test',
      cwd: '/test',
      sessionEvent: { subject: {} as never, payload: {} },
      startedEvent: { subject: {} as never, payload: {} },
      state: {},
    }),
    processRecords: () => [],
    serializeState: (state) => state as never,
    deserializeState: (raw) => raw,
    processLogFile: () => ({
      adapterSessionId: 'test',
      sessionEvent: { subject: {} as never, payload: {} },
      messageEvents: [],
      messagePayloads: [],
      lineage: {
        kind: 'root' as const,
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      } satisfies ImportSegmentLineage,
    }),
    ...overrides,
  };
}
