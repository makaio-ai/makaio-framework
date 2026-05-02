/**
 * Tests for {@link ClientDefinitionRegistry}.
 *
 * Verifies construction-time seeding, lookup, list, and the test/admin
 * `register` method. Also verifies that the registry implements the
 * {@link ClientDefinitionLookup} interface.
 */

import { describe, expect, it } from 'vitest';
import { createClientDefinition } from '@makaio/contracts/client';
import { ClientDefinitionRegistry } from '../client-definition-registry.js';
import type { ClientDefinitionLookup } from '../client-binary-manager-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFINITION_A = createClientDefinition({
  id: 'client-a',
  name: 'Client A',
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: true },
  managedInstall: {
    type: 'manifest-bucket',
    config: {
      baseUrl: 'https://example.com/client-a',
      versionIndex: { latest: 'latest.txt' },
      manifestPath: 'manifest.json',
      manifestChecksumField: 'sha256',
      binaryPath: 'bin/client-a',
    },
  },
  versionCommand: ['bin/client-a', '--version'],
});

const DEFINITION_B = createClientDefinition({
  id: 'client-b',
  name: 'Client B',
  defaultApprovalPolicy: 'always-ask',
  runtimeCapabilities: { supportsManagedBinary: false },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientDefinitionRegistry', () => {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  it('creates an empty registry when no definitions are supplied', () => {
    const registry = new ClientDefinitionRegistry();
    expect(registry.listDefinitions()).toEqual([]);
    expect(registry.getDefinition('client-a')).toBeUndefined();
  });

  it('seeds definitions from the constructor argument', () => {
    const registry = new ClientDefinitionRegistry([DEFINITION_A, DEFINITION_B]);
    expect(registry.listDefinitions()).toHaveLength(2);
    expect(registry.getDefinition('client-a')).toBe(DEFINITION_A);
    expect(registry.getDefinition('client-b')).toBe(DEFINITION_B);
  });

  it('throws when two definitions in the constructor share the same id', () => {
    const duplicate = createClientDefinition({ ...DEFINITION_A, name: 'Client A Duplicate' });
    expect(() => new ClientDefinitionRegistry([DEFINITION_A, duplicate])).toThrow(
      "ClientDefinitionRegistry: duplicate client definition id 'client-a'",
    );
  });

  // -------------------------------------------------------------------------
  // getDefinition
  // -------------------------------------------------------------------------

  it('getDefinition returns undefined for an unknown client id', () => {
    const registry = new ClientDefinitionRegistry([DEFINITION_A]);
    expect(registry.getDefinition('unknown-client')).toBeUndefined();
  });

  it('getDefinition returns the correct definition by id', () => {
    const registry = new ClientDefinitionRegistry([DEFINITION_A, DEFINITION_B]);
    expect(registry.getDefinition('client-b')).toBe(DEFINITION_B);
  });

  // -------------------------------------------------------------------------
  // listDefinitions
  // -------------------------------------------------------------------------

  it('listDefinitions returns all seeded definitions', () => {
    const registry = new ClientDefinitionRegistry([DEFINITION_A, DEFINITION_B]);
    const listed = registry.listDefinitions();
    expect(listed).toHaveLength(2);
    expect(listed).toContain(DEFINITION_A);
    expect(listed).toContain(DEFINITION_B);
  });

  it('listDefinitions returns a snapshot that does not share the internal collection', () => {
    const registry = new ClientDefinitionRegistry([DEFINITION_A]);
    const listed = registry.listDefinitions();
    // The returned array is not the internal Map values reference —
    // mutating it must not affect subsequent calls.
    (listed as unknown[]).splice(0, 1);
    expect(registry.listDefinitions()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // register (test / admin path)
  // -------------------------------------------------------------------------

  it('register adds a new definition', () => {
    const registry = new ClientDefinitionRegistry([DEFINITION_A]);
    registry.register(DEFINITION_B);
    expect(registry.getDefinition('client-b')).toBe(DEFINITION_B);
    expect(registry.listDefinitions()).toHaveLength(2);
  });

  it('register replaces an existing definition with the same id', () => {
    const registry = new ClientDefinitionRegistry([DEFINITION_A]);
    const updated = createClientDefinition({ ...DEFINITION_A, name: 'Client A Updated' });
    registry.register(updated);
    expect(registry.getDefinition('client-a')).toBe(updated);
    expect(registry.listDefinitions()).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Interface conformance
  // -------------------------------------------------------------------------

  it('satisfies the ClientDefinitionLookup interface', () => {
    // Type-level assertion: if this compiles, ClientDefinitionRegistry
    // fully satisfies ClientDefinitionLookup.
    const registry: ClientDefinitionLookup = new ClientDefinitionRegistry([DEFINITION_A]);
    expect(registry.getDefinition('client-a')).toBe(DEFINITION_A);
    expect(registry.listDefinitions()).toHaveLength(1);
  });
});
