import { describe, expect, it } from 'vitest';
import * as testUtils from '../index.js';

describe('@makaio/test-utils main entry', () => {
  it('does not expose node-backed drizzle harness helpers', () => {
    expect('createTempDb' in testUtils).toBe(false);
    expect('createPluginTestDb' in testUtils).toBe(false);
  });
});
