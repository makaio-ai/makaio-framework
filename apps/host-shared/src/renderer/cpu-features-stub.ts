/**
 * Browser stub for cpu-features native module.
 * @returns Empty CPU info object for browser bundles.
 */
export function getCPUInfo(): Record<string, unknown> {
  return {};
}

export default getCPUInfo;
