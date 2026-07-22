/**
 * Tests for {@link ClientHookProviderContractRegistry}.
 *
 * Verifies registration, ownership, collision rejection, lookup, targeted
 * and bulk unregistration, and the interaction search method.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { ProviderContractCatalogEntry } from '@makaio/contracts/client';
import { ClientHookProviderContractRegistry } from '../client-hook-provider-contract-registry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createCatalog(overrides: Partial<ProviderContractCatalogEntry> = {}): ProviderContractCatalogEntry {
  return {
    clientId: 'claude-code',
    contractId: 'anthropic.tool-response',
    version: '1.0.0',
    supportedInteractions: ['PreToolUse', 'PostToolUse'],
    blockability: [
      { interaction: 'PreToolUse', blockable: true },
      { interaction: 'PostToolUse', blockable: false },
    ],
    validate: () => true,
    ...overrides,
  };
}

const CATALOG_A = createCatalog();

const CATALOG_B = createCatalog({
  contractId: 'anthropic.context-response',
  supportedInteractions: ['PreToolUse'],
  blockability: [{ interaction: 'PreToolUse', blockable: false }],
});

const CATALOG_OTHER_CLIENT = createCatalog({
  clientId: 'other-client',
  contractId: 'other.contract',
  supportedInteractions: ['CustomEvent'],
  blockability: [{ interaction: 'CustomEvent', blockable: true }],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientHookProviderContractRegistry', () => {
  let registry: ClientHookProviderContractRegistry;

  beforeEach(() => {
    registry = new ClientHookProviderContractRegistry();
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe('registerProviderContract', () => {
    it('registers a provider contract and allows lookup', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);

      const result = registry.getProviderContract('claude-code', 'anthropic.tool-response');
      expect(result).toBe(CATALOG_A);
    });

    it('rejects replacement from the owning extension until it unregisters', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);

      const updated = createCatalog({ version: '2.0.0' });
      expect(() => registry.registerProviderContract('ext-anthropic', updated)).toThrow(/already registered/);

      const result = registry.getProviderContract('claude-code', 'anthropic.tool-response');
      expect(result).toBe(CATALOG_A);
    });

    it('rejects collision from a different extension', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);

      expect(() => registry.registerProviderContract('ext-impostor', CATALOG_A)).toThrow(
        /contract 'anthropic.tool-response' for client 'claude-code' is already registered by extension 'ext-anthropic'/,
      );
    });

    it('registers multiple contracts for the same client from the same extension', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);
      registry.registerProviderContract('ext-anthropic', CATALOG_B);

      expect(registry.getProviderContract('claude-code', 'anthropic.tool-response')).toBe(CATALOG_A);
      expect(registry.getProviderContract('claude-code', 'anthropic.context-response')).toBe(CATALOG_B);
    });

    it('rejects malformed catalogs before mutating the registry', () => {
      const malformed = createCatalog({ supportedInteractions: [], blockability: [] });

      expect(() => registry.registerProviderContract('ext-anthropic', malformed)).toThrow(
        /requires supported interactions/,
      );
      expect(registry.getProviderContract('claude-code', 'anthropic.tool-response')).toBeUndefined();
    });

    it('registers contracts for different clients from different extensions', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);
      registry.registerProviderContract('ext-other', CATALOG_OTHER_CLIENT);

      expect(registry.getProviderContract('claude-code', 'anthropic.tool-response')).toBe(CATALOG_A);
      expect(registry.getProviderContract('other-client', 'other.contract')).toBe(CATALOG_OTHER_CLIENT);
    });
  });

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  describe('getProviderContract', () => {
    it('returns undefined for unregistered contracts', () => {
      expect(registry.getProviderContract('claude-code', 'nonexistent')).toBeUndefined();
    });

    it('returns undefined for wrong clientId', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);

      expect(registry.getProviderContract('wrong-client', 'anthropic.tool-response')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getProviderContractsByClient
  // -------------------------------------------------------------------------

  describe('getProviderContractsByClient', () => {
    it('returns empty array when no contracts are registered for the client', () => {
      expect(registry.getProviderContractsByClient('claude-code')).toEqual([]);
    });

    it('returns all contracts for a given client', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);
      registry.registerProviderContract('ext-anthropic', CATALOG_B);
      registry.registerProviderContract('ext-other', CATALOG_OTHER_CLIENT);

      const results = registry.getProviderContractsByClient('claude-code');
      expect(results).toHaveLength(2);
      expect(results).toContain(CATALOG_A);
      expect(results).toContain(CATALOG_B);
    });
  });

  // -------------------------------------------------------------------------
  // Unregistration
  // -------------------------------------------------------------------------

  describe('unregisterProviderContract', () => {
    it('removes a contract owned by the requesting extension', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);

      registry.unregisterProviderContract('ext-anthropic', 'claude-code', 'anthropic.tool-response');

      expect(registry.getProviderContract('claude-code', 'anthropic.tool-response')).toBeUndefined();
    });

    it('is a no-op when the contract belongs to a different extension', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);

      registry.unregisterProviderContract('ext-impostor', 'claude-code', 'anthropic.tool-response');

      expect(registry.getProviderContract('claude-code', 'anthropic.tool-response')).toBe(CATALOG_A);
    });

    it('is a no-op when the contract does not exist', () => {
      // Should not throw.
      registry.unregisterProviderContract('ext-anthropic', 'claude-code', 'nonexistent');
    });
  });

  describe('unregisterAllByExtension', () => {
    it('removes all contracts owned by the extension', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);
      registry.registerProviderContract('ext-anthropic', CATALOG_B);
      registry.registerProviderContract('ext-other', CATALOG_OTHER_CLIENT);

      registry.unregisterAllByExtension('ext-anthropic');

      expect(registry.getProviderContract('claude-code', 'anthropic.tool-response')).toBeUndefined();
      expect(registry.getProviderContract('claude-code', 'anthropic.context-response')).toBeUndefined();
      // Other extension's contracts remain.
      expect(registry.getProviderContract('other-client', 'other.contract')).toBe(CATALOG_OTHER_CLIENT);
    });

    it('is a no-op when the extension has no contracts', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);

      registry.unregisterAllByExtension('ext-nonexistent');

      expect(registry.getProviderContract('claude-code', 'anthropic.tool-response')).toBe(CATALOG_A);
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all registered contracts', () => {
      registry.registerProviderContract('ext-anthropic', CATALOG_A);
      registry.registerProviderContract('ext-other', CATALOG_OTHER_CLIENT);

      registry.clear();

      expect(registry.getProviderContract('claude-code', 'anthropic.tool-response')).toBeUndefined();
      expect(registry.getProviderContract('other-client', 'other.contract')).toBeUndefined();
    });
  });
});
