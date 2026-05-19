import { describe, it, expect } from 'bun:test';
import { parseAIAdapterCapabilities } from '@makaio/ai-adapters-core';
import type { AIAdapterCapabilities } from '@makaio/ai-adapters-core';

const chatCapabilityProperty = `chat${'InTurnMessages'}`;

describe('parseAIAdapterCapabilities', () => {
  describe('basic parsing', () => {
    it('should return object with all false properties when given empty array', () => {
      const caps = parseAIAdapterCapabilities([]);

      expect(caps.tools).toBeUndefined();
      expect(caps.vision).toBeUndefined();
      expect(caps.systemPrompt).toBeUndefined();
      expect(caps.systemPromptOverride).toBeUndefined();
      expect(caps.session).toBeUndefined();
      expect(caps.sessionResume).toBeUndefined();
    });

    it('should parse simple capabilities without nesting', () => {
      const caps = parseAIAdapterCapabilities(['tools', 'streaming', 'vision']);

      expect(caps.tools).toBe(true);
      expect(caps.streaming).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.systemPrompt).toBeUndefined();
      expect(caps.session).toBeUndefined();
    });

    it('should parse parent capability as single property', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt']);

      expect(caps.systemPrompt).toBe(true);
      expect(caps.systemPromptOverride).toBeUndefined();
      expect(caps.systemPromptAppend).toBeUndefined();
    });
  });

  describe('nested capabilities', () => {
    it('should parse nested capability with colon separator to camelCase', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt:override']);

      expect(caps.systemPromptOverride).toBe(true);
      expect(caps.systemPrompt).toBeUndefined();
    });

    it('should parse multiple nested capabilities from same parent', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt:override', 'systemPrompt:append']);

      expect(caps.systemPromptOverride).toBe(true);
      expect(caps.systemPromptAppend).toBe(true);
      expect(caps.systemPrompt).toBeUndefined();
    });

    it('should parse session nested capabilities', () => {
      const caps = parseAIAdapterCapabilities(['session:resume', 'session:fork']);

      expect(caps.sessionResume).toBe(true);
      expect(caps.sessionFork).toBe(true);
      expect(caps.session).toBeUndefined();
    });

    it('should handle both parent and nested capabilities together', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt', 'systemPrompt:override']);

      expect(caps.systemPrompt).toBe(true);
      expect(caps.systemPromptOverride).toBe(true);
    });
  });

  describe('mixed capabilities', () => {
    it('should parse mixed simple and nested capabilities', () => {
      const caps = parseAIAdapterCapabilities(['tools', 'vision', 'systemPrompt:override', 'session:resume']);

      expect(caps.tools).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.systemPromptOverride).toBe(true);
      expect(caps.sessionResume).toBe(true);
      expect(caps.systemPrompt).toBeUndefined();
      expect(caps.session).toBeUndefined();
    });

    it('should parse all registry capabilities', () => {
      const caps = parseAIAdapterCapabilities([
        'tools',
        'streaming',
        'vision',
        'systemPrompt',
        'systemPrompt:override',
        'systemPrompt:append',
        'session',
        'session:resume',
        'session:fork',
        'chat:inTurnMessages',
      ]);

      expect(caps.tools).toBe(true);
      expect(caps.streaming).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.systemPrompt).toBe(true);
      expect(caps.systemPromptOverride).toBe(true);
      expect(caps.systemPromptAppend).toBe(true);
      expect(caps.session).toBe(true);
      expect(caps.sessionResume).toBe(true);
      expect(caps.sessionFork).toBe(true);
      expect(caps).toHaveProperty(chatCapabilityProperty, true);
    });
  });

  describe('edge cases', () => {
    it('should handle duplicate capabilities', () => {
      const caps = parseAIAdapterCapabilities(['tools', 'tools', 'vision']);

      expect(caps.tools).toBe(true);
      expect(caps.vision).toBe(true);
    });

    it('should handle duplicate nested capabilities', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt:override', 'systemPrompt:override']);

      expect(caps.systemPromptOverride).toBe(true);
    });

    it('should preserve case sensitivity in camelCase conversion', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt:override']);

      // Verify camelCase conversion: 'systemPrompt:override' -> 'systemPromptOverride'
      expect(caps.systemPromptOverride).toBe(true);
      expect('systemPromptoverride' in caps).toBe(false);
    });
  });
});

