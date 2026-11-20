import * as fs from 'node:fs';
import { launch as realLaunch, launchForOutput, type LaunchFunction } from '@makaio/subprocess';

const EXEC_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

/**
 * Run one OS command through the launcher and return its stdout.
 * The working directory is the host's current one, as it was with the synchronous `execFileSync` this replaces.
 * @param launch - Process start port
 * @param command - Executable to start
 * @param args - Arguments of the command
 * @returns Captured stdout, or `undefined` when the command did not complete successfully
 */
async function readCommandOutput(
  launch: LaunchFunction,
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  const outcome = await launchForOutput(
    {
      command,
      args,
      cwd: process.cwd(),
      envMode: 'merge',
      timeoutMs: EXEC_TIMEOUT_MS,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
    },
    launch,
  );
  return outcome.ok ? outcome.stdout : undefined;
}

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
 * @param launch - Process start port for the OS commands; defaults to the real `launch`
 * @returns Hardware machine identifier, or `undefined` on failure.
 */
export async function getNativeHardwareMachineId(launch: LaunchFunction = realLaunch): Promise<string | undefined> {
  try {
    switch (process.platform) {
      case 'darwin':
        return await readMacOsId(launch);
      case 'linux':
        return readLinuxId();
      case 'win32':
        return await readWindowsId(launch);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Read the macOS platform UUID from IOKit via `ioreg`.
 * @param launch - Process start port
 * @returns IOPlatformUUID value, or `undefined` when not found.
 */
async function readMacOsId(launch: LaunchFunction): Promise<string | undefined> {
  const output = await readCommandOutput(launch, '/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output ?? '');
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
 * @param launch - Process start port
 * @returns MachineGuid value, or `undefined` when not found.
 */
async function readWindowsId(launch: LaunchFunction): Promise<string | undefined> {
  const regExe = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\reg.exe`;
  const output = await readCommandOutput(launch, regExe, [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid',
  ]);
  const match = /MachineGuid\s+REG_SZ\s+([^\r\n]+)/.exec(output ?? '');
  return normalizeMachineId(match?.[1]);
}
