import type { PermissionOption, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Map a Makaio tool-approval response to an ACP RequestPermissionResponse.
 * @param action - Makaio approval action
 * @param options - ACP permission options exposed by the agent
 * @returns ACP-compatible permission response
 */
export function mapApprovalToAcpResponse(
  action: 'allow' | 'deny',
  options: PermissionOption[],
): RequestPermissionResponse {
  if (action === 'allow') {
    const opt =
      options.find((option) => option.kind === 'allow_once') ??
      options.find((option) => option.kind?.startsWith('allow'));
    if (opt) {
      return { outcome: { outcome: 'selected', optionId: opt.optionId } };
    }
  }

  if (action === 'deny') {
    const opt =
      options.find((option) => option.kind === 'reject_once') ??
      options.find((option) => option.kind?.startsWith('reject'));
    if (opt) {
      return { outcome: { outcome: 'selected', optionId: opt.optionId } };
    }
  }

  return { outcome: { outcome: 'cancelled' } };
}
