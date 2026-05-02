import { z } from 'zod';

/**
 * Shared CRUD request shape for storage namespaces that address rows by ID.
 */
export const StorageIdRequestSchema = z.object({
  id: z.string(),
});
