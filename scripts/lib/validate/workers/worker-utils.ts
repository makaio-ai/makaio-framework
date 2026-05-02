/**
 * Shared utilities for validation worker processes.
 * @packageDocumentation
 */

/**
 * Reads all data from stdin.
 * @returns Promise resolving to stdin content as string
 */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
