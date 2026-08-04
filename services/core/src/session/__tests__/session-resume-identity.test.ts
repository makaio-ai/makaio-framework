import { describe, expect, it } from 'vitest';
import type { IMakaioSession, MakaioSessionAgent } from '@makaio/contracts';
import { resolveAgentResumeIdentity } from '../session-resume-identity.js';
import { createTestAgent, createTestSession } from './shared.js';

const SESSION_ID = 'session-resume-identity';

/**
 * A session row carrying the lead's confirmed currency.
 *
 * Deliberately distinct from every agent-owned ID below, so a branch that
 * wrongly consults the session row is visible in the assertion rather than
 * coincidentally correct.
 * @param overrides - Session fields under test (designation, import flag, currency)
 * @returns Session record for one resolution case
 */
function sessionWithLeadCurrency(overrides?: Partial<IMakaioSession>): IMakaioSession {
  return createTestSession(SESSION_ID, {
    adapterSessionId: 'session-origin',
    currentAdapterSessionId: 'session-lead-current',
    currentAdapterSessionIdState: 'confirmed',
    ...overrides,
  });
}

/**
 * An agent row whose currency the ownership seam has settled.
 * @param agentId - Agent identifier
 * @param currency - Settled currency fields; `currencyFence` defaults to a settled value
 * @returns Agent record for one resolution case
 */
function settledAgent(
  agentId: string,
  currency: Partial<
    Pick<
      MakaioSessionAgent,
      'adapterSessionId' | 'currentAdapterSessionId' | 'currentAdapterSessionIdState' | 'currencyFence'
    >
  >,
): MakaioSessionAgent {
  return createTestAgent(agentId, { sessionId: SESSION_ID, currencyFence: 1, ...currency });
}

describe('resolveAgentResumeIdentity', () => {
  it('resolves a settled member from its own confirmed currency, independent of the lead', () => {
    const session = sessionWithLeadCurrency({ leadAgentId: 'agent-lead' });
    const agent = settledAgent('agent-member', {
      adapterSessionId: 'member-origin',
      currentAdapterSessionId: 'member-current',
      currentAdapterSessionIdState: 'confirmed',
    });

    expect(resolveAgentResumeIdentity(session, agent)).toEqual({
      adapterSessionId: 'member-current',
      movedUnconfirmed: false,
    });
  });

  it('reports a settled member whose currency moved as unconfirmed', () => {
    // The session row is intact and confirmed; only the agent's own currency
    // says its provider conversation was abandoned.
    const session = sessionWithLeadCurrency({ leadAgentId: 'agent-lead' });
    const agent = settledAgent('agent-member', {
      adapterSessionId: 'member-origin',
      currentAdapterSessionIdState: 'moved',
    });

    expect(resolveAgentResumeIdentity(session, agent)).toEqual({
      adapterSessionId: undefined,
      movedUnconfirmed: true,
    });
  });

  it('resolves an unsettled agent the session names as lead from the session row', () => {
    // Legacy attribution: the pre-authority handler recorded the lead's
    // movement on the session row while this agent held the designation.
    const session = sessionWithLeadCurrency({ leadAgentId: 'agent-lead' });
    const agent = createTestAgent('agent-lead', { sessionId: SESSION_ID, adapterSessionId: 'lead-origin' });

    expect(resolveAgentResumeIdentity(session, agent)).toEqual({
      adapterSessionId: 'session-lead-current',
      movedUnconfirmed: false,
    });
  });

  it('resolves an unsettled agent of an imported session with no lead from the session row', () => {
    // An import carries provider identity that belongs to no agent in
    // particular, because the session never had a lead to attribute it to.
    const session = sessionWithLeadCurrency({ isImported: true });
    const agent = createTestAgent('agent-imported', { sessionId: SESSION_ID, adapterSessionId: 'agent-origin' });

    expect(resolveAgentResumeIdentity(session, agent)).toEqual({
      adapterSessionId: 'session-lead-current',
      movedUnconfirmed: false,
    });
  });

  it('resolves an unsettled agent of a non-imported session with no lead from its own origin', () => {
    // The blanket no-lead fallback is exactly what this branch removes: it
    // would hand this agent the departed lead's provider conversation.
    const session = sessionWithLeadCurrency();
    const agent = createTestAgent('agent-orphan', { sessionId: SESSION_ID, adapterSessionId: 'agent-origin' });

    expect(resolveAgentResumeIdentity(session, agent)).toEqual({
      adapterSessionId: 'agent-origin',
      movedUnconfirmed: false,
    });
  });

  it('resolves an unsettled agent that is not the named lead from its own origin', () => {
    const session = sessionWithLeadCurrency({ leadAgentId: 'agent-lead' });
    const agent = createTestAgent('agent-member', { sessionId: SESSION_ID, adapterSessionId: 'member-origin' });

    expect(resolveAgentResumeIdentity(session, agent)).toEqual({
      adapterSessionId: 'member-origin',
      movedUnconfirmed: false,
    });
  });

  it('treats a zero fence as unsettled, so a never-written agent row is not authoritative', () => {
    // `currencyFence: 0` is what the seam leaves on a row it has never written;
    // reading it as settled would make branch 1 swallow the legacy fallbacks.
    const session = sessionWithLeadCurrency({ leadAgentId: 'agent-lead' });
    const agent = createTestAgent('agent-lead', {
      sessionId: SESSION_ID,
      adapterSessionId: 'lead-origin',
      currencyFence: 0,
    });

    expect(resolveAgentResumeIdentity(session, agent)).toEqual({
      adapterSessionId: 'session-lead-current',
      movedUnconfirmed: false,
    });
  });
});
