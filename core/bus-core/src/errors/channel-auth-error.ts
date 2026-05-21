import { BusError } from './bus-error.js';

/**
 * Thrown when channel authentication fails during the handshake.
 * Indicates the provided token does not match the endpoint's expected token.
 */
export class ChannelAuthError extends BusError {
  /**
   * @param endpoint - The endpoint name that failed authentication
   */
  public constructor(endpoint: string) {
    super(`Authentication failed for channel endpoint "${endpoint}"`, endpoint);
    this.name = 'ChannelAuthError';
  }
}
