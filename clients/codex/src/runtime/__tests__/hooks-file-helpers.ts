import fs from 'node:fs/promises';
import path from 'node:path';

interface FlatHookEntry {
  readonly event: string;
  readonly matcher?: string;
  readonly command: string;
  readonly timeout?: number;
}

/**
 * Check whether a value is a flat command-hook entry.
 * @param value - Value to inspect.
 * @returns `true` when the value can be written as a native command hook.
 */
function isFlatHookEntry(value: unknown): value is FlatHookEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['event'] === 'string' && typeof record['command'] === 'string';
}

/**
 * Convert flat test hook entries into Codex's native grouped hooks file shape.
 * @param hooks - Flat hook entries.
 * @returns Native `hooks.json` object.
 */
function toNativeHooksFile(hooks: readonly unknown[]): {
  hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
} {
  const byEvent: Record<string, Array<{ matcher?: string; hooks: unknown[] }>> = {};
  for (const hook of hooks) {
    if (!isFlatHookEntry(hook)) continue;
    const group = {
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      hooks: [
        {
          type: 'command',
          command: hook.command,
          ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}),
        },
      ],
    };
    byEvent[hook.event] = [...(byEvent[hook.event] ?? []), group];
  }
  return { hooks: byEvent };
}

/**
 * Convert Codex's native grouped hooks file shape into flat entries.
 * @param nativeFile - Native `hooks.json` object.
 * @returns Flat command-hook entries.
 */
function fromNativeHooksFile(nativeFile: unknown): FlatHookEntry[] {
  const nativeRecord = nativeFile as { hooks?: Record<string, Array<{ matcher?: string; hooks: unknown[] }>> };
  const entries: FlatHookEntry[] = [];
  for (const [event, groups] of Object.entries(nativeRecord.hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (typeof handler !== 'object' || handler === null) continue;
        const record = handler as Record<string, unknown>;
        if (record['type'] !== 'command' || typeof record['command'] !== 'string') continue;
        entries.push({
          event,
          ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          command: record['command'],
          ...(typeof record['timeout'] === 'number' ? { timeout: record['timeout'] } : {}),
        });
      }
    }
  }
  return entries;
}

/**
 * Write a `hooks.json` file with the given hook entries.
 * Creates parent directories as needed.
 * @param filePath - Absolute path to write.
 * @param hooks - Flat hook entries to persist as native Codex config.
 */
export async function writeHooksJson(filePath: string, hooks: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(toNativeHooksFile(hooks), null, 2)}\n`, 'utf-8');
}

/**
 * Read and parse a `hooks.json` file.
 * @param filePath - Absolute path to read.
 * @returns Flattened command hook entries.
 */
export async function readHooksJson(filePath: string): Promise<unknown[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return fromNativeHooksFile(JSON.parse(content));
}

/**
 * Write a native Codex `hooks.json` object.
 * @param filePath - Absolute path to write.
 * @param nativeFile - Native Codex hooks file object.
 */
export async function writeNativeHooksJson(filePath: string, nativeFile: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(nativeFile, null, 2)}\n`, 'utf-8');
}

/**
 * Read and parse the native Codex `hooks.json` object.
 * @param filePath - Absolute path to read.
 * @returns Parsed native Codex hooks file object.
 */
export async function readNativeHooksJson(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}
