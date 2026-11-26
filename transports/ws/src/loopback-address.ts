/**
 * Whether a bound TCP address is an accepted loopback literal.
 * @param address - Native listener address.
 * @returns Whether the address is restricted to the local host.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
