import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ARTIFACT_VALUE_TYPE_KEYWORD } from './evidence.js';
import type { ArtifactKindRegistration } from './kind-registration.js';

/** Validates one artifact payload against its registered JSON Schema. */
export type ArtifactDataValidator = (data: unknown) => boolean;

/**
 * Compile the JSON Schema declared by one artifact kind.
 *
 * Each invocation creates an isolated compiler so local schema identifiers
 * cannot satisfy references belonging to another kind.
 * @param registration - Structurally validated artifact kind registration.
 * @returns A predicate for complete artifact payload validation.
 * @throws When the declared data schema cannot be compiled by its supported dialect.
 */
export function compileArtifactDataSchema(registration: ArtifactKindRegistration): ArtifactDataValidator {
  const options = { allErrors: true, strict: false, strictSchema: true };
  const compiler =
    registration.dataSchema.$schema === 'https://json-schema.org/draft/2020-12/schema'
      ? new Ajv2020(options)
      : new Ajv(options);
  addFormats(compiler);
  compiler.addKeyword({ keyword: ARTIFACT_VALUE_TYPE_KEYWORD, schemaType: 'string', valid: true });
  return compiler.compile(registration.dataSchema);
}
