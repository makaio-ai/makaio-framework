import { probeHealth as probeHealthUrl, type HealthResult } from '@makaio/utils/health-probe';

export type { HealthResult };

/**
 * Probe a running Makaio instance on the given port.
 * @param port - Port to probe.
 * @returns Health result if instance is alive, null otherwise.
 */
export async function probeHealth(port: number): Promise<HealthResult | null> {
  return probeHealthUrl(`http://127.0.0.1:${port}/health`);
}
