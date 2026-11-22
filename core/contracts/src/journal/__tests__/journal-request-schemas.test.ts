import { describe, expect, it } from 'vitest';
import { JournalEntriesRequestSchema, SubjectDirectoryListRequestSchema } from '../schemas.js';

const validPatterns = ['*', 'git.worktree', 'github.*', 'makaio:journal.*', 'storage:workflow:*'];
const malformedPatterns = ['nodot', 'foo**', 'a*b.c', '.*', 'a.b:*', ''];

describe('journal request schemas', () => {
  it.each(validPatterns)('accepts the subject pattern %j as a journal entries filter', (subject) => {
    expect(JournalEntriesRequestSchema.safeParse({ subject }).success).toBe(true);
  });

  it.each(malformedPatterns)('rejects the malformed pattern %j as a journal entries filter', (subject) => {
    expect(JournalEntriesRequestSchema.safeParse({ subject }).success).toBe(false);
  });

  it.each(validPatterns)('accepts the subject pattern %j as a subject directory filter', (pattern) => {
    expect(SubjectDirectoryListRequestSchema.safeParse({ pattern }).success).toBe(true);
  });

  it.each(malformedPatterns)('rejects the malformed pattern %j as a subject directory filter', (pattern) => {
    expect(SubjectDirectoryListRequestSchema.safeParse({ pattern }).success).toBe(false);
  });

  it('keeps both filters optional', () => {
    expect(JournalEntriesRequestSchema.safeParse({}).success).toBe(true);
    expect(SubjectDirectoryListRequestSchema.safeParse({}).success).toBe(true);
  });
});
