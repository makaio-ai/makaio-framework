import { describe, expect, it } from 'vitest';
import { parsePersistedAgentSelection } from './persisted-agent-selection.js';

describe('parsePersistedAgentSelection', () => {
  describe('legacy migration', () => {
    it('trims persisted adapter identifiers before returning a selection', () => {
      expect(
        parsePersistedAgentSelection({
          kind: 'model',
          adapterName: ' claude-code ',
          model: ' sonnet ',
          providerConfigId: ' provider-123 ',
        }),
      ).toEqual({
        kind: 'adapter',
        adapterName: 'claude-code',
        model: 'sonnet',
        providerConfigId: 'provider-123',
      });
    });

    it('migrates legacy virtualModel kind to virtual-model with trimming', () => {
      expect(
        parsePersistedAgentSelection({
          kind: 'virtualModel',
          virtualModelId: ' vm-flash ',
        }),
      ).toEqual({ kind: 'virtual-model', virtualModelId: 'vm-flash' });
    });

    it('returns null for legacy model kind with blank adapterName', () => {
      expect(parsePersistedAgentSelection({ kind: 'model', adapterName: '  ', model: 'sonnet' })).toBeNull();
    });
  });

  describe('adapter kind', () => {
    it('trims adapterName, model, and providerConfigId', () => {
      expect(
        parsePersistedAgentSelection({
          kind: 'adapter',
          adapterName: ' anthropic-sdk ',
          model: ' claude-sonnet ',
          providerConfigId: ' cfg-1 ',
        }),
      ).toEqual({
        kind: 'adapter',
        adapterName: 'anthropic-sdk',
        model: 'claude-sonnet',
        providerConfigId: 'cfg-1',
      });
    });

    it('omits model and providerConfigId when absent', () => {
      expect(parsePersistedAgentSelection({ kind: 'adapter', adapterName: 'anthropic-sdk' })).toEqual({
        kind: 'adapter',
        adapterName: 'anthropic-sdk',
      });
    });

    it('returns null when adapterName is blank', () => {
      expect(parsePersistedAgentSelection({ kind: 'adapter', adapterName: '   ' })).toBeNull();
    });
  });

  describe('persona kind', () => {
    it('trims personaId', () => {
      expect(parsePersistedAgentSelection({ kind: 'persona', personaId: ' p-abc ' })).toEqual({
        kind: 'persona',
        personaId: 'p-abc',
      });
    });

    it('returns null when personaId is blank', () => {
      expect(parsePersistedAgentSelection({ kind: 'persona', personaId: '  ' })).toBeNull();
    });
  });

  describe('profile kind', () => {
    it('trims profileId', () => {
      expect(parsePersistedAgentSelection({ kind: 'profile', profileId: ' prof-1 ' })).toEqual({
        kind: 'profile',
        profileId: 'prof-1',
      });
    });

    it('returns null when profileId is blank', () => {
      expect(parsePersistedAgentSelection({ kind: 'profile', profileId: '' })).toBeNull();
    });
  });

  describe('virtual-model kind', () => {
    it('trims virtualModelId', () => {
      expect(parsePersistedAgentSelection({ kind: 'virtual-model', virtualModelId: ' vm-1 ' })).toEqual({
        kind: 'virtual-model',
        virtualModelId: 'vm-1',
      });
    });

    it('returns null when virtualModelId is blank', () => {
      expect(parsePersistedAgentSelection({ kind: 'virtual-model', virtualModelId: '  ' })).toBeNull();
    });
  });

  describe('unknown kinds', () => {
    it('returns null for unknown kind', () => {
      expect(parsePersistedAgentSelection({ kind: 'unknown-future-kind' })).toBeNull();
    });

    it('returns null for completely invalid input', () => {
      expect(parsePersistedAgentSelection(null)).toBeNull();
      expect(parsePersistedAgentSelection(42)).toBeNull();
      expect(parsePersistedAgentSelection({})).toBeNull();
    });
  });
});
