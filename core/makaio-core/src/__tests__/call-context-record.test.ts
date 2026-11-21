import { describe, expect, it } from 'vitest';
import type { CallContext, CallContextRecord } from '../types/call-context.js';
import { CallContextRecordSchema } from '../types/call-context.js';

/*
 * The kernel mint lives in `@makaio/bus-core`, which depends on this package, so these tests cannot import it.
 * A plain object with the fields of a minted context stands in: the schema reads fields only and never
 * looks at the nominal stamp.
 */
const caller = { kind: 'acme.user', id: 'u-1' };
const principal = { kind: 'acme.org', id: 'o-1', claims: { exec: 'e-1' } };
const attestor = { kind: 'makaio.host', id: 'h-1' };

describe('CallContextRecordSchema', () => {
  it('accepts a record without attestedBy', () => {
    const parsed = CallContextRecordSchema.safeParse({ caller, principal });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ caller, principal });
  });

  it('accepts a record with attestedBy', () => {
    const parsed = CallContextRecordSchema.safeParse({ caller, principal, attestedBy: attestor });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.attestedBy).toEqual(attestor);
  });

  it('rejects unknown keys at the top level', () => {
    expect(CallContextRecordSchema.safeParse({ caller, principal, extra: 1 }).success).toBe(false);
  });

  it('rejects a missing caller or principal', () => {
    expect(CallContextRecordSchema.safeParse({ principal }).success).toBe(false);
    expect(CallContextRecordSchema.safeParse({ caller }).success).toBe(false);
  });

  it('rejects a party that PartySchema rejects', () => {
    expect(CallContextRecordSchema.safeParse({ caller: { kind: 'nodot', id: '1' }, principal }).success).toBe(false);
    expect(CallContextRecordSchema.safeParse({ caller, principal: { kind: 'acme.org', id: '' } }).success).toBe(false);
    expect(
      CallContextRecordSchema.safeParse({ caller, principal, attestedBy: { kind: 'acme.x', id: '1', y: 1 } }).success,
    ).toBe(false);
  });

  it('parses the fields of a call context into a record with the same parties', () => {
    // Only the fields are read; the nominal stamp is a type-level construct.
    const context = Object.freeze({ caller, principal, attestedBy: attestor });
    const parsed = CallContextRecordSchema.safeParse(context);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.caller).toEqual(context.caller);
    expect(parsed.data?.principal).toEqual(context.principal);
    expect(parsed.data?.attestedBy).toEqual(context.attestedBy);
  });
});

declare const record: CallContextRecord;
declare const context: CallContext;

/** Never called; compiled only. The `@ts-expect-error` line is the assertion. */
function typeAssertions(): void {
  // A context is readable as a record.
  const asRecord: CallContextRecord = context;
  void asRecord;

  // @ts-expect-error a record lacks the nominal stamp and is not a call context
  const asContext: CallContext = record;
  void asContext;
}
void typeAssertions;
