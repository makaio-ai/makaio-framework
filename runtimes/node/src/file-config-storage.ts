import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { IConfigStorage } from '@makaio/core';
import { ConfigSchema, type Config } from '@makaio/contracts';

/**
 * File-based config storage for Node.js runtime.
 *
 * Reads/writes `<makaioHome>/config.json` for bootstrap configuration.
 * Returns default config if file is missing.
 */
export class FileConfigStorage implements IConfigStorage<Config> {
  private readonly configPath: string;

  /**
   * Create a new FileConfigStorage instance.
   * @param makaioHome - Makaio home directory (e.g. `~/.makaio`). The config
   *   file is stored as `config.json` inside this directory.
   */
  public constructor(makaioHome: string) {
    this.configPath = path.join(makaioHome, 'config.json');
  }

  /**
   * Get the current config.
   * Returns default config (applying Zod defaults) if file doesn't exist.
   * @returns The config object
   */
  public async getConfig(): Promise<Config> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      return ConfigSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Return default config, applying Zod defaults
        return ConfigSchema.parse({});
      }
      if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
        console.warn('[FileConfigStorage] Failed to parse config, falling back to defaults:', error);
        return ConfigSchema.parse({});
      }
      throw error;
    }
  }

  /**
   * Save the config.
   * Creates directory if it doesn't exist.
   * @param config - The config object to save
   */
  public async saveConfig(config: Config): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // Ensure permissions on existing files as well.
    await fs.chmod(this.configPath, 0o600);
  }
}
