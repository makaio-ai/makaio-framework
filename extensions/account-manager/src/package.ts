import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { parseExtensionConfig, type MakaioExtension } from '@makaio/contracts';
import { AccountManager } from './account-manager.js';
import { ClaudeCodeSource } from './sources/claude-code-source.js';
import { CodexSource } from './sources/codex-source.js';
import { SecurityCliBackend } from './backends/security-cli-backend.js';
import { FileBackend } from './backends/file-backend.js';
import { DarwinAccountStore } from './stores/darwin-account-store.js';
import { PlaintextAccountStore } from './stores/plaintext-account-store.js';
import {
  BusAccountMetadataStore,
  BusAccountUsageSnapshotStore,
  registerDrizzleAccountManagerStorage,
} from './storage/index.js';
import { accountManagerCli } from './cli/index.js';
import { hasEnabledAutoActivationSource, type AutoActivationConfig } from './account-manager-types.js';

const USAGE_MIN_FETCH_INTERVAL_MS = 60_000;
const USAGE_ACTIVE_INTERVAL_MS = 2 * 60_000;
const USAGE_INACTIVE_INTERVAL_MS = 5 * 60_000;
const USAGE_JITTER_MS = 5_000;
const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const MIGRATION_SOURCE_ID = 'framework/extensions/account-manager/src/drizzle';

const AccountManagerConfigSchema = z.object({
  /**
   * Host CLI command used to compare expected client wiring entries.
   *
   * Hosts provide this through package config so health checks evaluate the
   * launcher users actually install.
   */
  makaioCommand: z.string().min(1),
  autoActivation: z
    .object({
      sources: z.record(z.string(), z.object({ enabled: z.boolean().default(false) })).default({}),
      systemPrompt: z.string().trim().min(1).default('Reply concisely.'),
      message: z.string().trim().min(1).default('ok'),
    })
    .default(() => ({ sources: {}, systemPrompt: 'Reply concisely.', message: 'ok' })),
});

/**
 * Account Manager micro app package manifest.
 *
 * Self-contained package that owns all internal composition — backend
 * selection, source construction, and store instantiation are based on
 * the platform context provided by the host runtime.
 */
export const accountManagerPackage: MakaioExtension = {
  name: 'account-manager',
  displayName: 'Makaio Account Manager',
  dependencies: ['makaio.clients-core'],
  storage: {
    migrations: 'drizzle',
    packageRoot: PACKAGE_ROOT,
    migrationSourceId: MIGRATION_SOURCE_ID,
    registerHandlers: registerDrizzleHandlers(registerDrizzleAccountManagerStorage),
  },

  browser: {
    entrypoint: '/extensions/account-manager/browser/index.js',
  },
  configSchema: AccountManagerConfigSchema,

  create: (ctx) => {
    const config = parseExtensionConfig(AccountManagerConfigSchema, ctx.config);
    const claudeHome = join(ctx.homedir, '.claude');
    const codexHome = join(ctx.homedir, '.codex');
    const storeDir = ctx.dataDir;

    const claudeBackend =
      ctx.platform === 'darwin'
        ? new SecurityCliBackend('Claude Code-credentials', ctx.username)
        : new FileBackend(join(claudeHome, '.credentials.json'));

    const codexBackend = new FileBackend(join(codexHome, 'auth.json'));

    const store =
      ctx.platform === 'darwin'
        ? new DarwinAccountStore(join(storeDir, 'accounts.enc'))
        : new PlaintextAccountStore(join(storeDir, 'accounts.json'));
    const metadataStore = new BusAccountMetadataStore(ctx.bus);
    const usageSnapshotStore = new BusAccountUsageSnapshotStore(ctx.bus);

    const parsedAutoActivation: AutoActivationConfig = {
      sources: new Map(Object.entries(config.autoActivation.sources).map(([k, v]) => [k, { enabled: v.enabled }])),
      systemPrompt: config.autoActivation.systemPrompt,
      message: config.autoActivation.message,
    };
    const autoActivation = hasEnabledAutoActivationSource(parsedAutoActivation) ? parsedAutoActivation : undefined;

    return new AccountManager(ctx.bus, {
      sources: [
        new ClaudeCodeSource(claudeBackend, { installDir: claudeHome }),
        new CodexSource(codexBackend, { codexHome }),
      ],
      credentialStore: store,
      metadataStore,
      usageSnapshotStore,
      makaioCommand: config.makaioCommand,
      autoActivation,
      usageSourceConfigs: new Map(
        ['claude-code', 'codex'].map((id) => [
          id,
          {
            minFetchIntervalMs: USAGE_MIN_FETCH_INTERVAL_MS,
            activeIntervalMs: USAGE_ACTIVE_INTERVAL_MS,
            inactiveIntervalMs: USAGE_INACTIVE_INTERVAL_MS,
            jitterMs: USAGE_JITTER_MS,
          },
        ]),
      ),
    });
  },

  cli: accountManagerCli,
};
