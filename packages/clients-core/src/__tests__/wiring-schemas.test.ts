/**
 * Tests for wiring-schemas.ts and create-client-wiring-list-subject.ts.
 *
 * Covers:
 * - {@link AbsolutePathSchema} accepts absolute paths and rejects relative ones
 * - {@link assertAbsoluteProjectDir} throws on relative paths, passes on
 *   absolute paths and `undefined`
 * - {@link ClientWiringListResponseSchema} parses valid entries
 * - {@link ClientWiringApplyResponseSchema} parses valid responses and rejects
 *   negative numbers
 * - {@link ClientWiringRemoveResponseSchema} parses valid responses
 * - {@link ClientWiringAggregatedResultSchema} parses valid aggregated results
 * - {@link createClientWiringSubjectDef} produces correct subject definitions
 * - {@link createClientWiringListSubjectDef} produces correct typed subject defs
 */

import { describe, expect, it } from 'vitest';
import {
  AbsolutePathSchema,
  assertAbsoluteProjectDir,
  ClientWiringListResponseSchema,
  ClientWiringApplyResponseSchema,
  ClientWiringRemoveResponseSchema,
  ClientWiringAggregatedResultSchema,
} from '../wiring-schemas.js';
import {
  createClientWiringSubjectDef,
  createClientWiringListSubjectDef,
} from '../create-client-wiring-list-subject.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_WIRING_ENTRY = {
  group: 'session-events',
  name: 'PreToolUse',
  installed: true,
  command: 'makaio hook received claude-code PreToolUse',
};

// ---------------------------------------------------------------------------
// AbsolutePathSchema
// ---------------------------------------------------------------------------

