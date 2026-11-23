import type { CallContext, Party, PartyRef } from '@makaio/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForeignOwnContextError, implicitOwn, own } from '../call-context/carrier.js';
import { InvalidCallContextError, mintCallContext } from '../call-context/mint.js';
import { __resetOwnWork, getOwnCallReport, trackOpenHandlerCall } from '../call-context/own-work.js';
import { enterSend } from '../call-context/send-entry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'MAKAIO_OWN_CALL_REPORT';
const SUBJECT = 'acme.test.subject';

const CARRIER_A: PartyRef = { kind: 'makaio.extension', id: 'send-entry-a' };
const CARRIER_B: PartyRef = { kind: 'makaio.extension', id: 'send-entry-b' };

/** Shared bus context of the sending instance; own contexts are bound to it. */
const BUS_CONTEXT = {};

const PERSON: Party = { kind: 'acme.person', id: 'person-1', claims: { role: 'admin' } };
const ATTESTER: Party = { kind: 'acme.gateway', id: 'gateway-1' };

/**
 * Mint a received-style context (no carrier record), as a transport delivery would.
 * @returns The minted context.
 */
function receivedContext(): CallContext {
  return mintCallContext({ caller: { kind: 'acme.remote', id: 'remote-1' }, principal: PERSON, attestedBy: ATTESTER });
}

let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  __resetOwnWork?.();
});

afterEach(() => {
  if (savedMode === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedMode;
  __resetOwnWork?.();
});

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

describe('enterSend derivation', () => {
  it('returns a context with the carrier as caller and keeps principal and attestedBy', () => {
    const sent = enterSend(receivedContext(), BUS_CONTEXT, CARRIER_A, SUBJECT);
    expect(sent.caller).toEqual(CARRIER_A);
    expect(sent.principal).toEqual(PERSON);
    expect(sent.attestedBy).toEqual(ATTESTER);
  });

  it('rejects a value that was not minted by the core', () => {
    const forged = { caller: CARRIER_A, principal: PERSON } as CallContext;
    expect(() => enterSend(forged, BUS_CONTEXT, CARRIER_A, SUBJECT)).toThrow(InvalidCallContextError);
  });

  it('derives a context with the carrier as caller and principal from its implicit own context', () => {
    const sent = enterSend(implicitOwn(BUS_CONTEXT, CARRIER_A), BUS_CONTEXT, CARRIER_A, SUBJECT);
    expect(sent.caller).toEqual(CARRIER_A);
    expect(sent.principal).toEqual(CARRIER_A);
    expect(sent.attestedBy).toBeUndefined();
  });

  it('rejects the implicit own context of another carrier and reports nothing', () => {
    const foreign = implicitOwn(BUS_CONTEXT, CARRIER_B);
    trackOpenHandlerCall(CARRIER_A, () => {
      trackOpenHandlerCall(CARRIER_B, () => {
        expect(() => enterSend(foreign, BUS_CONTEXT, CARRIER_A, SUBJECT)).toThrow(ForeignOwnContextError);
      });
    });
    expect(getOwnCallReport()).toEqual([]);
  });

  it('rejects the own context of another carrier and reports nothing', () => {
    const foreign = own(BUS_CONTEXT, CARRIER_B, 'start');
    trackOpenHandlerCall(CARRIER_A, () => {
      trackOpenHandlerCall(CARRIER_B, () => {
        expect(() => enterSend(foreign, BUS_CONTEXT, CARRIER_A, SUBJECT)).toThrow(ForeignOwnContextError);
      });
    });
    expect(getOwnCallReport()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Own-context report
// ---------------------------------------------------------------------------

describe('enterSend own-context report', () => {
  it('records one entry for a reportable own context sent during an open handler call', () => {
    trackOpenHandlerCall(CARRIER_A, () => {
      enterSend(own(BUS_CONTEXT, CARRIER_A, 'start'), BUS_CONTEXT, CARRIER_A, SUBJECT);
    });
    const report = getOwnCallReport();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ carrier: CARRIER_A, purpose: 'start', subject: SUBJECT, occurrences: 1 });
  });

  it('records one purpose-less entry for an implicit own context sent during an open handler call', () => {
    trackOpenHandlerCall(CARRIER_A, () => {
      enterSend(implicitOwn(BUS_CONTEXT, CARRIER_A), BUS_CONTEXT, CARRIER_A, SUBJECT);
    });
    const report = getOwnCallReport();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ carrier: CARRIER_A, purpose: undefined, subject: SUBJECT, occurrences: 1 });
  });

  it('records nothing outside an open handler call', () => {
    enterSend(own(BUS_CONTEXT, CARRIER_A, 'start'), BUS_CONTEXT, CARRIER_A, SUBJECT);
    expect(getOwnCallReport()).toEqual([]);
  });

  it('records nothing for a concurrent purpose', () => {
    trackOpenHandlerCall(CARRIER_A, () => {
      enterSend(own(BUS_CONTEXT, CARRIER_A, 'observer'), BUS_CONTEXT, CARRIER_A, SUBJECT);
    });
    expect(getOwnCallReport()).toEqual([]);
  });

  it('records nothing for a received context', () => {
    trackOpenHandlerCall(CARRIER_A, () => {
      enterSend(receivedContext(), BUS_CONTEXT, CARRIER_A, SUBJECT);
    });
    expect(getOwnCallReport()).toEqual([]);
  });
});
