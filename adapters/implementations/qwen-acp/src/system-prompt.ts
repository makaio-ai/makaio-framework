import type { ProcessingState } from '@makaio/ai-adapters-core';
import type { SystemPrompt } from '@makaio/contracts';

/**
 * Convert a runtime system prompt into the text written to QWEN_SYSTEM_MD.
 * @param prompt - Runtime system prompt
 * @returns Plain-text prompt content
 */
export function getSystemPromptText(prompt: SystemPrompt): string {
  return typeof prompt === 'string' ? prompt : prompt.content;
}

/**
 * Whether an idle connector should recreate its ACP session to apply a newly
 * resolved system prompt at spawn time.
 * @param options - Current connector state and the next prompt
 * @returns True when the connector should rebuild its ACP session
 */
export function shouldReinitializeSystemPrompt(options: {
  isInitialized: boolean;
  nextPrompt: SystemPrompt | undefined;
  currentPrompt: SystemPrompt | undefined;
  hasActiveTurn: boolean;
  hasPendingMessage: boolean;
  hasCompletedTurn: boolean;
  processingState: ProcessingState;
}): boolean {
  if (!options.isInitialized || options.nextPrompt === undefined) {
    return false;
  }

  if (
    options.hasActiveTurn ||
    options.hasPendingMessage ||
    options.hasCompletedTurn ||
    options.processingState !== 'idle'
  ) {
    return false;
  }

  const currentPromptText = options.currentPrompt ? getSystemPromptText(options.currentPrompt) : undefined;
  return currentPromptText !== getSystemPromptText(options.nextPrompt);
}

/**
 * Write a runtime system prompt to a private temporary file for `QWEN_SYSTEM_MD`.
 *
 * The qwen CLI reads its system prompt from a file path rather than an argument,
 * so a prompt only reaches it through one. Created with `wx` and mode `0600`: the
 * prompt is caller content and must neither collide with an existing path nor be
 * readable by other users on the machine.
 * @param prompt - Runtime system prompt to make available to the spawned CLI.
 * @returns Absolute path of the file the caller now owns and must clean up.
 */
export async function writeSystemPromptTempFile(prompt: SystemPrompt): Promise<string> {
  const { randomUUID } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tempPath = join(tmpdir(), `qwen-acp-system-${randomUUID()}.md`);
  await writeFile(tempPath, getSystemPromptText(prompt), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  return tempPath;
}

/**
 * Remove a system-prompt temporary file, tolerating one that is already gone.
 *
 * Best-effort by design: every caller is on a teardown or rebuild path where a
 * missing file is the desired end state, and a throw here would turn tidying up
 * into a failure.
 * @param path - Path returned by {@link writeSystemPromptTempFile}, if one exists.
 */
export async function removeSystemPromptTempFile(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(path);
  } catch {
    // best-effort: the file may already have been removed
  }
}
