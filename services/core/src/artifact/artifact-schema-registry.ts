import type { IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects, type ArtifactKindRegistration, type RelationTypeRegistration } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';

/**
 * Core relation types registered with every artifact schema registry at
 * initialisation time. Extensions may add further types via the bus RPC.
 */
const CORE_RELATION_TYPES: readonly RelationTypeRegistration[] = [
  { type: 'supersedes', symmetry: 'asymmetric' },
  { type: 'contradicts', symmetry: 'symmetric' },
  { type: 'derives_from', symmetry: 'asymmetric' },
  { type: 'responds_to', symmetry: 'asymmetric' },
  { type: 'contains', symmetry: 'asymmetric' },
  { type: 'refines', symmetry: 'asymmetric' },
  { type: 'scopes', symmetry: 'asymmetric' },
  { type: 'references', symmetry: 'asymmetric' },
  { type: 'evidenced_by', symmetry: 'asymmetric' },
];

/**
 * Clone a registry record at API boundaries so external mutation cannot
 * rewrite in-memory registrations.
 * @param value - Registry value to clone.
 * @returns A detached copy of the registry value.
 */
function cloneRegistration<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Composite key used to deduplicate kind registrations.
 * @param kind - Kind discriminator string.
 * @param schemaVersion - Schema version string.
 * @returns A stable composite key.
 */
function kindKey(kind: string, schemaVersion: string): string {
  return `${kind}@${schemaVersion}`;
}

/**
 * In-process registry for artifact kind definitions and relation type vocabulary.
 *
 * Exposes bus RPCs for kind and relation-type registration and listing, and
 * emits `artifact.kind.changed` events when a kind registration is stored,
 * updated, or removed. Core relation vocabulary is seeded during `init()`.
 *
 * Extensions register artifact kinds through this service directly or via
 * {@link ArtifactSubjects}; the registry rejects conflicting duplicate
 * relation type definitions.
 */
export class ArtifactSchemaRegistry extends BaseService {
  private readonly kinds = new Map<string, ArtifactKindRegistration>();
  private readonly relationTypes = new Map<string, RelationTypeRegistration>();

  /**
   * @param bus - Bus instance used for handler registration and event emission.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /**
   * Service initialisation hook.
   *
   * Seeds core relation vocabulary and registers bus handlers for the
   * artifact kind and relation-type RPCs.
   */
  protected async onInit(): Promise<void> {
    for (const relationType of CORE_RELATION_TYPES) {
      this.relationTypes.set(relationType.type, relationType);
    }

    this.registerHandler(ArtifactSubjects.kind.register, (ctx) => {
      this.registerKind(ctx.payload);
      ctx.setResult({ registered: true });
    });

    this.registerHandler(ArtifactSubjects.kind.list, (ctx) => {
      const { kind } = ctx.payload;
      const kinds = [...this.kinds.values()].filter((entry) => !kind || entry.kind === kind).map(cloneRegistration);
      ctx.setResult({ kinds });
    });

    this.registerHandler(ArtifactSubjects['relation-type'].register, (ctx) => {
      this.storeRelationType(ctx.payload);
      ctx.setResult({ registered: true });
    });

    this.registerHandler(ArtifactSubjects['relation-type'].list, (ctx) => {
      const { type } = ctx.payload;
      const relationTypes = [...this.relationTypes.values()]
        .filter((entry) => !type || entry.type === type)
        .map(cloneRegistration);
      ctx.setResult({ relationTypes });
    });
  }

  /**
   * Store a kind registration, overwriting an existing entry for the same
   * `kind + schemaVersion` pair and emitting a `kind.changed` event.
   * @param registration - Kind registration payload.
   */
  public registerKind(registration: ArtifactKindRegistration): void {
    this.kinds.set(kindKey(registration.kind, registration.schemaVersion), cloneRegistration(registration));
    // Emit fire-and-forget; the bus does not guarantee ordering with the RPC
    // response, so callers that need the event should subscribe before calling.
    void this.bus.emit(ArtifactSubjects.kind.changed, {
      kind: registration.kind,
      schemaVersion: registration.schemaVersion,
    });
  }

  /**
   * Remove a kind registration by `kind + schemaVersion`.
   * @param kind - Kind discriminator string.
   * @param schemaVersion - Schema version string.
   */
  public deregisterKind(kind: string, schemaVersion: string): void {
    if (!this.kinds.delete(kindKey(kind, schemaVersion))) {
      return;
    }
    void this.bus.emit(ArtifactSubjects.kind.changed, { kind, schemaVersion });
  }

  /**
   * Store a relation type registration.
   *
   * An identical re-registration (same type and symmetry) is silently accepted.
   * A registration that differs only in symmetry is rejected with an error.
   * @param registration - Relation type registration payload received from the bus RPC.
   * @throws If a conflicting registration for the same type already exists.
   */
  private storeRelationType(registration: RelationTypeRegistration): void {
    const existing = this.relationTypes.get(registration.type);
    if (existing) {
      if (existing.symmetry !== registration.symmetry) {
        throw new Error(
          `Relation type '${registration.type}' is already registered with different symmetry` +
            ` (existing: '${existing.symmetry}', new: '${registration.symmetry}')`,
        );
      }
      // Identical re-registration is a no-op.
      return;
    }
    this.relationTypes.set(registration.type, cloneRegistration(registration));
  }

  /**
   * Look up a kind registration by kind string and schema version.
   * @param kind - Kind discriminator string.
   * @param schemaVersion - Schema version string.
   * @returns The registration record, or `undefined` if not found.
   */
  public getKind(kind: string, schemaVersion: string): ArtifactKindRegistration | undefined {
    const registration = this.kinds.get(kindKey(kind, schemaVersion));
    return registration ? cloneRegistration(registration) : undefined;
  }

  /**
   * Look up a relation type registration by type string.
   * @param type - Relation type string.
   * @returns The registration record, or `undefined` if not found.
   */
  public getRelationType(type: string): RelationTypeRegistration | undefined {
    const registration = this.relationTypes.get(type);
    return registration ? cloneRegistration(registration) : undefined;
  }

  /**
   * Service teardown hook.
   *
   * Clears all in-memory registrations so the instance can be garbage-collected
   * without retaining large schema maps.
   */
  protected override onDestroy(): void {
    this.kinds.clear();
    this.relationTypes.clear();
  }
}
