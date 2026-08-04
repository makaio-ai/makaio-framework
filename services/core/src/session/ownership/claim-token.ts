/**
 * Mint the identity of one claim generation.
 *
 * The single way a generation identity comes into existence, whether the
 * authority mints it or a caller mints one to name its own settlement with.
 * Re-using a token whose generation is *retired* is a caller bug storage cannot
 * defend against: retired generations are not remembered, so a released token
 * is storable again and how it interacts with later generations is undefined.
 * Re-offering an *unused* token — what the settle retry does — is not that: a
 * rolled-back attempt left no row behind for it to collide with.
 * @returns An opaque, single-use claim token.
 */
export function mintClaimToken(): string {
  return crypto.randomUUID();
}
