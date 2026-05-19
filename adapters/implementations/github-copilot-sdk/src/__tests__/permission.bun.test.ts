/// <reference types="bun-types" />
import { describe, expect, it, mock } from 'bun:test';
import { NoHandlerError } from '@makaio/bus-core';
import type { PermissionRequest } from '@github/copilot-sdk';
import type { AgentToolApproveResponse } from '@makaio/contracts';
import { buildPermissionHandler, type PermissionHandlerDelegate } from '../permission.js';

/**
 * Create a minimal SDK permission request accepted by the adapter mapper.
 * @returns Shell permission request fixture
 */
function makePermissionRequest(): PermissionRequest {
  return {
    kind: 'shell',
    fullCommandText: 'echo ok',
    intention: 'verify approval handling',
  };
}

/**
 * Create a delegate for permission-handler tests.
 * @param requestToolApproval - Approval callback under test
 * @returns Permission handler delegate with spies
 */
function makeDelegate(requestToolApproval: PermissionHandlerDelegate['requestToolApproval']): {
  requestToolApproval: PermissionHandlerDelegate['requestToolApproval'];
  handleError: ReturnType<typeof mock<PermissionHandlerDelegate['handleError']>>;
  handleToolApprovalDenied: ReturnType<typeof mock<PermissionHandlerDelegate['handleToolApprovalDenied']>>;
} {
  return {
    requestToolApproval,
    handleError: mock<PermissionHandlerDelegate['handleError']>(),
    handleToolApprovalDenied: mock<PermissionHandlerDelegate['handleToolApprovalDenied']>(),
  };
}

describe('buildPermissionHandler', () => {
  it('normalizes synchronous approval throws into aborting denials', async () => {
    const delegate = makeDelegate(() => {
      throw new NoHandlerError('adapter:github-copilot.can_use_tool');
    });
    const handler = buildPermissionHandler(delegate);

    const result = await handler(makePermissionRequest(), { sessionId: 'session-1' });

    expect(result).toEqual({ kind: 'denied-interactively-by-user' });
    expect(delegate.handleError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Tool approval request failed, make sure that there's a handler registered"),
      }),
      false,
    );
    // Error path must not trigger handleToolApprovalDenied: the routing failure
    // is already reported via handleError; a second denial callback would
    // duplicate logging and replace the original error with a synthetic signal.
    expect(delegate.handleToolApprovalDenied).not.toHaveBeenCalled();
  });

  it('normalizes rejected non-Error approval failures into aborting denials', async () => {
    const delegate = makeDelegate(async () => Promise.reject('approval unavailable'));
    const handler = buildPermissionHandler(delegate);

    const result = await handler(makePermissionRequest(), { sessionId: 'session-1' });

    expect(result).toEqual({ kind: 'denied-interactively-by-user' });
    expect(delegate.handleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'approval unavailable' }),
      false,
    );
    // Error path must not trigger handleToolApprovalDenied (same invariant as above).
    expect(delegate.handleToolApprovalDenied).not.toHaveBeenCalled();
  });

  it('notifies hard denials returned by approval routing', async () => {
    const response: AgentToolApproveResponse = {
      action: 'deny',
      shouldAbort: true,
      message: 'Denied by policy.',
    };
    const delegate = makeDelegate(async () => response);
    const handler = buildPermissionHandler(delegate);

    const result = await handler(makePermissionRequest(), { sessionId: 'session-1' });

    expect(result).toEqual({ kind: 'denied-interactively-by-user' });
    expect(delegate.handleError).not.toHaveBeenCalled();
    expect(delegate.handleToolApprovalDenied).toHaveBeenCalledWith('handled', 'bash');
  });
});
