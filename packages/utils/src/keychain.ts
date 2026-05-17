import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** macOS Security framework exit code for "item not found" (errSecItemNotFound). */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

/**
 * Parses the password line from `security find-generic-password -g` stderr output.
 *
 * The `-g` flag writes the password to stderr in one of two forms:
 * - `password: "hello"` for printable ASCII values.
 * - `password: 0xDEADBEEF  "..."` for binary or non-ASCII values.
 * @param stderr - The full stderr output from `security find-generic-password -g`.
 * @returns The decoded password string.
 */
function parseSecurityPassword(stderr: string): string {
  const hexMatch = /^password: 0x([0-9A-Fa-f]+)/m.exec(stderr);
  if (hexMatch) {
    return Buffer.from(hexMatch[1], 'hex').toString('utf-8');
  }

  const quotedMatch = /^password: "(.*)"/m.exec(stderr);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  const redactedStderr = stderr.replace(/^password:.*$/gm, 'password: [REDACTED]');
  throw new Error(`Unexpected security output format: ${redactedStderr}`);
}

/**
 * Reads a generic password from the macOS keychain.
 *
 * Uses `/usr/bin/security` directly with argv arrays so shell expansion is not
 * involved. Returns `null` when the entry does not exist.
 * @param service - Keychain service name.
 * @param account - Optional keychain account name.
 * @returns Stored password value, or `null` when absent.
 */
export async function keychainRead(service: string, account?: string): Promise<string | null> {
  const args = ['find-generic-password', '-s', service, '-g'];
  if (account) args.push('-a', account);

  try {
    const { stderr } = await execFileAsync('/usr/bin/security', args);
    return parseSecurityPassword(stderr);
  } catch (error) {
    if (error instanceof Error) {
      const code = (error as Error & { code?: string | number }).code;
      if (code === 'ENOENT') throw error;
      if (code === KEYCHAIN_ITEM_NOT_FOUND) return null;
    }
    throw error;
  }
}

/**
 * Writes a generic password to the macOS keychain.
 *
 * Uses `-U` to update existing entries and `-X` so arbitrary UTF-8 JSON values
 * round-trip without shell quoting or locale assumptions.
 * @param service - Keychain service name.
 * @param account - Keychain account name.
 * @param value - Password value to store.
 */
export async function keychainWrite(service: string, account: string, value: string): Promise<void> {
  const hex = Buffer.from(value, 'utf-8').toString('hex');
  await execFileAsync('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', account, '-X', hex]);
}

/**
 * Deletes a generic password from the macOS keychain.
 *
 * Missing entries are treated as already deleted.
 * @param service - Keychain service name.
 * @param account - Optional keychain account name.
 */
export async function keychainDelete(service: string, account?: string): Promise<void> {
  const args = ['delete-generic-password', '-s', service];
  if (account) args.push('-a', account);

  try {
    await execFileAsync('/usr/bin/security', args);
  } catch (error) {
    if (error instanceof Error) {
      const code = (error as Error & { code?: string | number }).code;
      if (code === 'ENOENT') throw error;
      if (code === KEYCHAIN_ITEM_NOT_FOUND) return;
    }
    throw error;
  }
}
