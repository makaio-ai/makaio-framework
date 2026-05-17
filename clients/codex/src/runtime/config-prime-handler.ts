/**
 * Codex config-prime handler.
 *
 * Handles the `client:codex.config.prime` delegation subject fired by the
 * framework at three lifecycle phases: `managed-install`, `profile-create`,
 * and `session-create`.
 *
 * The handler ensures that `check_for_update_on_startup = false` is present
 * in the Codex `config.toml` file inside the target directory so that managed
 * Codex processes never attempt to auto-update during a Makaio-controlled
 * session. All other existing config keys are preserved; the key is replaced
 * when it already exists with any value, and appended when absent.
 *
 * Writes are atomic (tmp-file + rename) to prevent readers from observing a
 * partially written file. The operation is idempotent: when the file already
 * contains the correct value the write is skipped entirely.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClientConfigPrimeRequest, ClientConfigPrimeResponse } from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Prime the Codex `config.toml` in the target config directory.
 *
 * Ensures that `check_for_update_on_startup = false` is set, preserving all
 * other existing key-value pairs. Existing occurrences of the key (with any
 * value) are replaced; the key is appended when absent. Empty lines are
 * stripped to keep the file compact.
 *
 * The write is atomic via a temporary file + `fs.rename()` to prevent readers
 * from observing a partially written file. The operation is idempotent: when
 * the file already contains the correct value the disk is not touched.
 * @param payload - Config prime request containing `clientId`, `configDir`,
 *   and `phase`. Additional optional fields (`binaryVersion`, `adapterName`,
 *   `projectDir`) are accepted but not used by the Codex prime handler.
 * @returns `{ primed: true }` on success.
 */
export async function handleCodexConfigPrime(payload: ClientConfigPrimeRequest): Promise<ClientConfigPrimeResponse> {
  const configPath = path.join(payload.configDir, 'config.toml');
  await fs.mkdir(payload.configDir, { recursive: true });

  let current = '';
  try {
    current = await fs.readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // Strip existing occurrences of the key (any value) and blank lines so the
  // final file has exactly one canonical root entry before any TOML table.
  const lines = current
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('check_for_update_on_startup'))
    .filter((line) => line.length > 0);

  const tableIndex = lines.findIndex((line) => line.trimStart().startsWith('['));
  if (tableIndex === -1) {
    lines.push('check_for_update_on_startup = false');
  } else {
    lines.splice(tableIndex, 0, 'check_for_update_on_startup = false');
  }
  const updated = `${lines.join('\n')}\n`;

  if (updated === current) {
    return { primed: true };
  }

  const tmpPath = path.join(payload.configDir, `config.toml.${randomUUID()}.tmp`);
  await fs.writeFile(tmpPath, updated, 'utf-8');
  await fs.rename(tmpPath, configPath);

  return { primed: true };
}
