import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ArtifactKindRegistration } from '@makaio/contracts';

/**
 * Compile the complete schema before an authoritative registration can change state.
 * @param registration - Structurally validated Kind registration.
 * @throws When the declared schema cannot be validated by the supported writer dialect.
 */
export function assertKindDataSchema(registration: ArtifactKindRegistration): void {
  try {
    // Each Kind owns its local schema identifiers; compiler caches must not allow
    // one Kind's definitions to satisfy another Kind's references.
    const options = { allErrors: true, strict: false, strictSchema: true };
    const compiler =
      registration.dataSchema.$schema === 'https://json-schema.org/draft/2020-12/schema'
        ? new Ajv2020(options)
        : new Ajv(options);
    addFormats(compiler);
    compiler.compile(registration.dataSchema);
  } catch (error) {
    throw new Error(
      `Invalid data schema for artifact kind '${registration.kind}' version '${registration.schemaVersion}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
