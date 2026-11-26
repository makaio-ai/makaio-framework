/**
 * Check a composition-owned ingress verifier without letting an exception
 * escape the host upgrade handler.
 * @param request - Native upgrade request delivered by the host.
 * @param verify - Host verification policy for the protected ingress.
 * @returns Whether the verifier established encrypted connection evidence.
 */
export function verifyConnectionExchangeIngress<Request>(
  request: Request,
  verify: ((request: Request) => boolean) | undefined,
): boolean {
  try {
    return verify?.(request) === true;
  } catch {
    return false;
  }
}
