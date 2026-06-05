import { describe, expect, it } from 'vitest';
import type { TransportPeerContext } from '@makaio/core';
import { isPeerAuthorizedToDelegate, type SpawnDelegationAllowSet } from '../spawn-delegation.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Build a minimal authenticated peer context for tests.
 * @param kind - Peer kind
 * @param id - Peer identifier
 * @param authenticated - Whether the peer is authenticated (defaults to true)
 * @returns Minimal TransportPeerContext
 */
function makePeer(kind: string, id: string, authenticated = true): TransportPeerContext {
  return { kind, id, authenticated };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isPeerAuthorizedToDelegate', () => {
  it('returns false when the allow-set is empty for non-workflow peers', () => {
    const emptySet: SpawnDelegationAllowSet = new Set();
    expect(isPeerAuthorizedToDelegate(makePeer('machine', 'node-1'), emptySet)).toBe(false);
  });

  it('returns true for authenticated workflow execution peers without an explicit grant', () => {
    const emptySet: SpawnDelegationAllowSet = new Set();
    expect(isPeerAuthorizedToDelegate(makePeer('workflow-execution', 'exec-1'), emptySet)).toBe(true);
  });

  it('returns false when peer is undefined', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['workflow-execution:exec-1']);
    expect(isPeerAuthorizedToDelegate(undefined, allowSet)).toBe(false);
  });

  it('returns false when peer has no id', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['workflow-execution:']);
    const peer: TransportPeerContext = { kind: 'workflow-execution', authenticated: true };
    expect(isPeerAuthorizedToDelegate(peer, allowSet)).toBe(false);
  });

  it('returns false when peer is not authenticated', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['workflow-execution:exec-1']);
    expect(isPeerAuthorizedToDelegate(makePeer('workflow-execution', 'exec-1', false), allowSet)).toBe(false);
  });

  it('returns false when peer has no authenticated field', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['workflow-execution:exec-1']);
    const peer: TransportPeerContext = { kind: 'workflow-execution', id: 'exec-1' };
    expect(isPeerAuthorizedToDelegate(peer, allowSet)).toBe(false);
  });

  it('returns false when peer kind does not match any entry', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['workflow-execution:exec-1']);
    expect(isPeerAuthorizedToDelegate(makePeer('browser', 'exec-1'), allowSet)).toBe(false);
  });

  it('returns false when non-workflow peer id does not match any entry', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['machine:node-1']);
    expect(isPeerAuthorizedToDelegate(makePeer('machine', 'node-2'), allowSet)).toBe(false);
  });

  it('returns true when non-workflow peer kind and id both match an entry', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['machine:node-1']);
    expect(isPeerAuthorizedToDelegate(makePeer('machine', 'node-1'), allowSet)).toBe(true);
  });

  it('returns true for the correct entry among multiple entries', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['machine:node-1', 'machine:node-2', 'machine:node-3']);
    expect(isPeerAuthorizedToDelegate(makePeer('machine', 'node-2'), allowSet)).toBe(true);
  });
});
