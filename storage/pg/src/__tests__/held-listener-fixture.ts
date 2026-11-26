import { createNodePgClient } from '../client.js';
import type { PostgresDriverModule } from '../pg-signal-client.js';

/** Test-only control for a dedicated PostgreSQL listener's reconnect. */
export interface HeldListenerOptions {
  readonly applicationName: string;
  readonly beforeReconnect: () => Promise<void>;
}

/**
 * Open a real PostgreSQL pool and signal capability with a gated reconnect.
 * @param url - Isolated test database.
 * @param options - Tag for the dedicated listener and gate before opening its replacement socket.
 * @returns Client usable through the regular database and signal facades.
 */
export async function openPostgresWithHeldListener(url: string, options: HeldListenerOptions) {
  const { default: pg }: { default: PostgresDriverModule } = await import('pg');
  let attempts = 0;
  class HeldListener extends pg.Client {
    public constructor({ connectionString }: { connectionString: string }) {
      const named = new URL(connectionString);
      // Keep the schema's percent-encoded search_path intact.
      named.search += `${named.search === '' ? '?' : '&'}application_name=${encodeURIComponent(options.applicationName)}`;
      super({ connectionString: named.href });
    }

    public override async connect(): Promise<void> {
      if (attempts++ > 0) await options.beforeReconnect();
      await super.connect();
    }
  }
  return createNodePgClient(url, undefined, {
    loadPg: async () => ({ default: { Pool: pg.Pool, Client: HeldListener } }),
    loadDrizzlePg: () => import('drizzle-orm/node-postgres'),
  });
}
