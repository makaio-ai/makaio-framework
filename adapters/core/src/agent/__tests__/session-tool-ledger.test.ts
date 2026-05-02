import { beforeEach, describe, expect, it } from 'vitest';
import { SessionToolLedger } from '../session-tool-ledger.js';
import type { LedgerSessionContext } from '../session-tool-ledger.js';
import type { ToolListItem, McpToolState } from '@makaio/contracts';

// ============================================================================
// Test fixtures
// ============================================================================

/**
 * Build a minimal ToolListItem for injection tests.
 * @param name - Full namespaced tool name, e.g. "github__create_issue"
 * @param toolsetName - Server name, e.g. "github"
 */
function makeToolListItem(name: string, toolsetName = 'server'): ToolListItem {
  return {
    name,
    description: `Description for ${name}`,
    toolsetName,
    inputSchema: { type: 'object', properties: {} },
  };
}

/**
 * Build a minimal McpToolState for session context tests.
 * @param fullName - Full namespaced tool name, e.g. "github__create_issue"
 */
function makeMcpToolState(fullName: string): McpToolState {
  const separatorIndex = fullName.indexOf('__');
  const serverName = separatorIndex >= 0 ? fullName.slice(0, separatorIndex) : '';
  const originalName = separatorIndex >= 0 ? fullName.slice(separatorIndex + 2) : fullName;
  return {
    fullName,
    originalName,
    serverName,
    description: `Description for ${fullName}`,
    inputSchema: { type: 'object', properties: {} },
    exposureMode: 'direct',
    enabled: true,
    exposed: true,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SessionToolLedger', () => {
  let ledger: SessionToolLedger;

  beforeEach(() => {
    ledger = new SessionToolLedger();
  });

  // --------------------------------------------------------------------------
  // recordInjection
  // --------------------------------------------------------------------------

  describe('recordInjection', () => {
    it('seeds entries for newly-injected tools', () => {
      const tools = [
        makeToolListItem('github__create_issue', 'github'),
        makeToolListItem('github__list_repos', 'github'),
      ];

      ledger.recordInjection(tools, 1);

      const entries = ledger.getAllEntries();
      expect(entries).toHaveLength(2);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry).toBeDefined();
      expect(entry?.injected).toBe(true);
      expect(entry?.lastInjectedAtTurn).toBe(1);
      expect(entry?.serverName).toBe('github');
      expect(entry?.originalName).toBe('create_issue');
    });

    it('updates existing entries on subsequent injections', () => {
      const tool = makeToolListItem('github__create_issue', 'github');

      ledger.recordInjection([tool], 1);
      ledger.recordInjection([tool], 5);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry?.injected).toBe(true);
      expect(entry?.lastInjectedAtTurn).toBe(5);
    });

    it('clears injected flag for tools absent from the new set (eviction sweep)', () => {
      const toolA = makeToolListItem('github__create_issue', 'github');
      const toolB = makeToolListItem('github__list_repos', 'github');

      ledger.recordInjection([toolA, toolB], 1);

      // Inject only toolA on turn 2 — toolB should be evicted.
      ledger.recordInjection([toolA], 2);

      expect(ledger.getEntry('github__create_issue')?.injected).toBe(true);
      expect(ledger.getEntry('github__list_repos')?.injected).toBe(false);
    });

    it('preserves other fields when evicting an entry', () => {
      const toolA = makeToolListItem('github__create_issue', 'github');

      ledger.recordInjection([toolA], 1);
      ledger.recordDiscovery('github__create_issue', 2);
      ledger.recordCall('github__create_issue', 3);

      // Evict toolA.
      ledger.recordInjection([], 4);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry?.injected).toBe(false);
      // Other fields should remain intact.
      expect(entry?.callCount).toBe(1);
      expect(entry?.discovered).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // recordDiscovery
  // --------------------------------------------------------------------------

  describe('recordDiscovery', () => {
    it('creates an entry and marks it discovered', () => {
      ledger.recordDiscovery('github__create_issue', 3);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry).toBeDefined();
      expect(entry?.discovered).toBe(true);
      expect(entry?.firstDiscoveredAtTurn).toBe(3);
    });

    it('applies first-discovery semantics: does not overwrite firstDiscoveredAtTurn', () => {
      ledger.recordDiscovery('github__create_issue', 3);
      ledger.recordDiscovery('github__create_issue', 7);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry?.firstDiscoveredAtTurn).toBe(3);
    });

    it('is idempotent: discovered remains true on repeated calls', () => {
      ledger.recordDiscovery('github__create_issue', 3);
      ledger.recordDiscovery('github__create_issue', 3);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry?.discovered).toBe(true);
      expect(entry?.firstDiscoveredAtTurn).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // recordCall
  // --------------------------------------------------------------------------

  describe('recordCall', () => {
    it('increments call count on each invocation', () => {
      ledger.recordCall('github__create_issue', 2);
      ledger.recordCall('github__create_issue', 4);

      expect(ledger.getCallCount('github__create_issue')).toBe(2);
    });

    it('updates lastCalledAtTurn on each invocation', () => {
      ledger.recordCall('github__create_issue', 2);
      ledger.recordCall('github__create_issue', 4);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry?.lastCalledAtTurn).toBe(4);
    });

    it('implies discovery: sets discovered and firstDiscoveredAtTurn', () => {
      ledger.recordCall('github__create_issue', 2);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry?.discovered).toBe(true);
      expect(entry?.firstDiscoveredAtTurn).toBe(2);
    });

    it('does not overwrite firstDiscoveredAtTurn when already set by prior discovery', () => {
      ledger.recordDiscovery('github__create_issue', 1);
      ledger.recordCall('github__create_issue', 5);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry?.firstDiscoveredAtTurn).toBe(1);
    });

    it('does not overwrite firstDiscoveredAtTurn set by a prior recordCall', () => {
      ledger.recordCall('github__create_issue', 2);
      ledger.recordCall('github__create_issue', 5);

      const entry = ledger.getEntry('github__create_issue');
      expect(entry?.firstDiscoveredAtTurn).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // getInjectedTools
  // --------------------------------------------------------------------------

  describe('getInjectedTools', () => {
    it('returns only tools currently marked as injected', () => {
      const toolA = makeToolListItem('github__create_issue', 'github');
      const toolB = makeToolListItem('github__list_repos', 'github');

      ledger.recordInjection([toolA, toolB], 1);
      // Evict toolB.
      ledger.recordInjection([toolA], 2);

      const injected = ledger.getInjectedTools();
      expect(injected).toHaveLength(1);
      expect(injected[0]?.fullName).toBe('github__create_issue');
    });

    it('returns empty array when no tools are injected', () => {
      expect(ledger.getInjectedTools()).toHaveLength(0);
    });

    it('returns empty array after all tools are evicted', () => {
      const toolA = makeToolListItem('github__create_issue', 'github');
      ledger.recordInjection([toolA], 1);
      ledger.recordInjection([], 2);

      expect(ledger.getInjectedTools()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases: unknown tool lookups
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('getEntry returns undefined for unknown tools', () => {
      expect(ledger.getEntry('nonexistent__tool')).toBeUndefined();
    });

    it('getCallCount returns 0 for unknown tools', () => {
      expect(ledger.getCallCount('nonexistent__tool')).toBe(0);
    });

    it('getAllEntries returns empty array when ledger is empty', () => {
      expect(ledger.getAllEntries()).toHaveLength(0);
    });

    it('parses fullName with no separator gracefully', () => {
      ledger.recordDiscovery('toolwithnoseparator', 1);
      const entry = ledger.getEntry('toolwithnoseparator');
      expect(entry?.serverName).toBe('');
      expect(entry?.originalName).toBe('toolwithnoseparator');
    });
  });

  // --------------------------------------------------------------------------
  // suggestInjectionSet (Phase 1 pass-through)
  // --------------------------------------------------------------------------

  describe('suggestInjectionSet', () => {
    it('returns directTools mapped to ToolListItem format', async () => {
      const context: LedgerSessionContext = {
        directTools: [makeMcpToolState('github__create_issue'), makeMcpToolState('github__list_repos')],
        discoverableTools: [makeMcpToolState('github__delete_repo')],
      };

      const result = await ledger.suggestInjectionSet(context, 1);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        name: 'github__create_issue',
        toolsetName: 'github',
      });
      expect(result[1]).toMatchObject({
        name: 'github__list_repos',
        toolsetName: 'github',
      });
    });

    it('does not include discoverableTools in the suggestion', async () => {
      const context: LedgerSessionContext = {
        directTools: [makeMcpToolState('github__create_issue')],
        discoverableTools: [makeMcpToolState('github__delete_repo')],
      };

      const result = await ledger.suggestInjectionSet(context, 1);

      const names = result.map((t) => t.name);
      expect(names).not.toContain('github__delete_repo');
    });

    it('uses empty string for description when McpToolState.description is absent', async () => {
      const toolWithNoDescription: McpToolState = {
        ...makeMcpToolState('github__create_issue'),
        description: undefined,
      };
      const context: LedgerSessionContext = {
        directTools: [toolWithNoDescription],
        discoverableTools: [],
      };

      const result = await ledger.suggestInjectionSet(context, 1);

      expect(result[0]?.description).toBe('');
    });

    it('returns empty array when directTools is empty', async () => {
      const context: LedgerSessionContext = {
        directTools: [],
        discoverableTools: [makeMcpToolState('github__delete_repo')],
      };

      const result = await ledger.suggestInjectionSet(context, 1);

      expect(result).toHaveLength(0);
    });
  });
});
