/**
 * Re-exports subscribe/unsubscribe message builders from bus-core.
 *
 * These utilities have been consolidated into `@makaio/bus-core` so that any
 * transport implementation can reuse them without taking a dependency on the
 * WebSocket transport package.
 */

export { buildSubscribeMessage, buildUnsubscribeMessage, type SubscriptionEntry } from '@makaio/bus-core';
