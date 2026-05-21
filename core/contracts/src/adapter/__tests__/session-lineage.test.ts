import { describe, it, expect } from 'vitest';
import { SessionLineageSchema } from '../schemas/session-lineage.js';

describe('SessionLineageSchema', () => {
  it('accepts a valid root lineage', () => {
    const parsed = SessionLineageSchema.parse({
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
    });

    expect(parsed.kind).toBe('root');
  });

  it('accepts a valid fork lineage', () => {
    const parsed = SessionLineageSchema.parse({
      kind: 'fork',
      parentAdapterSessionId: 'parent-session',
      forkPointMessageId: 'msg-123',
    });

    expect(parsed.kind).toBe('fork');
  });

  it('accepts a valid subagent lineage', () => {
    const parsed = SessionLineageSchema.parse({
      kind: 'subagent',
      parentAdapterSessionId: 'parent-session',
      forkPointMessageId: null,
    });

    expect(parsed.kind).toBe('subagent');
  });

  it('rejects invalid root lineage with parent metadata', () => {
    expect(() =>
      SessionLineageSchema.parse({
        kind: 'root',
        parentAdapterSessionId: 'parent-session',
        forkPointMessageId: 'msg-123',
      }),
    ).toThrow();
  });

  it('rejects invalid fork lineage missing fork point', () => {
    expect(() =>
      SessionLineageSchema.parse({
        kind: 'fork',
        parentAdapterSessionId: 'parent-session',
        forkPointMessageId: null,
      }),
    ).toThrow();
  });
});
