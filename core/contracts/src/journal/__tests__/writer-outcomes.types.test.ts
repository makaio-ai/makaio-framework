import { describe, expect, it } from 'vitest';
import type { ExternalObjectRef } from '../external-object-ref.js';
import type { FindExistingOutcome, WriterOutcome } from '../writer.js';
import type {
  ConnectionExchangeAccepted,
  ConnectionExchangeRejected,
  ConnectionExchangeResult,
} from '../../boundary/exchange.js';

/**
 * Type-level tests: the assertions are the `@ts-expect-error` lines. The type
 * check reports an unused directive, so a line that stops being an error fails
 * the check. Vitest does not check types, so the runtime body only proves the
 * file loads; the type check (not the test run) carries the claims.
 */

declare const object: ExternalObjectRef;

/** Never called; compiled only. */
function writerOutcomeAssertions(): void {
  const refusal = { code: 'x', reason: 'y', retryable: false };
  const written: WriterOutcome = { written: object };
  const notWritten: WriterOutcome = { notWritten: refusal };
  const unknown: WriterOutcome = { unknown: 'not sure' };
  void [written, notWritten, unknown];

  // @ts-expect-error written and notWritten are mutually exclusive
  const writtenAndNotWritten: WriterOutcome = { written: object, notWritten: refusal };
  void writtenAndNotWritten;

  // @ts-expect-error written and unknown are mutually exclusive
  const writtenAndUnknown: WriterOutcome = { written: object, unknown: 'not sure' };
  void writtenAndUnknown;

  // @ts-expect-error notWritten and unknown are mutually exclusive
  const notWrittenAndUnknown: WriterOutcome = { notWritten: refusal, unknown: 'not sure' };
  void notWrittenAndUnknown;
}

/** Never called; compiled only. */
function findExistingOutcomeAssertions(): void {
  const found: FindExistingOutcome = { found: object };
  const absent: FindExistingOutcome = { absent: true };
  const undecidable: FindExistingOutcome = { undecidable: 'not sure' };
  void [found, absent, undecidable];

  // @ts-expect-error found and absent are mutually exclusive
  const foundAndAbsent: FindExistingOutcome = { found: object, absent: true };
  void foundAndAbsent;

  // @ts-expect-error found and undecidable are mutually exclusive
  const foundAndUndecidable: FindExistingOutcome = { found: object, undecidable: 'not sure' };
  void foundAndUndecidable;

  // @ts-expect-error absent and undecidable are mutually exclusive
  const absentAndUndecidable: FindExistingOutcome = { absent: true, undecidable: 'not sure' };
  void absentAndUndecidable;
}

/** Never called; compiled only. */
function connectionExchangeAssertions(): void {
  const party = { kind: 'acme.party', id: 'p1' };
  const accepted: ConnectionExchangeAccepted = { party, payload: null };
  const rejected: ConnectionExchangeRejected = { reject: 'denied' };
  const acceptedResult: ConnectionExchangeResult = accepted;
  const rejectedResult: ConnectionExchangeResult = rejected;
  void [accepted, rejected, acceptedResult, rejectedResult];

  // @ts-expect-error an accepted result may not also carry reject
  const acceptedWithReject: ConnectionExchangeAccepted = { party, payload: null, reject: 'denied' };
  void acceptedWithReject;

  // @ts-expect-error a rejected result may not also carry the accepted fields
  const rejectedWithParty: ConnectionExchangeRejected = { reject: 'denied', party };
  void rejectedWithParty;

  // @ts-expect-error a rejected result may not also carry payload
  const rejectedWithPayload: ConnectionExchangeRejected = { reject: 'denied', payload: null };
  void rejectedWithPayload;
}

describe('WriterOutcome, FindExistingOutcome and ConnectionExchangeResult (type level)', () => {
  it('compiles the assertions', () => {
    expect(typeof writerOutcomeAssertions).toBe('function');
    expect(typeof findExistingOutcomeAssertions).toBe('function');
    expect(typeof connectionExchangeAssertions).toBe('function');
  });
});
