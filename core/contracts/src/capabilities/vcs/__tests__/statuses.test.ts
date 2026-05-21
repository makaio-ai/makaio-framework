import { describe, expect, it } from 'vitest';
import { VCSCommitStatusSchema } from '../schemas/statuses.js';

const VALID_STATUS = {
  id: 1,
  state: 'success',
  description: 'OK',
  targetUrl: 'https://example.com/status',
  context: 'ci/default',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:01:00Z',
  creator: null,
};

describe('VCSCommitStatusSchema', () => {
  it('accepts valid URL and ISO datetime fields', () => {
    expect(VCSCommitStatusSchema.safeParse(VALID_STATUS).success).toBe(true);
  });

  it('rejects malformed URL and timestamp fields', () => {
    expect(VCSCommitStatusSchema.safeParse({ ...VALID_STATUS, targetUrl: 'not a url' }).success).toBe(false);
    expect(VCSCommitStatusSchema.safeParse({ ...VALID_STATUS, createdAt: 'yesterday' }).success).toBe(false);
    expect(VCSCommitStatusSchema.safeParse({ ...VALID_STATUS, updatedAt: 'later' }).success).toBe(false);
  });
});
