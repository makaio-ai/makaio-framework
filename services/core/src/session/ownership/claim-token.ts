/**
 * Mint the identity of one claim generation.
 *
 * The single call site of token creation in the authority, so "a fresh random
 * token per attempt" is a property of the code rather than a rule every caller
 * has to remember. Reuse is a caller bug storage cannot defend against: retired
 * generations are not remembered, so a token that has been released is storable
 * again and how it interacts with later generations is undefined.
 * @returns An opaque, single-use claim token.
 */
export function mintClaimToken(): string {
  return crypto.randomUUID();
}
