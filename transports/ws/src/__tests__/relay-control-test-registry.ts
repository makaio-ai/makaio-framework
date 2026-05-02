import { createRelayControlHelpers } from '../relay-control-envelope.js';
import { createRelayControlRegistry } from '../relay-control-registry.js';

/**
 * Build the frozen relay-control registry used across transport tests.
 * Mirrors the host relay registrations.
 */
export function buildRelayControlTestRegistry() {
  const registry = createRelayControlRegistry();
  registry.registerEventSubjects('relay', [
    'error',
    'metrics.connection',
    'connection.stateChanged',
    'webhook.github',
    'oauth.github',
    'manifest',
    'cron.fired',
  ]);
  registry.registerRequestNamespace('tunnel', [
    'http.request',
    'register',
    'unregister',
    'list',
    'setAccessLevel',
    'share.create',
    'share.revoke',
    'share.list',
  ]);
  registry.registerRequestNamespace('device', ['relay.verify']);
  registry.registerRequestNamespace('relay', ['oauth.refresh']);
  registry.freeze();
  return registry;
}

export function createRelayControlTestHelpers(registry = buildRelayControlTestRegistry()) {
  return createRelayControlHelpers(registry);
}
