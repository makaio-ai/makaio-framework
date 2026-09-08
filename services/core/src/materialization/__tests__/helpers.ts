import type {
  ArtifactKindRegistration,
  ArtifactRevision,
  ArtifactViewBuilder,
  ArtifactViewBuilderResult,
} from '@makaio/contracts';

/**
 * Create a minimal artifact revision fixture with optional overrides.
 * @param overrides - Partial fields to merge into the base revision.
 * @returns A complete artifact revision fixture.
 */
export function makeRevision(overrides: Partial<ArtifactRevision> = {}): ArtifactRevision {
  return {
    kind: 'test-kind',
    id: 'artifact-1',
    revision: 'rev-1',
    scope: { level: 'global' },
    schemaVersion: 1,
    data: { title: 'Test Title', status: 'active' },
    relations: [],
    actor: { kind: 'system', id: 'test' },
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a minimal artifact kind registration fixture with optional overrides.
 * @param overrides - Partial fields to merge into the base registration.
 * @returns A complete artifact kind registration fixture.
 */
export function makeRegistration(overrides: Partial<ArtifactKindRegistration> = {}): ArtifactKindRegistration {
  return {
    kind: 'test-kind',
    description: 'Test kind',
    schemaVersion: 1,
    dataSchema: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1 } },
      required: ['title'],
      additionalProperties: false,
    },
    category: 'knowledge' as const,
    titlePath: 'title',
    ...overrides,
  };
}

/**
 * Create a minimal artifact view builder stub.
 * @param kind - Artifact kind discriminator.
 * @param schemaVersion - Artifact schema version.
 * @param version - Positive integer builder version.
 * @param result - Builder output; `undefined` keeps generic sections.
 * @returns An artifact view builder fixture.
 */
export function makeBuilder(
  kind: string,
  schemaVersion: number,
  version = 1,
  result: ArtifactViewBuilderResult = undefined,
): ArtifactViewBuilder {
  return {
    kind,
    schemaVersion,
    version,
    build: async () => result,
  };
}
