import { TurnStorageNamespace as BaseTurnStorageNamespace } from '../../turn/namespace.js';
import { turns } from './schema.js';

/**
 * Extended Turn storage namespace with Drizzle schemas.
 *
 * The base turn storage namespace lives in `../../turn/namespace.js`.
 * This module extends that framework-owned contract with Drizzle ORM schemas
 * for the session-service implementation.
 */
export const TurnStorageNamespace = {
  ...BaseTurnStorageNamespace,
  extensions: {
    drizzle: {
      turns,
    },
  },
};
