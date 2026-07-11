import { type ClientRecord } from '@makaio/services-core/settings/storage';

/**
 * Build a minimal {@link ClientRecord} for use in tests.
 *
 * Required fields (`id`, `name`, `packageName`, `enabled`) must be provided;
 * all other fields default to sensible no-op values.
 * @param overrides - Required identity fields plus any optional overrides.
 * @returns A fully typed {@link ClientRecord} with defaults filled in.
 */
export function makeClientRecord(
  overrides: Partial<ClientRecord> & Pick<ClientRecord, 'id' | 'name' | 'packageName' | 'enabled'>,
): ClientRecord {
  return {
    description: undefined,
    binary: undefined,
    nativeTools: [],
    defaultApprovalPolicy: 'always-ask',
    logSources: undefined,
    authMethods: [],
    defaultAuth: undefined,
    env: undefined,
    cwd: undefined,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
