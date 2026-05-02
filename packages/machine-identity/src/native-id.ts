import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const EXEC_TIMEOUT_MS = 5_000;

/**
 * Validate and normalize machine ID values before they become identity seeds.
 * @param value - Raw machine ID candidate
 * @returns Normalized lowercase machine ID, or `undefined` when malformed
 */
export function normalizeMachineId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(normalized)) {
    return normalized;
  }
  if (/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/.test(normalized)) {
    return normalized.replace(/[{}]/g, '');
  }
  return undefined;
}

/**
 * Read the hardware machine identifier using OS-native facilities.
 *
 * - **macOS**: parses `IOPlatformUUID` from `ioreg`.
 * - **Linux**: reads `/etc/machine-id` or `/var/lib/dbus/machine-id`.
 * - **Windows**: parses `MachineGuid` from the Cryptography registry key.
 *
 * Returns `undefined` when the platform is unrecognized or the OS call fails,
 * allowing callers to fall back to a generated or cached identifier.
 * @returns Hardware machine identifier, or `undefined` on failure.
 */
export function getNativeHardwareMachineId(): string | undefined {
  try {
    switch (process.platform) {
      case 'darwin':
        return readMacOsId();
      case 'linux':
        return readLinuxId();
      case 'win32':
        return readWindowsId();
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Read the macOS platform UUID from IOKit via `ioreg`.
 * @returns IOPlatformUUID value, or `undefined` when not found.
 */
function readMacOsId(): string | undefined {
  const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    encoding: 'utf-8',
    timeout: EXEC_TIMEOUT_MS,
  });
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output);
  return normalizeMachineId(match?.[1]);
}

/**
 * Read the Linux machine ID from the standard dbus paths.
 * @returns Machine ID string, or `undefined` when neither file is readable.
 */
function readLinuxId(): string | undefined {
  for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = normalizeMachineId(fs.readFileSync(candidate, 'utf-8'));
      if (value) {
        return value;
      }
    } catch {
      // Try next candidate
    }
  }
  return undefined;
}

/**
 * Read the Windows MachineGuid from the Cryptography registry key.
 * @returns MachineGuid value, or `undefined` when not found.
 */
function readWindowsId(): string | undefined {
  const regExe = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\reg.exe`;
  const output = execFileSync(regExe, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
    encoding: 'utf-8',
    timeout: EXEC_TIMEOUT_MS,
  });
  const match = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/.exec(output);
  return normalizeMachineId(match?.[1]);
}
