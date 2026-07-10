import type { SDKMessage } from '@makaio/client-claude-code';

/**
 * SDK result payload extended with the optional `structured_output` field
 * that Claude surfaces when `--json-schema` / `outputFormat` is active.
 */
export type ResultMessageWithStructuredOutput = Extract<SDKMessage, { type: 'result' }> & {
  result?: string;
  structured_output?: unknown;
};

/**
 * Convert a terminal result payload to Makaio's text result contract.
 *
 * When structured output is active, Claude returns the typed value in
 * `structured_output`. Makaio's terminal message contract is still text,
 * so the structured value is serialized back to JSON for shared validation
 * and persistence.
 * @param msg - Terminal SDK result.
 * @returns Terminal message text for the Makaio message result.
 */
export function resolveResultMessage(msg: ResultMessageWithStructuredOutput): string {
  if ('structured_output' in msg && msg.structured_output !== undefined) {
    return JSON.stringify(msg.structured_output);
  }
  return msg.result ?? '';
}
