import { createStorageNamespace } from '@makaio/storage-core';
import { TurnStorageSchemas } from './schemas.js';

/**
 * Turn storage namespace registration — has side effects (registers on the bus).
 *
 * Provides bus subjects for turn lifecycle management.
 * A turn represents a user message and all agent responses to it.
 *
 * Implementation lives in \@makaio/services-core/session, but the contract
 * is defined here to allow libs (like \@makaio/hooks) to query turns
 * without depending on the service layer.
 *
 * For pure Zod schemas without side effects, import `./schemas` instead.
 */
export const TurnStorageNamespace = createStorageNamespace('turn', {
  schemas: TurnStorageSchemas,
});

/**
 * Typed subjects for turn storage operations.
 */
export const TurnStorageSubjects = TurnStorageNamespace.subjects;
