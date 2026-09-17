/**
 * Header preparation for the Anthropic API-key forwarding branch.
 *
 * This module is the Anthropic counterpart of `litellm-body.ts`'s
 * {@link prepareLitellmHeaders}. It handles the case where an Anthropic
 * upstream is configured with an explicit `auth.apiKey` credential, replacing
 * the client-supplied auth headers with the gateway-owned API key.
 *
 * When an upstream has no `auth` (pass-through mode), no header manipulation
 * is needed and this module is not called; the filtered client headers are
 * forwarded verbatim.
 *
 * **Division of responsibility:**
 * Hop-by-hop filtering (`connection`, `transfer-encoding`, `host`,
 * `content-length`, etc.) is the forwarding layer's responsibility and must
 * be applied **before** calling {@link prepareAnthropicApiKeyHeaders}. This
 * ordering is critical: a client-supplied `Connection: authorization`
 * nomination would otherwise cause the forwarding layer to strip the injected
 * `x-api-key` after this function sets it.
 * @packageDocumentation
 */

/**
 * Prepare outgoing request headers for an Anthropic upstream that authenticates
 * via a gateway-owned API key rather than forwarding the client's credentials.
 *
 * Expects `incoming` to have already been processed by `filterRequestHeaders`
 * so that hop-by-hop and `Connection`-nominated headers are absent. Returns a
 * copy with `x-api-key` set to the resolved key and `authorization` removed,
 * replacing any subscription OAuth bearer token the client may have sent.
 *
 * **Security:** `apiKey` is resolved plaintext. It must never be logged.
 * @param incoming - Pre-filtered headers (hop-by-hop and Connection-nominated
 *   names already removed by `filterRequestHeaders` in the caller).
 * @param apiKey - Resolved plaintext Anthropic API key. Must never be logged.
 * @returns A new {@link Headers} instance with authentication fields replaced.
 */
export function prepareAnthropicApiKeyHeaders(incoming: Headers, apiKey: string): Headers {
  const headers = new Headers(incoming);
  headers.set('x-api-key', apiKey);
  headers.delete('authorization');
  return headers;
}
