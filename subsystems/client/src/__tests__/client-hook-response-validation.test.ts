/**
 * Tests for the canonical-effects validation logic inside
 * {@link validateContributorResponse}.
 *
 * Focuses on the `validateCanonicalEffects` branch reached when the
 * contributor lane is `'canonical'`: verifies that `context.append` and
 * `session.token` effects are accepted, unknown kinds are rejected, and
 * extra keys are rejected.
 */

import { describe, it, expect } from 'vitest';
import { validateContributorResponse } from '../client-hook-response-validation.js';
import type { ContributorDefinition } from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANONICAL_DEF: Extract<ContributorDefinition, { lane: 'canonical' }> = {
  lane: 'canonical',
  id: 'test-canonical',
  priority: 0,
  timeoutMs: 5000,
  selectors: [{ kind: 'event-name', name: 'SessionStart' }],
  respond: () => ({}),
};

const EVENT_NAME = 'SessionStart';
const EVENT_PAYLOAD = { session_id: 'sess-001' };
const CLIENT_ID = 'claude-code';

// ---------------------------------------------------------------------------
// context.append effects
// ---------------------------------------------------------------------------

describe('validateContributorResponse — context.append effect', () => {
  it('accepts a valid context.append effect', () => {
    const result = validateContributorResponse(
      { canonicalEffects: [{ kind: 'context.append', value: 'extra context' }] },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).toBe(true);
  });

  it('accepts an empty canonicalEffects array', () => {
    const result = validateContributorResponse(
      { canonicalEffects: [] },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).toBe(true);
  });

  it('accepts undefined canonicalEffects', () => {
    const result = validateContributorResponse({}, CANONICAL_DEF, CLIENT_ID, undefined, EVENT_NAME, EVENT_PAYLOAD);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// session.token effects
// ---------------------------------------------------------------------------

describe('validateContributorResponse — session.token effect', () => {
  it('accepts a valid session.token effect', () => {
    const result = validateContributorResponse(
      { canonicalEffects: [{ kind: 'session.token', value: 'tok-abc-123' }] },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).toBe(true);
  });

  it('accepts multiple effects mixing context.append and session.token', () => {
    const result = validateContributorResponse(
      {
        canonicalEffects: [
          { kind: 'context.append', value: 'some context' },
          { kind: 'session.token', value: 'tok-xyz' },
        ],
      },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).toBe(true);
  });

  it('rejects a session.token effect with an empty value', () => {
    const result = validateContributorResponse(
      { canonicalEffects: [{ kind: 'session.token', value: '' }] },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
    expect(result).toContain('session.token');
    expect(result).toContain('non-empty');
  });

  it('accepts a context.append effect with an empty value (empty append is harmless)', () => {
    const result = validateContributorResponse(
      { canonicalEffects: [{ kind: 'context.append', value: '' }] },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown kind rejected
// ---------------------------------------------------------------------------

describe('validateContributorResponse — unknown effect kind', () => {
  it('rejects an effect with an unknown kind', () => {
    const result = validateContributorResponse(
      // @ts-expect-error deliberately passing unknown kind to test runtime validation
      { canonicalEffects: [{ kind: 'unknown.kind', value: 'something' }] },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
  });

  it('rejects an effect with kind: undefined', () => {
    const result = validateContributorResponse(
      // @ts-expect-error deliberately omitting kind to test runtime validation
      { canonicalEffects: [{ value: 'no kind here' }] },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).not.toBe(true);
  });

  it('rejects a null effect', () => {
    const result = validateContributorResponse(
      // @ts-expect-error deliberately passing null to test runtime validation
      { canonicalEffects: [null] },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extra keys rejected
// ---------------------------------------------------------------------------

describe('validateContributorResponse — extra keys on effect', () => {
  it('rejects a context.append effect with an extra key', () => {
    const result = validateContributorResponse(
      {
        canonicalEffects: [
          // @ts-expect-error deliberately adding extra key to test runtime validation
          { kind: 'context.append', value: 'text', extra: 'not allowed' },
        ],
      },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
  });

  it('rejects a session.token effect with an extra key', () => {
    const result = validateContributorResponse(
      {
        canonicalEffects: [
          // @ts-expect-error deliberately adding extra key to test runtime validation
          { kind: 'session.token', value: 'tok', extra: 'not allowed' },
        ],
      },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Non-array canonicalEffects rejected
// ---------------------------------------------------------------------------

describe('validateContributorResponse — malformed canonicalEffects', () => {
  it('rejects canonicalEffects that is not an array', () => {
    const result = validateContributorResponse(
      // @ts-expect-error testing runtime guard
      { canonicalEffects: 'not-an-array' },
      CANONICAL_DEF,
      CLIENT_ID,
      undefined,
      EVENT_NAME,
      EVENT_PAYLOAD,
    );
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
  });
});
