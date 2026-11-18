/**
 * Encode a bus message as a JSONL line.
 * @param message - Bus message to encode.
 * @returns Newline-terminated JSON string.
 */
export function encodeBusMessage(message: object): string {
  return JSON.stringify(message) + '\n';
}
