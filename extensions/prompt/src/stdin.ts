/**
 * Read all of stdin when piped (non-TTY).
 * @returns The stdin content, or `null` if stdin is a TTY.
 */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