describe('AIAdapterCapabilities methods', () => {
  describe('hasAll()', () => {
    it('should return true when all capabilities are present', () => {
      const caps = parseAIAdapterCapabilities(['tools', 'vision']);

      expect(caps.hasAll(['tools', 'vision'])).toBe(true);
    });

    it('should return false when any capability is missing', () => {
      const caps = parseAIAdapterCapabilities(['tools']);

      expect(caps.hasAll(['tools', 'vision'])).toBe(false);
    });

    it('should return true for empty array', () => {
      const caps = parseAIAdapterCapabilities(['tools']);

      expect(caps.hasAll([])).toBe(true);
    });

    it('should work with nested capabilities', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt:override', 'session:resume']);

      expect(caps.hasAll(['systemPrompt:override', 'session:resume'])).toBe(true);
    });

    it('should return false when nested capability is missing', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt:override']);

      expect(caps.hasAll(['systemPrompt:override', 'systemPrompt:append'])).toBe(false);
    });

    it('should distinguish between parent and nested capabilities', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt']);

      expect(caps.hasAll(['systemPrompt'])).toBe(true);
      expect(caps.hasAll(['systemPrompt:override'])).toBe(false);
    });

    it('should handle mixed simple and nested in query', () => {
      const caps = parseAIAdapterCapabilities(['tools', 'systemPrompt:override']);

      expect(caps.hasAll(['tools', 'systemPrompt:override'])).toBe(true);
      expect(caps.hasAll(['tools', 'systemPrompt:append'])).toBe(false);
    });
  });

  describe('hasAny()', () => {
    it('should return true when any capability is present', () => {
      const caps = parseAIAdapterCapabilities(['tools']);

      expect(caps.hasAny(['tools', 'vision'])).toBe(true);
    });

    it('should return false when no capabilities are present', () => {
      const caps = parseAIAdapterCapabilities(['tools']);

      expect(caps.hasAny(['vision', 'systemPrompt:override'])).toBe(false);
    });

    it('should return false for empty array', () => {
      const caps = parseAIAdapterCapabilities(['tools']);

      expect(caps.hasAny([])).toBe(false);
    });

    it('should work with nested capabilities', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt:override']);

      expect(caps.hasAny(['systemPrompt:override', 'systemPrompt:append'])).toBe(true);
    });

    it('should return true if any nested capability matches', () => {
      const caps = parseAIAdapterCapabilities(['session:resume']);

      expect(caps.hasAny(['session:resume', 'session:fork'])).toBe(true);
      expect(caps.hasAny(['session:fork', 'systemPrompt:override'])).toBe(false);
    });

    it('should handle mixed simple and nested in query', () => {
      const caps = parseAIAdapterCapabilities(['tools']);

      expect(caps.hasAny(['tools', 'systemPrompt:override'])).toBe(true);
      expect(caps.hasAny(['vision', 'systemPrompt:override'])).toBe(false);
    });

    it('should distinguish between parent and nested capabilities', () => {
      const caps = parseAIAdapterCapabilities(['systemPrompt']);

      expect(caps.hasAny(['systemPrompt'])).toBe(true);
      expect(caps.hasAny(['systemPrompt:override'])).toBe(false);
    });
  });
});

describe('AIAdapterCapabilities type safety', () => {
  it('should provide type-safe access to capability properties', () => {
    const caps: AIAdapterCapabilities = parseAIAdapterCapabilities([
      'tools',
      'streaming',
      'vision',
      'systemPrompt:override',
      'session:resume',
    ]);

    // These should all be type-safe and not require type assertions
    const tools: boolean | undefined = caps.tools;
    const streaming: boolean | undefined = caps.streaming;
    const vision: boolean | undefined = caps.vision;
    const systemPromptOverride: boolean | undefined = caps.systemPromptOverride;
    const sessionResume: boolean | undefined = caps.sessionResume;

    expect(tools).toBe(true);
    expect(streaming).toBe(true);
    expect(vision).toBe(true);
    expect(systemPromptOverride).toBe(true);
    expect(sessionResume).toBe(true);
  });

  it('should provide type-safe method signatures', () => {
    const caps: AIAdapterCapabilities = parseAIAdapterCapabilities(['tools']);

    // These method calls should be type-safe
    const allPresent: boolean = caps.hasAll(['tools']);
    const anyPresent: boolean = caps.hasAny(['tools', 'vision']);

    expect(allPresent).toBe(true);
    expect(anyPresent).toBe(true);
  });
});

describe('integration scenarios', () => {
  it('should handle typical adapter capability declaration', () => {
    // Simulate a typical LLM adapter that supports tools and vision
    const caps = parseAIAdapterCapabilities(['tools', 'vision']);

    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(true);

    // Common usage patterns
    if (caps.tools && caps.vision) {
      expect(true).toBe(true); // Both present
    }

    if (caps.hasAll(['tools', 'vision'])) {
      expect(true).toBe(true); // Batch check
    }
  });

  it('should handle adapter with session management', () => {
    // Simulate adapter that can resume but not fork sessions
    const caps = parseAIAdapterCapabilities(['tools', 'session:resume', 'systemPrompt:override']);

    expect(caps.tools).toBe(true);
    expect(caps.sessionResume).toBe(true);
    expect(caps.sessionFork).toBeUndefined();
    expect(caps.systemPromptOverride).toBe(true);

    // Check for any session capability
    expect(caps.hasAny(['session:resume', 'session:fork'])).toBe(true);
  });

  it('should handle minimal adapter with no optional features', () => {
    // Simulate a basic text-only adapter
    const caps = parseAIAdapterCapabilities([]);

    expect(caps.tools).toBeUndefined();
    expect(caps.vision).toBeUndefined();
    expect(caps.sessionResume).toBeUndefined();

    // Should safely handle checks
    if (caps.tools) {
      throw new Error('Should not enter this block');
    }

    expect(caps.hasAll([])).toBe(true);
    expect(caps.hasAny(['tools', 'vision'])).toBe(false);
  });

  it('should handle full-featured adapter', () => {
    // Simulate a full-featured adapter with all capabilities
    const caps = parseAIAdapterCapabilities([
      'tools',
      'vision',
      'systemPrompt:override',
      'systemPrompt:append',
      'session:resume',
      'session:fork',
      'chat:inTurnMessages',
    ]);

    expect(
      caps.hasAll([
        'tools',
        'vision',
        'systemPrompt:override',
        'systemPrompt:append',
        'session:resume',
        'session:fork',
        'chat:inTurnMessages',
      ]),
    ).toBe(true);

    // All properties should be accessible
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.systemPromptOverride).toBe(true);
    expect(caps.systemPromptAppend).toBe(true);
    expect(caps.sessionResume).toBe(true);
    expect(caps.sessionFork).toBe(true);
    expect(caps).toHaveProperty(chatCapabilityProperty, true);
  });
});
