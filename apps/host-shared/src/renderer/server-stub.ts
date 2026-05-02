/**
 * Empty stub for server-only packages.
 *
 * Vite aliases server-only packages (drizzle-orm/libsql, libsql/client, etc.)
 * to this stub in browser builds. This prevents Node.js-only code from being bundled.
 *
 * The actual types are still available via `import type` which is stripped at compile time.
 */

// Export stubs for any runtime imports
export default {};

// drizzle-orm/libsql exports
export const LibSQLDatabase = {};
export const drizzle = () => {
  throw new Error('Server-only: drizzle-orm/libsql cannot be used in browser');
};

// libsql/client exports
export const createClient = () => {
  throw new Error('Server-only: @libsql/client cannot be used in browser');
};
