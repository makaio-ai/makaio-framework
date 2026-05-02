/**
 * Browser stub for ssh2.
 */

/**
 * Throw a consistent error for renderer code paths that accidentally touch ssh2.
 */
function unsupported(): never {
  throw new Error('ssh2 Client is unavailable in the Electrobun renderer.');
}

/** Fail fast when renderer code accidentally reaches the Node-only ssh2 seam. */
export class Client {
  public constructor() {
    unsupported();
  }
}

const ssh2Stub = { Client };
export default ssh2Stub;
