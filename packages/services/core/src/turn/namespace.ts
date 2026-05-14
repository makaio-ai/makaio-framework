import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import { TurnStorageSchemas } from './schemas.js';

/**
 * Turn storage namespace definition.
 *
 * Provides bus subjects for turn lifecycle management.
 * A turn represents a user message and all agent responses to it.
 *
 * Implementation lives in \@makaio/services-core/session, but the contract
 * is defined here to allow libs (like \@makaio/hooks) to query turns
 * without depending on the service layer.
 *
 * Import `./schemas` when only pure Zod schemas are needed. Composition roots
 * register this storage namespace explicitly.
 */
export const TurnStorageNamespace = createStorageNamespaceDefinition('turn', {
  schemas: TurnStorageSchemas,
});

/**
 * Typed subjects for turn storage operations.
 */
export const TurnStorageSubjects = TurnStorageNamespace.subjects;
