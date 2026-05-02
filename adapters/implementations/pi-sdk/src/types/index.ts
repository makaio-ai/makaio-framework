import type { BaseAgentConnectorConfig } from '@makaio/ai-adapters-core';
import type { PiSdkBus } from '../namespaces/index.js';
import type { PiSdkProviderConfig } from '../schemas.js';

/** Stable bus namespace identifier for the Pi SDK adapter. */
export const PI_SDK_NAMESPACE = 'adapter:piSdk' as const;

/**
 * Pi SDK thinking level values.
 *
 * These mirror `ThinkingLevel` from `@mariozechner/pi-agent-core` and are
 * inlined here to avoid a direct dependency on the transitive package.
 * The connector casts this to `ThinkingLevel` when creating a session.
 */
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Pi SDK connector configuration.
 *
 * Extends {@link BaseAgentConnectorConfig} with the Pi-specific scoped bus and
 * provider config. The `providerConfig` field is typed to `PiSdkProviderConfig`
 * rather than using the generic parameter so this type is structurally
 * assignable from the factory-provided `BaseAgentConnectorConfig<PiSdkBus> & { adapterId: string }`.
 * `cwd` and `model` are inherited from `BaseAgentConnectorConfig`.
 */
export type PiConnectorConfig = Omit<BaseAgentConnectorConfig<PiSdkBus>, 'providerConfig'> & {
  adapterId: string;
  providerConfig?: PiSdkProviderConfig;
};
