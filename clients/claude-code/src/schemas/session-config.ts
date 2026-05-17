/**
 * Claude Code session config setup schema.
 *
 * Defines the request/response schema pair for the
 * `client:claude-code.sessionConfig.setup` delegation subject.  This subject
 * is dispatched by {@link ClientSessionConfigService} after creating a
 * session-scoped directory; the Claude Code runtime service owns the concrete
 * handler that seeds the directory with native config files.
 * @packageDocumentation
 */

import type { SchemaRecord } from '@makaio/core';
import { SessionConfigSetupRequestSchema, SessionConfigSetupResponseSchema } from '@makaio/contracts/client';

/**
 * Bus schema definitions for the `sessionConfig.*` delegation subject.
 *
 * Subjects:
 * - `sessionConfig.setup` — seed a session-scoped directory with Claude Code
 *   native config files copied from the base config directory.
 */
export const ClaudeCodeSessionConfigSchemas = {
  /**
   * Seed the session-scoped config directory with the appropriate Claude Code
   * native files.
   *
   * Dispatched by {@link ClientSessionConfigService} after creating the session
   * directory.  The handler copies `settings.json` (or creates an empty one)
   * and `settings.local.json` (when present) from `baseConfigDir`.  On
   * Linux/Windows it also symlinks `.credentials.json` so the process can
   * authenticate without user interaction.
   */
  'sessionConfig.setup': {
    request: SessionConfigSetupRequestSchema,
    response: SessionConfigSetupResponseSchema,
  },
} satisfies SchemaRecord;
