/**
 * Registry of static client definitions, seeded at construction time.
 *
 * This is the canonical implementation of {@link ClientDefinitionLookup} used
 * on the production boot path. The registry is fully populated before the
 * {@link ClientBinaryManager} is initialized, eliminating any post-start
 * mutation window on the service surface.
 *
 * The `register` method remains available for test and admin paths that need
 * to add definitions after construction, but it is NOT called during normal
 * application boot.
 * @packageDocumentation
 */

import type { ClientDefinition } from '@makaio/contracts/client';
import type { ClientDefinitionLookup } from './client-binary-manager-types.js';

/**
 * Concrete {@link ClientDefinitionLookup} implementation seeded with a fixed
 * set of definitions at construction time.
 *
 * Definitions are indexed by {@link ClientDefinition.id} for O(1) lookup.
 * The constructor validates that all supplied definitions have unique IDs,
 * throwing immediately on a duplicate to surface misconfiguration at boot
 * rather than silently overwriting an existing entry.
 * @example
 * ```ts
 * const registry = new ClientDefinitionRegistry([claudeCodeDefinition]);
 * const manager = new ClientBinaryManager(bus, config, registry, strategyDeps);
 * await manager.init();
 * ```
 */
export class ClientDefinitionRegistry implements ClientDefinitionLookup {
  private readonly definitions = new Map<string, ClientDefinition>();

  /**
   * Create a registry pre-seeded with the supplied definitions.
   *
   * Throws when any two definitions share the same `id` — duplicate IDs
   * indicate a misconfigured boot path that should fail loudly rather than
   * silently drop or overwrite an entry.
   * @param initialDefinitions - Ordered list of client definitions to register at construction time
   * @throws When two definitions in `initialDefinitions` share the same `id`
   */
  public constructor(initialDefinitions: readonly ClientDefinition[] = []) {
    for (const definition of initialDefinitions) {
      this.registerUnique(definition);
    }
  }

  /**
   * Return the static definition for the given client identifier, or
   * `undefined` when no definition is registered.
   * @param clientId - Stable client identifier (e.g. `'claude-code'`)
   * @returns The registered {@link ClientDefinition}, or `undefined`
   */
  public getDefinition(clientId: string): ClientDefinition | undefined {
    return this.definitions.get(clientId);
  }

  /**
   * Return all registered definitions in insertion order.
   *
   * `client.list` uses this to include managed clients that have no installed
   * versions or state rows yet.
   * @returns All registered client definitions
   */
  public listDefinitions(): readonly ClientDefinition[] {
    return [...this.definitions.values()];
  }

  /**
   * Register a client definition, replacing any existing entry for the same
   * `definition.id`.
   *
   * **Test and admin path only.** This method is intentionally excluded from
   * the normal application boot sequence. On the production path, all
   * definitions are supplied to the constructor so the registry is immutable
   * from the manager's perspective. Call `register` only from tests or
   * administrative tooling that needs to inject or replace a definition after
   * construction.
   * @param definition - Client definition to register; its `id` is used as the registry key
   */
  public register(definition: ClientDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  /**
   * Internal helper that registers a definition and throws on a duplicate ID.
   *
   * Used exclusively by the constructor to enforce uniqueness during seeding.
   * @param definition - Client definition to register
   * @throws When a definition with the same `id` is already registered
   */
  private registerUnique(definition: ClientDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`ClientDefinitionRegistry: duplicate client definition id '${definition.id}'`);
    }
    this.definitions.set(definition.id, definition);
  }
}
