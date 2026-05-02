import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Parses the password line from `security find-generic-password -g` stderr output.
 *
 * The `-g` flag writes the password to stderr in one of two forms:
 * - `password: "hello"` — for printable ASCII values (unquote the string)
 * - `password: 0xDEADBEEF  "..."` — for binary/non-ASCII values (decode the hex)
 *
 * Since `keychainWrite` always hex-encodes via `-X`, we must always decode the
 * hex form to recover the original UTF-8 string. Printable-ASCII values written
 * with `-X` are returned in quoted form by `-g`, but their raw bytes are the
 * original string and no additional decoding step is needed.
 * @param stderr - The full stderr output from `security find-generic-password -g`
 * @returns The decoded password string
 */
function parseSecurityPassword(stderr: string): string {
  // Match the password line: either `password: 0xHEX  "..."` or `password: "..."`
  const hexMatch = /^password: 0x([0-9A-Fa-f]+)/m.exec(stderr);
  if (hexMatch) {
    return Buffer.from(hexMatch[1], 'hex').toString('utf-8');
  }
  // The `.*` intentionally does not match newlines — macOS `security` output places the
  // password value on a single line after `password:`. Multi-line password values are
  // not produced by `security find-generic-password -g`.
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
 * Uses `-g` (which writes the password to stderr) rather than `-w` because
 * `-w` inconsistently returns raw bytes for printable content but a hex string
 * for non-printable content. The `-g` output has a stable, parseable format
 * regardless of the stored value.
 * @param service - The keychain service name
 * @param account - The keychain account name (defaults to current user)
 * @returns The password string, or null if not found
 */
export async function keychainRead(service: string, account?: string): Promise<string | null> {
  const args = ['find-generic-password', '-s', service, '-g'];
  if (account) args.push('-a', account);

  try {
    const { stderr } = await execFileAsync('/usr/bin/security', args);
    return parseSecurityPassword(stderr);
  } catch (error) {
    if (error instanceof Error) {
      // Node's promisify puts the process exit code (number) into `.code` when the
      // child exits non-zero, and a string like 'ENOENT' for OS-level spawn errors.
      // NodeJS.ErrnoException only declares `string | undefined`, so we widen to the
      // actual runtime union without losing type safety elsewhere.
      const code = (error as Error & { code?: string | number }).code;
      // Binary not found — not macOS or misconfigured system
      if (code === 'ENOENT') throw error;
      // Exit code 44 is the macOS `security` convention for "item not found"
      if (code === 44) return null;
    }
    // All other failures (locked keychain, access denied, etc.) must propagate
    // so callers never silently rotate encryption keys on a transient OS error.
    throw error;
  }
}

/**
 * Writes a generic password to the macOS keychain.
 *
 * Uses `-U` (update if exists) and `-X` (hex-encoded value) to match
 * the pattern used by Claude Code itself.
 * @param service - The keychain service name
 * @param account - The keychain account name
 * @param value - The value to store (will be hex-encoded)
 */
export async function keychainWrite(service: string, account: string, value: string): Promise<void> {
  const hex = Buffer.from(value, 'utf-8').toString('hex');
  await execFileAsync('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', account, '-X', hex]);
}
