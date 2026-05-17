/**
 * Claude Code config prime delegation schema.
 *
 * Defines the request/response schema pair for the
 * `client:claude-code.config.prime` delegation subject. This subject is
 * dispatched by the framework at three lifecycle phases (`managed-install`,
 * `profile-create`, `session-create`) via {@link primeClientConfig}. The
 * Claude Code runtime service owns the concrete handler that writes
 * `DISABLE_AUTOUPDATER=1` into the target config directory's `settings.json`.
 * @packageDocumentation
 */

import type { SchemaRecord } from '@makaio/core';
import { ClientConfigPrimeSchema } from '@makaio/contracts/client';

/**
 * Bus schema definitions for the `config.prime` delegation subject.
 *
 * Subjects:
 * - `config.prime` — prime the config directory at a given lifecycle phase by
 *   writing Claude Code-specific settings (e.g. `DISABLE_AUTOUPDATER=1`).
 */
export const ClaudeCodeConfigPrimeSchemas = {
  /**
   * Prime the config directory with Claude Code-specific defaults.
   *
   * Dispatched by the framework at `managed-install`, `profile-create`, and
   * `session-create` lifecycle phases. The handler ensures `settings.json`
   * contains `env.DISABLE_AUTOUPDATER = "1"` while preserving any existing
   * settings.
   */
  'config.prime': {
    request: ClientConfigPrimeSchema.request,
    response: ClientConfigPrimeSchema.response,
  },
} satisfies SchemaRecord;
