import { compileArtifactDataSchema, type ArtifactKindRegistration } from '@makaio/contracts/artifact';

/**
 * Compile the complete schema before an authoritative registration can change state.
 * @param registration - Structurally validated Kind registration.
 * @throws When the declared schema cannot be validated by the supported writer dialect.
 */
export function assertKindDataSchema(registration: ArtifactKindRegistration): void {
  try {
    compileArtifactDataSchema(registration);
  } catch (error) {
    throw new Error(
      `Invalid data schema for artifact kind '${registration.kind}' version '${registration.schemaVersion}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
