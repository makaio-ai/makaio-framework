import { describe, it, expect } from 'vitest';
import { matchesSubscription, matchesAnySubscription } from '../subscription-matching.js';

describe('matchesSubscription', () => {
  describe('Exact matches', () => {
    it('should match identical subjects exactly', () => {
      expect(matchesSubscription('adapter.log', 'adapter.log')).toBe(true);
      expect(matchesSubscription('agent.started', 'agent.started')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode:sdk.thinking')).toBe(true);
    });

    it('should not match different subjects', () => {
      expect(matchesSubscription('adapter.log', 'adapter.error')).toBe(false);
      expect(matchesSubscription('adapter.log', 'agent.log')).toBe(false);
      expect(matchesSubscription('adapter:claudeCode.initialized', 'adapter:claudeCode.configured')).toBe(false);
    });

    it('should not match partial subjects without wildcard', () => {
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter')).toBe(false);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode')).toBe(false);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode:sdk')).toBe(false);
    });

    it('should handle single-word subjects', () => {
      expect(matchesSubscription('ping', 'ping')).toBe(true);
      expect(matchesSubscription('ping', 'pong')).toBe(false);
    });
  });

  describe('Wildcard matches', () => {
    it('should match subjects with correct prefix at any depth', () => {
      const subject = 'adapter:claudeCode:sdk.thinking';

      expect(matchesSubscription(subject, 'adapter:*')).toBe(true);
      expect(matchesSubscription(subject, 'adapter:claudeCode:*')).toBe(true);
      expect(matchesSubscription(subject, 'adapter:claudeCode:sdk.*')).toBe(true);
    });

    it('should not match subjects with wrong prefix', () => {
      expect(matchesSubscription('adapter.log', 'agent.*')).toBe(false);
      expect(matchesSubscription('session.started', 'adapter.*')).toBe(false);
      expect(matchesSubscription('adapter:claudeCode.initialized', 'adapter:gemini.*')).toBe(false);
    });

    it('should require dot after prefix (no partial prefix matching)', () => {
      // This is the key edge case from the proposal
      expect(matchesSubscription('adapter', 'adapter.*')).toBe(false);
      expect(matchesSubscription('adapterLog', 'adapter.*')).toBe(false);
      expect(matchesSubscription('agent', 'agent.*')).toBe(false);
    });

    it('should match single-level wildcards', () => {
      expect(matchesSubscription('adapter.log', 'adapter.*')).toBe(true);
      expect(matchesSubscription('agent.started', 'agent.*')).toBe(true);
    });

    it('should match multi-level wildcards', () => {
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk:message.delta', 'adapter:*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk:message.delta', 'adapter:claudeCode:*')).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty strings', () => {
      expect(matchesSubscription('', '')).toBe(true);
      expect(matchesSubscription('adapter.log', '')).toBe(false);
      expect(matchesSubscription('', 'adapter.*')).toBe(false);
    });

    it('should match bare global wildcard against any subject', () => {
      expect(matchesSubscription('adapter.log', '*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', '*')).toBe(true);
      expect(matchesSubscription('ping', '*')).toBe(true);
      expect(matchesSubscription('', '*')).toBe(true);
    });

    it('should handle patterns that are just subject wildcard', () => {
      // Edge case: pattern is just '.*'
      expect(matchesSubscription('adapter.log', '.*')).toBe(false);
      expect(matchesSubscription('.log', '.*')).toBe(true);
    });

    it('should not match subject without dots against wildcard', () => {
      expect(matchesSubscription('adapter', 'adapter.*')).toBe(false);
      expect(matchesSubscription('simple', 'simple.*')).toBe(false);
    });

    it('should handle dots at various positions', () => {
      expect(matchesSubscription('a:b:c:d.e', 'a:*')).toBe(true);
      expect(matchesSubscription('a:b:c:d.e', 'a:b:*')).toBe(true);
      expect(matchesSubscription('a:b:c:d.e', 'a:b:c:*')).toBe(true);
      expect(matchesSubscription('a:b:c:d.e', 'a:b:c:d.*')).toBe(true);
    });

    it('should not match if prefix has more segments than subject', () => {
      expect(matchesSubscription('adapter.log', 'adapter:log:extra.*')).toBe(false);
      expect(matchesSubscription('adapter', 'adapter.log.*')).toBe(false);
    });

    it('should handle similar but different prefixes', () => {
      expect(matchesSubscription('adapter.log', 'adapt.*')).toBe(false);
      expect(matchesSubscription('adapter.log', 'adapters.*')).toBe(false);
      expect(matchesSubscription('adapterLog.test', 'adapter.*')).toBe(false);
    });
  });

  describe('Real-world scenarios from proposal', () => {
    it('should match all examples from proposal', () => {
      // From proposal lines 333-351
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode:*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode:sdk.*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode:sdk.thinking')).toBe(true);
      expect(matchesSubscription('adapter.log', 'agent.*')).toBe(false);
      expect(matchesSubscription('adapter', 'adapter.*')).toBe(false);
    });

    it('should support multi-tenant isolation', () => {
      // From proposal: multi-tenant scenario
      expect(matchesSubscription('adapter:tenant123.log', 'adapter:tenant123.*')).toBe(true);
      expect(matchesSubscription('adapter:tenant123.log', 'adapter:tenant456.*')).toBe(false);
      expect(matchesSubscription('adapter:tenant123.initialized', 'adapter:tenant123.*')).toBe(true);
    });

    it('should support plugin ecosystem patterns', () => {
      // From proposal: plugin ecosystem
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode:sdk.*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.message', 'adapter:claudeCode:sdk.*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.toolUse', 'adapter:claudeCode:sdk.*')).toBe(true);

      // Different adapter
      expect(matchesSubscription('adapter:gemini:sdk.thinking', 'adapter:gemini:sdk.*')).toBe(true);
      expect(matchesSubscription('adapter:gemini:sdk.thinking', 'adapter:claudeCode:sdk.*')).toBe(false);
    });
  });

  describe('Namespace wildcard matches (:*)', () => {
    it('should match child namespaces with :* pattern', () => {
      expect(matchesSubscription('adapter:claudeCode.initialized', 'adapter:*')).toBe(true);
      expect(matchesSubscription('adapter:gpt.initialized', 'adapter:*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:*')).toBe(true);
    });

    it('should match multi-level namespace wildcards', () => {
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode:*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.message', 'adapter:claudeCode:*')).toBe(true);
    });

    it('should not match different namespace branches', () => {
      expect(matchesSubscription('adapter:gpt.initialized', 'adapter:claudeCode:*')).toBe(false);
      expect(matchesSubscription('adapter.log', 'adapter:*')).toBe(false);
      expect(matchesSubscription('agent:worker.started', 'adapter:*')).toBe(false);
    });

    it('should distinguish between subject wildcard (.*) and namespace wildcard (:*)', () => {
      // Subject wildcard should NOT match across namespace boundaries
      expect(matchesSubscription('adapter:claudeCode.log', 'adapter.*')).toBe(false);

      // Namespace wildcard SHOULD match child namespaces
      expect(matchesSubscription('adapter:claudeCode.log', 'adapter:*')).toBe(true);

      // Subject wildcard SHOULD match within same namespace
      expect(matchesSubscription('adapter:claudeCode.log', 'adapter:claudeCode.*')).toBe(true);
      expect(matchesSubscription('adapter.log', 'adapter.*')).toBe(true);
    });

    it('should require colon after namespace prefix', () => {
      expect(matchesSubscription('adapter', 'adapter:*')).toBe(false);
      expect(matchesSubscription('adapterClaudeCode', 'adapter:*')).toBe(false);
    });
  });

  // Assert result stability; shared-runner wall time cannot establish algorithmic complexity.
  it('preserves wildcard boundaries across repeated calls', () => {
    for (let i = 0; i < 10; i++) {
      expect(matchesSubscription('adapter.log', 'adapter.*')).toBe(true);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter.*')).toBe(false);
      expect(matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:*')).toBe(true);
      expect(matchesSubscription('adapter.log', 'adapter:*')).toBe(false);
    }
  });
});

describe('matchesAnySubscription', () => {
  describe('Array patterns', () => {
    it('should match if any pattern matches', () => {
      expect(matchesAnySubscription('adapter.log', ['adapter.*', 'agent.*'])).toBe(true);
      expect(matchesAnySubscription('agent.started', ['adapter.*', 'agent.*'])).toBe(true);
      expect(matchesAnySubscription('session.created', ['adapter.*', 'agent.*'])).toBe(false);
    });

    it('should return false for empty pattern array', () => {
      expect(matchesAnySubscription('adapter.log', [])).toBe(false);
    });

    it('should match exact patterns in collection', () => {
      expect(matchesAnySubscription('adapter.log', ['adapter.log', 'adapter.error'])).toBe(true);
      expect(matchesAnySubscription('adapter.warn', ['adapter.log', 'adapter.error'])).toBe(false);
    });

    it('should support mixed exact and wildcard patterns', () => {
      const patterns = ['adapter.log', 'agent.*', 'session.started'];

      expect(matchesAnySubscription('adapter.log', patterns)).toBe(true); // exact
      expect(matchesAnySubscription('agent.started', patterns)).toBe(true); // wildcard
      expect(matchesAnySubscription('session.started', patterns)).toBe(true); // exact
      expect(matchesAnySubscription('adapter.error', patterns)).toBe(false);
    });
  });

  describe('Set patterns', () => {
    it('should work with Set collections', () => {
      const patterns = new Set(['adapter.*', 'agent.*']);

      expect(matchesAnySubscription('adapter.log', patterns)).toBe(true);
      expect(matchesAnySubscription('agent.started', patterns)).toBe(true);
      expect(matchesAnySubscription('session.created', patterns)).toBe(false);
    });

    it('should return false for empty Set', () => {
      expect(matchesAnySubscription('adapter.log', new Set())).toBe(false);
    });
  });

  describe('Custom iterables', () => {
    it('should work with any iterable', () => {
      // Custom iterable using generator
      /**
       *
       */
      function* patternGenerator() {
        yield 'adapter.*';
        yield 'agent.*';
      }

      expect(matchesAnySubscription('adapter.log', patternGenerator())).toBe(true);
      expect(matchesAnySubscription('session.created', patternGenerator())).toBe(false);
    });

    it('should work with Map.values()', () => {
      const patternMap = new Map([
        ['key1', 'adapter.*'],
        ['key2', 'agent.*'],
      ]);

      expect(matchesAnySubscription('adapter.log', patternMap.values())).toBe(true);
      expect(matchesAnySubscription('session.created', patternMap.values())).toBe(false);
    });
  });

  describe('Short-circuit evaluation', () => {
    it('should stop checking after first match', () => {
      let checksPerformed = 0;

      /**
       *
       */
      function* countingPatterns() {
        yield (checksPerformed++, 'adapter.*'); // Should match and stop
        yield (checksPerformed++, 'agent.*'); // Should not be evaluated
        yield (checksPerformed++, 'session.*'); // Should not be evaluated
      }

      const result = matchesAnySubscription('adapter.log', countingPatterns());

      expect(result).toBe(true);
      expect(checksPerformed).toBe(1); // Only first pattern was evaluated
    });
  });

  describe('Real-world usage patterns', () => {
    it('should support transport subscription filtering', () => {
      // Simulate a transport with client subscriptions
      const clientSubscriptions = new Set(['adapter:tenant123.*', 'agent.started', 'agent.complete']);

      expect(matchesAnySubscription('adapter:tenant123.log', clientSubscriptions)).toBe(true);
      expect(matchesAnySubscription('agent.started', clientSubscriptions)).toBe(true);
      expect(matchesAnySubscription('adapter:tenant456.log', clientSubscriptions)).toBe(false);
      expect(matchesAnySubscription('session.created', clientSubscriptions)).toBe(false);
    });

    it('should support plugin interest declarations', () => {
      // Plugin declares interests
      const pluginInterests = [
        'adapter:claudeCode.*', // Direct subjects in adapter:claudeCode namespace
        'adapter:claudeCode:*', // Child namespaces of adapter:claudeCode (e.g., sdk)
        'agent.started', // Agent lifecycle
        'agent.complete',
      ];

      expect(matchesAnySubscription('adapter:claudeCode:sdk.thinking', pluginInterests)).toBe(true);
      expect(matchesAnySubscription('adapter:claudeCode.initialized', pluginInterests)).toBe(true);
      expect(matchesAnySubscription('adapter:gemini.initialized', pluginInterests)).toBe(false);
      expect(matchesAnySubscription('agent.started', pluginInterests)).toBe(true);
    });

    it('should support namespace wildcard patterns', () => {
      const patterns = new Set(['adapter:*', 'agent.started']);

      expect(matchesAnySubscription('adapter:claudeCode.initialized', patterns)).toBe(true);
      expect(matchesAnySubscription('adapter:claudeCode:sdk.thinking', patterns)).toBe(true);
      expect(matchesAnySubscription('adapter:gpt.initialized', patterns)).toBe(true);
      expect(matchesAnySubscription('agent.started', patterns)).toBe(true);
      expect(matchesAnySubscription('adapter.log', patterns)).toBe(false);
      expect(matchesAnySubscription('session.started', patterns)).toBe(false);
    });

    it('should support mixed subject and namespace wildcards', () => {
      const patterns = new Set([
        'adapter:*', // All child namespaces of adapter
        'agent.*', // All subjects in agent namespace
        'session.started', // Exact match
      ]);

      expect(matchesAnySubscription('adapter:claudeCode.log', patterns)).toBe(true);
      expect(matchesAnySubscription('agent.started', patterns)).toBe(true);
      expect(matchesAnySubscription('agent.completed', patterns)).toBe(true);
      expect(matchesAnySubscription('session.started', patterns)).toBe(true);
      expect(matchesAnySubscription('session.ended', patterns)).toBe(false);
      expect(matchesAnySubscription('adapter.log', patterns)).toBe(false);
    });
  });
});
