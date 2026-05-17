/**
 * Claude Code config prime handler.
 *
 * Implements the `client:claude-code.config.prime` delegation request by
 * ensuring the target config directory's `settings.json` contains
 * `env.DISABLE_AUTOUPDATER = "1"`. This prevents Claude Code from
 * self-updating while running under Makaio management, since Makaio owns the
 * binary lifecycle.
 *
 * The handler is idempotent: if `DISABLE_AUTOUPDATER` is already set, no
 * change is made and the file is not rewritten. Existing settings fields are
 * preserved in their entirety.
 *
 * The write is performed atomically — the updated JSON is written to a
 * temporary file in the same directory, then renamed over the target path to
 * prevent partial writes from corrupting the settings file.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClientConfigPrimeRequest, ClientConfigPrimeResponse } from '@makaio/contracts/client';

type JsonObject = Record<string, unknown>;

/**
 * Handle `client:claude-code.config.prime` by ensuring the config directory's
 * `settings.json` has `env.DISABLE_AUTOUPDATER = "1"` set.
 *
 * The handler:
 * 1. Creates the config directory if it does not exist.
 * 2. Reads or creates `settings.json` in that directory.
 * 3. Merges `env.DISABLE_AUTOUPDATER = "1"` while preserving all other fields.
 * 4. Writes the updated JSON back atomically via a temporary file and rename.
 *
 * The operation is idempotent — subsequent calls with the same `configDir`
 * produce the same file content.
 * @param payload - Validated config prime request carrying `clientId`,
 *   `configDir`, and the lifecycle `phase`.
 * @returns Response indicating that the prime was handled.
 */
export async function handleClaudeCodeConfigPrime(
  payload: ClientConfigPrimeRequest,
): Promise<ClientConfigPrimeResponse> {
  const settingsPath = path.join(payload.configDir, 'settings.json');
  await fs.mkdir(payload.configDir, { recursive: true });

  let current: JsonObject = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isJsonObject(parsed)) {
      current = parsed;
    } else {
      throw new SyntaxError(`settings.json must contain an object at '${settingsPath}'`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const currentEnv = isJsonObject(current['env']) ? current['env'] : {};
  if (currentEnv['DISABLE_AUTOUPDATER'] === '1') {
    return { primed: true };
  }

  const next: JsonObject = {
    ...current,
    env: {
      ...currentEnv,
      DISABLE_AUTOUPDATER: '1',
    },
  };

  const tmpPath = path.join(payload.configDir, `settings.json.${randomUUID()}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, settingsPath);

  return { primed: true };
}

/**
 * Return true when a parsed JSON value is a plain object shape.
 * @param value - Parsed JSON value to inspect.
 * @returns True when the value can be safely treated as a JSON object.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
