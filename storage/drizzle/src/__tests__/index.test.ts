import { describe, expect, it } from 'vitest';
import * as storageDrizzle from '../index';

describe('@makaio/storage-drizzle main entry', () => {
  it('does not expose the runtime-specific database client factory', () => {
    expect('createDatabaseClient' in storageDrizzle).toBe(false);
  });
});
