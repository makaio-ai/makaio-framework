/**
 * Handler entry with priority for middleware-style ordering.
 * Higher priority values run earlier in the handler chain.
 */
export interface HandlerEntry<H> {
  handler: H;
  priority: number;
}
