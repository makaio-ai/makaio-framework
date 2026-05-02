import type { PermissionHandler, PermissionRequest } from '@github/copilot-sdk';
import { NoHandlerError, RequestError } from '@makaio/bus-core';
import type { AgentToolApproveResponse } from '@makaio/contracts';
import { mapCoreResponseToPermissionResult, mapPermissionRequestToCoreRequest } from './tool-handling.js';
import { GitHubCopilotConnectorSubjects } from './namespaces/index.js';

/** Payload shape accepted by the `can_use_tool` bus RPC — the output of {@link mapPermissionRequestToCoreRequest}. */
type CanUseToolPayload = ReturnType<typeof mapPermissionRequestToCoreRequest>;

/**
 * Delegate interface required by {@link buildPermissionHandler}.
 *
 * Separates the approval bus RPC, error handling, and denial notification
 * from the factory so it can be extracted outside the connector class.
 */
export interface PermissionHandlerDelegate {
  /**
   * Request tool approval via the adapter-specific subject.
   * @param subject - Scoped subject for the can_use_tool bus RPC
   * @param payload - Normalized tool approval request (output of mapPermissionRequestToCoreRequest)
   * @returns Tool approval response
   */
  requestToolApproval(
    subject: typeof GitHubCopilotConnectorSubjects.can_use_tool,
    payload: CanUseToolPayload,
  ): Promise<AgentToolApproveResponse>;

  /**
   * Handle an error during permission processing.
   * @param error - Error that occurred
   * @param terminate - Whether to terminate the agent
   */
  handleError(error: unknown, terminate: boolean): void;

  /**
   * Notify about a denied tool approval.
   * @param abort - Abort signal: 'handled' for hard denial, 'not_requested' for soft denial
   * @param toolName - Tool name that was denied, or undefined when unavailable
   */
  handleToolApprovalDenied(abort: 'handled' | 'not_requested', toolName: string | undefined): void;
}

/**
 * Normalize tool-approval failures into an Error with a stable message.
 * @param error - Unknown thrown/rejected value from approval routing
 * @returns Error passed to diagnostics and denial response
 */
function normalizeToolApprovalError(error: unknown): Error {
  if (error instanceof RequestError || error instanceof NoHandlerError) {
    return new Error("Tool approval request failed, make sure that there's a handler registered: " + error.message);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/**
 * Build the `onPermissionRequest` callback for Copilot SDK session config.
 *
 * The returned handler delegates tool approval to the connector's bus RPC
 * via {@link PermissionHandlerDelegate}, keeping the factory function
 * independent of the connector class.
 * @param delegate - Connector-supplied callbacks for bus RPC and error handling
 * @returns `PermissionHandler` suitable for `SessionConfig.onPermissionRequest`
 */
export function buildPermissionHandler(delegate: PermissionHandlerDelegate): PermissionHandler {
  return async (input: PermissionRequest) => {
    const coreRequest = mapPermissionRequestToCoreRequest(input);

    try {
      const response = await delegate.requestToolApproval(GitHubCopilotConnectorSubjects.can_use_tool, coreRequest);

      if (response.action === 'allow') {
        return mapCoreResponseToPermissionResult(response);
      }

      // For hard denial (shouldAbort: true), notify the connector so it can
      // terminate the message; soft denials return the SDK denial result only.
      delegate.handleToolApprovalDenied(response.shouldAbort ? 'handled' : 'not_requested', coreRequest.toolName);

      return mapCoreResponseToPermissionResult(response);
    } catch (error) {
      const normalizedError = normalizeToolApprovalError(error);
      delegate.handleError(normalizedError, false);
      // Return denial directly — the approval routing failed, so this is an
      // error condition, not an interactive denial. Falling through to
      // handleToolApprovalDenied would duplicate callbacks and replace the
      // original failure with a synthetic denial signal.
      return { kind: 'denied-interactively-by-user' };
    }
  };
}
