/**
 * Contract tests for the `client.runtime.observe` subject builder and the
 * `pickNonEmptyStringValue` helper exposed by the light `hook-subjects` module.
 *
 * The builder deliberately avoids a runtime import of `ClientSubjects`, so these
 * tests import it and pin parity: drift of the generated namespace breaks CI.
 */
import { ClientSubjects } from '@makaio/contracts/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { pickNonEmptyStringValue as pickFromObservedSemantics } from '../client-session-observed-semantics.js';
import { createClientRuntimeObserveSubject, pickNonEmptyStringValue } from '../hook-subjects.js';

describe('createClientRuntimeObserveSubject', () => {
  it('matches the generated ClientSubjects.runtime.observe definition', () => {
    expect(createClientRuntimeObserveSubject()).toEqual({
      subject: ClientSubjects.runtime.observe.subject,
      $meta: ClientSubjects.runtime.observe.$meta,
    });
  });

  it('returns a fresh object on every call', () => {
    const first = createClientRuntimeObserveSubject();
    const second = createClientRuntimeObserveSubject();

    expect(first).not.toBe(second);
    expect(first.$meta).not.toBe(second.$meta);
    expect(first).toEqual(second);
  });

  it('has the same type as ClientSubjects.runtime.observe', () => {
    expectTypeOf(createClientRuntimeObserveSubject()).toEqualTypeOf<typeof ClientSubjects.runtime.observe>();
  });
});

describe('pickNonEmptyStringValue', () => {
  it('is the same function when re-exported from client-session-observed-semantics', () => {
    expect(pickFromObservedSemantics).toBe(pickNonEmptyStringValue);
  });

  it.each([undefined, null, 42, true, {}, ['a']])('returns undefined for non-string value %j', (value) => {
    expect(pickNonEmptyStringValue(value)).toBeUndefined();
  });

  it.each(['', '  ', '\t\n'])('returns undefined for empty or whitespace-only string %j', (value) => {
    expect(pickNonEmptyStringValue(value)).toBeUndefined();
  });

  it('trims surrounding whitespace from non-empty strings', () => {
    expect(pickNonEmptyStringValue(' a ')).toBe('a');
  });
});
