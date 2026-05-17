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
import {
  SessionConfigSetupRequestSchema,
  SessionConfigSetupResponseSchema,
  SessionConfigTeardownRequestSchema,
  SessionConfigTeardownResponseSchema,
} from '@makaio/contracts/client';

/**
 * Bus schema definitions for the `sessionConfig.*` delegation subject.
 *
 * Subjects:
 * - `sessionConfig.setup` — seed a session-scoped directory with the requested
 *   Claude Code settings/auth inheritance policy.
 * - `sessionConfig.destroy` — clear native session credential material before
 *   the session-scoped directory is removed.
 */
export const ClaudeCodeSessionConfigSchemas = {
  /**
   * Seed the session-scoped config directory with the appropriate Claude Code
   * native files.
   *
   * Dispatched by {@link ClientSessionConfigService} after creating the session
   * directory.  The handler applies `configInheritance` to decide whether to
   * inherit settings plus auth, auth only, or an empty config shell.
   */
  'sessionConfig.setup': {
    request: SessionConfigSetupRequestSchema,
    response: SessionConfigSetupResponseSchema,
  },
  /**
   * Clear native credential material associated with a session-scoped config
   * directory before the generic lifecycle service removes the directory.
   */
  'sessionConfig.destroy': {
    request: SessionConfigTeardownRequestSchema,
    response: SessionConfigTeardownResponseSchema,
  },
} satisfies SchemaRecord;
