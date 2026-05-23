/**
 * Session service schema exports for Drizzle.
 *
 * This file exports only session-owned tables.
 * For consolidated migration schema, see \@makaio/storage-migrations.
 *
 * SCHEMA CHANGE WORKFLOW
 * ======================
 * 1. Modify the schema file(s) in src/X/schema.ts
 * 2. Run: yarn workspace \@makaio/storage-migrations db:generate
 * 3. Review generated SQL in libs/storage/migrations/drizzle/
 * 4. Migrations auto-apply on startup via runtimes/node
 */

// Core session tables
export { sessions, agents } from './storage/schema.js';

// Event tables
export { sessionEvents } from './session-events/schema.js';

// Normalized message model
export { turns } from './turns/schema.js';
export { messages } from './messages/schema.js';
export { messageRouting } from './message-routing/schema.js';

// Utility tables
export { importCursors } from './import-cursors/schema.js';
