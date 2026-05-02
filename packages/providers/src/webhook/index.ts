/**
 * Webhook provider interface
 *
 * Handles incoming webhooks from platforms (GitHub, GitLab, etc.)
 */
import { type IMakaioBus } from '@makaio/bus-core';

/**
 * Webhook event structure
 */
export type WebhookEvent = {
  platform: string;
  event: string;
  action?: string;
  data: unknown;
};

/**
 * Webhook provider interface
 *
 * Handles incoming webhooks from platforms (GitHub, GitLab, etc.)
 */
export interface IWebhookProvider {
  readonly capabilities: {
    platform: 'github' | 'gitlab' | 'gitea' | 'bitbucket';
    supportedEvents: string[];
  };

  verifySignature(payload: string, signature: string): Promise<boolean>;
  parseWebhook(payload: unknown): Promise<WebhookEvent>;
  registerHandlers(bus: IMakaioBus): void;
}
