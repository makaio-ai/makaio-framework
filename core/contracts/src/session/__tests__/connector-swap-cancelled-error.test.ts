import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_SWAP_CANCELLED_CODE,
  ConnectorSwapCancelledError,
  isConnectorSwapCancelledError,
} from '../connector-swap-cancelled-error.js';

describe('isConnectorSwapCancelledError', () => {
  it('returns true for ConnectorSwapCancelledError instances', () => {
    expect(isConnectorSwapCancelledError(new ConnectorSwapCancelledError())).toBe(true);
  });

  it('returns true for transported errors that only preserve code', () => {
    const transportedError = new Error('Connector swap cancelled by user');
    (transportedError as Error & { code?: string }).code = CONNECTOR_SWAP_CANCELLED_CODE;

    expect(isConnectorSwapCancelledError(transportedError)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isConnectorSwapCancelledError(new Error('Different error'))).toBe(false);
  });
});
