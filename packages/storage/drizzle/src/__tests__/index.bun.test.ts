import { describe, expect, it } from 'bun:test';
import * as storageDrizzle from '../index.js';

describe('@makaio/storage-drizzle main entry', () => {
  it('does not expose the runtime-specific database client factory', () => {
    expect('createDatabaseClient' in storageDrizzle).toBe(false);
  });
});
