/**
 * Machine identity resolved by the platform.
 */
export interface MachineIdentity {
  /** Unique machine identifier. */
  readonly machineId: string;
}

/**
 * Platform-specific machine identity resolution.
 * Node: persisted in ~/.makaio/keys/
 * Container/Framework: ephemeral crypto.randomUUID()
 */
export interface IdentityProvider {
  /** Load or generate the machine identity. */
  load(): Promise<MachineIdentity>;
}
