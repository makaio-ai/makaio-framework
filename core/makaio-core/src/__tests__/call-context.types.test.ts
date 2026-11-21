import { describe, expect, it } from 'vitest';
import type { CallContext, CrossHostMetadata } from '../types/call-context.js';
import type { CallClaim, Party, PartyRef } from '../types/party.js';

/**
 * Type-level tests: the assertions are the `@ts-expect-error` lines. The type
 * check reports an unused directive, so a line that stops being an error fails
 * the check. Vitest does not check types, so the runtime body only proves the
 * file loads; the type check (not the test run) carries the claims.
 */

declare const ctx: CallContext;
declare const nestedObject: Extract<CallClaim, { readonly [key: string]: CallClaim }>;
declare const list: Extract<CallClaim, readonly unknown[]>;
declare const party: Party;

/** Never called; compiled only. */
function typeAssertions(): void {
  // Reading works and yields the declared party shapes.
  const caller: Party = ctx.caller;
  const principal: Party = ctx.principal;
  const attestedBy: Party | undefined = ctx.attestedBy;
  void [caller, principal, attestedBy];

  // A context is passable where a CallContext is expected.
  const pass = (call: CallContext): CallContext => call;
  pass(ctx);

  // @ts-expect-error an object literal lacks the nominal stamp
  const literal: CallContext = { caller: party, principal: party };
  void literal;

  // @ts-expect-error a spread of a context lacks the nominal stamp
  const spread: CallContext = { ...ctx };
  void spread;

  // @ts-expect-error swapping the principal through a spread does not yield a context
  const swapped: CallContext = { ...ctx, principal: party };
  void swapped;

  // @ts-expect-error a context is not buildable from its parts passed as an argument literal
  pass({ caller: party, principal: party });

  // @ts-expect-error caller.id is read-only
  ctx.caller.id = 'other';

  // @ts-expect-error caller.kind is read-only
  ctx.caller.kind = 'acme.other';

  // @ts-expect-error principal is read-only
  ctx.principal = party;

  // @ts-expect-error claims are read-only on the party
  ctx.caller.claims = {};

  const claims = ctx.caller.claims;
  if (claims !== undefined) {
    // @ts-expect-error claim entries are read-only
    claims.executionId = 'x';

    // @ts-expect-error nested claim objects are read-only
    nestedObject.deep = 1;

    // @ts-expect-error claim arrays are read-only
    list.push('x');
  }

  // A bare { kind, id } is a PartyRef; a Party (which may carry claims) is not.
  const ref: PartyRef = { kind: 'acme.custom', id: 'x' };
  const okMetadata: CrossHostMetadata = { principal: { kind: 'acme.custom', id: 'x' } };
  void [ref, okMetadata];

  // @ts-expect-error a value typed Party is not assignable to a PartyRef
  const leakedRef: PartyRef = party;
  void leakedRef;

  // @ts-expect-error a value typed Party cannot be cross-host metadata
  const leakedMetadata: CrossHostMetadata = { principal: party };
  void leakedMetadata;
}

describe('CallContext (type level)', () => {
  it('compiles the assertions', () => {
    expect(typeof typeAssertions).toBe('function');
  });
});
