import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { IConfigStorage } from '@makaio/core';
import { ConfigProvider } from '@makaio/providers';
import type { Config } from '@makaio/contracts';
import { loadOrCreateMachineIdentity } from '@makaio/machine-identity';

/**
 * Node.js-specific config provider.
 *
 * Extends ConfigProvider with Node.js platform features:
 * - Machine ID derived from `{makaioHome}/keys/machine.id` via loadOrCreateMachineIdentity
 * - Environment variable access via process.env
 * - Auto-generates bus.remote.secret if missing
 *
 * Storage is delegated to the provided IConfigStorage implementation
 * (typically FileConfigStorage for Node.js).
 */
export class NodeRuntimeProvider extends ConfigProvider {
  private readonly keysDir: string;

  /**
   * Create a Node.js config provider.
   * @param storage - Storage implementation (e.g., FileConfigStorage).
   * @param makaioHome - Resolved `.makaio` home directory (e.g. `~/.makaio`).
   *   Keys are stored under `{makaioHome}/keys`.
   */
  public constructor(storage: IConfigStorage<Config>, makaioHome: string) {
    super(storage);
    this.keysDir = path.join(makaioHome, 'keys');
  }

  /**
   * Get config with Node.js-specific enhancements.
   *
   * Adds auto-generation of bus.remote.secret if remote config exists
   * but no secret is present.
   * @param overrides - Optional config overrides
   * @returns Validated runtime configuration
   */
  public override async getConfig(overrides?: Partial<Config>): Promise<Config> {
    const config = await super.getConfig(overrides);

    // Auto-generate secret if remote config exists without secret
    if (config.bus?.remote && !config.bus.remote.secret) {
      config.bus.remote.secret = this.generateSecret();
      // Save the updated config with the new secret
      await this.saveConfig(config);
    }

    return config;
  }

  /**
   * Generate secure random secret for bus authentication.
   * @returns A base64-encoded random secret
   */
  private generateSecret(): string {
    return crypto.randomBytes(32).toString('base64');
  }

  /**
   * Get or create persistent machine identifier.
   * Delegates to loadOrCreateMachineIdentity which manages ~/.makaio/keys/machine.id
   * along with the full ECDH/ECDSA keypair.
   * @returns The unique machine identifier (UUID)
   */
  public override async getMachineId(): Promise<string> {
    const identity = await loadOrCreateMachineIdentity(this.keysDir);
    return identity.machineId;
  }

  /**
   * Get environment variable value (Node.js implementation).
   * @param key - The environment variable name
   * @returns The environment variable value or undefined
   */
  protected override getEnv(key: string): string | undefined {
    return process.env[key];
  }
}
