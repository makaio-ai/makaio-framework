import { describe, expect, it } from 'bun:test';
import * as utils from '../index.js';

describe('@makaio/utils main entry', () => {
  it('does not expose node-only workspace root helpers', () => {
    expect('resolveWorkspaceRoot' in utils).toBe(false);
    expect('resolvePackageRoot' in utils).toBe(false);
  });
});