describe('AbsolutePathSchema', () => {
  it('accepts an absolute path', () => {
    const result = AbsolutePathSchema.safeParse('/home/user/project');
    expect(result.success).toBe(true);
  });

  it('accepts a deeply nested absolute path', () => {
    const result = AbsolutePathSchema.safeParse('/home/alice/work/project');
    expect(result.success).toBe(true);
  });

  it('rejects a relative path', () => {
    const result = AbsolutePathSchema.safeParse('relative/path');
    expect(result.success).toBe(false);
  });

  it('rejects a dot-relative path', () => {
    const result = AbsolutePathSchema.safeParse('./path/to/dir');
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = AbsolutePathSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects a non-string value', () => {
    const result = AbsolutePathSchema.safeParse(42);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertAbsoluteProjectDir
// ---------------------------------------------------------------------------

describe('assertAbsoluteProjectDir', () => {
  it('does not throw when projectDir is undefined', () => {
    expect(() => assertAbsoluteProjectDir(undefined)).not.toThrow();
  });

  it('does not throw when projectDir is an absolute path', () => {
    expect(() => assertAbsoluteProjectDir('/home/user/project')).not.toThrow();
  });

  it('throws when projectDir is a relative path', () => {
    expect(() => assertAbsoluteProjectDir('relative/path')).toThrow(
      'projectDir must be an absolute path, got: relative/path',
    );
  });

  it('throws when projectDir is a dot-relative path', () => {
    expect(() => assertAbsoluteProjectDir('./local/dir')).toThrow(
      'projectDir must be an absolute path, got: ./local/dir',
    );
  });

  it('throws when projectDir is a bare filename', () => {
    expect(() => assertAbsoluteProjectDir('project')).toThrow('projectDir must be an absolute path, got: project');
  });
});

// ---------------------------------------------------------------------------
// ClientWiringListResponseSchema
// ---------------------------------------------------------------------------

describe('ClientWiringListResponseSchema', () => {
  it('parses a response with a single valid wiring entry', () => {
    const result = ClientWiringListResponseSchema.parse({
      entries: [VALID_WIRING_ENTRY],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe('PreToolUse');
    expect(result.entries[0]?.installed).toBe(true);
  });

  it('parses a response with an empty entries array', () => {
    const result = ClientWiringListResponseSchema.parse({ entries: [] });
    expect(result.entries).toEqual([]);
  });

  it('parses a response with multiple wiring entries', () => {
    const result = ClientWiringListResponseSchema.parse({
      entries: [
        VALID_WIRING_ENTRY,
        { group: 'usage-stream', name: 'statusline', installed: false, command: 'makaio statusline' },
      ],
    });

    expect(result.entries).toHaveLength(2);
  });

  it('rejects a response missing the entries field', () => {
    const result = ClientWiringListResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects entries with an empty group', () => {
    const result = ClientWiringListResponseSchema.safeParse({
      entries: [{ ...VALID_WIRING_ENTRY, group: '' }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientWiringApplyResponseSchema
// ---------------------------------------------------------------------------

// Individual rejection tests are kept explicit (not table-driven) so each
// test title documents the specific constraint being validated.
describe('ClientWiringApplyResponseSchema', () => {
  it('parses a valid apply response', () => {
    const result = ClientWiringApplyResponseSchema.parse({ applied: 3, skipped: 1 });

    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(1);
  });

  it('parses zero counts', () => {
    const result = ClientWiringApplyResponseSchema.parse({ applied: 0, skipped: 0 });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('rejects a negative applied count', () => {
    const result = ClientWiringApplyResponseSchema.safeParse({ applied: -1, skipped: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a negative skipped count', () => {
    const result = ClientWiringApplyResponseSchema.safeParse({ applied: 0, skipped: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer applied count', () => {
    const result = ClientWiringApplyResponseSchema.safeParse({ applied: 1.5, skipped: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a missing applied field', () => {
    const result = ClientWiringApplyResponseSchema.safeParse({ skipped: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a missing skipped field', () => {
    const result = ClientWiringApplyResponseSchema.safeParse({ applied: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientWiringRemoveResponseSchema
// ---------------------------------------------------------------------------

describe('ClientWiringRemoveResponseSchema', () => {
  it('parses a valid remove response', () => {
    const result = ClientWiringRemoveResponseSchema.parse({ removed: 2 });
    expect(result.removed).toBe(2);
  });

  it('parses zero removed entries', () => {
    const result = ClientWiringRemoveResponseSchema.parse({ removed: 0 });
    expect(result.removed).toBe(0);
  });

  it('rejects a negative removed count', () => {
    const result = ClientWiringRemoveResponseSchema.safeParse({ removed: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer removed count', () => {
    const result = ClientWiringRemoveResponseSchema.safeParse({ removed: 0.5 });
    expect(result.success).toBe(false);
  });

  it('rejects a missing removed field', () => {
    const result = ClientWiringRemoveResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientWiringAggregatedResultSchema
// ---------------------------------------------------------------------------

describe('ClientWiringAggregatedResultSchema', () => {
  it('parses a valid aggregated result', () => {
    const result = ClientWiringAggregatedResultSchema.parse({
      clientId: 'claude-code',
      entries: [VALID_WIRING_ENTRY],
    });

    expect(result.clientId).toBe('claude-code');
    expect(result.entries).toHaveLength(1);
  });

  it('parses a result with an empty entries array', () => {
    const result = ClientWiringAggregatedResultSchema.parse({
      clientId: 'codex',
      entries: [],
    });

    expect(result.clientId).toBe('codex');
    expect(result.entries).toEqual([]);
  });

  it('trims whitespace from clientId', () => {
    const result = ClientWiringAggregatedResultSchema.parse({
      clientId: '  claude-code  ',
      entries: [],
    });

    expect(result.clientId).toBe('claude-code');
  });

  it('rejects an empty clientId', () => {
    const result = ClientWiringAggregatedResultSchema.safeParse({
      clientId: '',
      entries: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only clientId', () => {
    const result = ClientWiringAggregatedResultSchema.safeParse({
      clientId: '   ',
      entries: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing clientId', () => {
    const result = ClientWiringAggregatedResultSchema.safeParse({ entries: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a missing entries field', () => {
    const result = ClientWiringAggregatedResultSchema.safeParse({ clientId: 'claude-code' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createClientWiringSubjectDef
// ---------------------------------------------------------------------------

// $meta assertions are explicit per-subject so failures pinpoint which
// subject has the wrong metadata — a shared helper would obscure that.
describe('createClientWiringSubjectDef', () => {
  it('sets subject to the provided suffix', () => {
    const def = createClientWiringSubjectDef('claude-code', 'wiring.list');
    expect(def.subject).toBe('wiring.list');
  });

  it('sets namespace to client:<normalized-id>', () => {
    const def = createClientWiringSubjectDef('claude-code', 'wiring.list');
    expect(def.$meta.namespace).toBe('client:claude-code');
  });

  it('normalizes a client: prefix in the input id', () => {
    const def = createClientWiringSubjectDef('client:codex', 'wiring.apply');
    expect(def.$meta.namespace).toBe('client:codex');
  });

  it('normalizes uppercase input to lowercase in the namespace', () => {
    const def = createClientWiringSubjectDef('Claude-Code', 'wiring.remove');
    expect(def.$meta.namespace).toBe('client:claude-code');
  });

  it('sets isRequest to true', () => {
    const def = createClientWiringSubjectDef('claude-code', 'wiring.list');
    expect(def.$meta.isRequest).toBe(true);
  });

  it('sets local to false', () => {
    const def = createClientWiringSubjectDef('claude-code', 'wiring.list');
    expect(def.$meta.local).toBe(false);
  });

  it('sets channel to false', () => {
    const def = createClientWiringSubjectDef('claude-code', 'wiring.list');
    expect(def.$meta.channel).toBe(false);
  });

  it('throws when clientId is empty', () => {
    expect(() => createClientWiringSubjectDef('', 'wiring.list')).toThrow('clientId must be a non-empty string');
  });

  it('throws when clientId contains invalid characters', () => {
    expect(() => createClientWiringSubjectDef('bad/client', 'wiring.list')).toThrow(
      'clientId must contain only lowercase letters, numbers, and hyphens',
    );
  });
});

// ---------------------------------------------------------------------------
// createClientWiringListSubjectDef
// ---------------------------------------------------------------------------

describe('createClientWiringListSubjectDef', () => {
  it('sets subject to wiring.list', () => {
    const def = createClientWiringListSubjectDef('claude-code');
    expect(def.subject).toBe('wiring.list');
  });

  it('sets namespace to client:<id>', () => {
    const def = createClientWiringListSubjectDef('claude-code');
    expect(def.$meta.namespace).toBe('client:claude-code');
  });

  it('normalizes a client: prefix in the input id', () => {
    const def = createClientWiringListSubjectDef('client:codex');
    expect(def.$meta.namespace).toBe('client:codex');
  });

  it('sets isRequest to true', () => {
    const def = createClientWiringListSubjectDef('claude-code');
    expect(def.$meta.isRequest).toBe(true);
  });

  it('sets local to false', () => {
    const def = createClientWiringListSubjectDef('claude-code');
    expect(def.$meta.local).toBe(false);
  });

  it('sets channel to false', () => {
    const def = createClientWiringListSubjectDef('claude-code');
    expect(def.$meta.channel).toBe(false);
  });

  it('produces distinct definitions for different client IDs', () => {
    const defA = createClientWiringListSubjectDef('claude-code');
    const defB = createClientWiringListSubjectDef('codex');

    expect(defA.$meta.namespace).toBe('client:claude-code');
    expect(defB.$meta.namespace).toBe('client:codex');
    expect(defA.$meta.namespace).not.toBe(defB.$meta.namespace);
  });
});
