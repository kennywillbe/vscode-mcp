export type PrivilegedCapability = 'write' | 'execution';

export interface CapabilityGrantSnapshot {
  readonly write: boolean;
  readonly execution: boolean;
  readonly writeGeneration: number;
  readonly executionGeneration: number;
}

export interface CapabilityGrantToken {
  readonly capability: PrivilegedCapability;
  readonly generation: number;
}

/**
 * Owns privileged authority for one extension-host lifetime. Nothing is persisted:
 * reload, disable, workspace identity changes, or disposal revoke every grant.
 */
export class CapabilityGrantController {
  #write = false;
  #execution = false;
  #writeGeneration = 0;
  #executionGeneration = 0;
  #disposed = false;

  public snapshot(): CapabilityGrantSnapshot {
    return {
      write: this.#write,
      execution: this.#execution,
      writeGeneration: this.#writeGeneration,
      executionGeneration: this.#executionGeneration,
    };
  }

  public grant(capability: PrivilegedCapability): CapabilityGrantToken {
    this.assertLive();
    if (capability === 'write') {
      if (!this.#write) {
        this.#write = true;
        this.#writeGeneration += 1;
      }
      return { capability, generation: this.#writeGeneration };
    }
    if (!this.#execution) {
      this.#execution = true;
      this.#executionGeneration += 1;
    }
    return { capability, generation: this.#executionGeneration };
  }

  public revoke(capability: PrivilegedCapability): void {
    if (this.#disposed) {
      return;
    }
    if (capability === 'write') {
      if (this.#write) {
        this.#write = false;
        this.#writeGeneration += 1;
      }
      return;
    }
    if (this.#execution) {
      this.#execution = false;
      this.#executionGeneration += 1;
    }
  }

  public revokeAll(): void {
    this.revoke('write');
    this.revoke('execution');
  }

  public capture(capability: PrivilegedCapability): CapabilityGrantToken | null {
    if (this.#disposed) {
      return null;
    }
    const state = this.snapshot();
    if (capability === 'write') {
      return state.write ? { capability, generation: state.writeGeneration } : null;
    }
    return state.execution
      ? { capability, generation: state.executionGeneration }
      : null;
  }

  public isCurrent(token: CapabilityGrantToken): boolean {
    if (this.#disposed) {
      return false;
    }
    const state = this.snapshot();
    return token.capability === 'write'
      ? state.write && state.writeGeneration === token.generation
      : state.execution && state.executionGeneration === token.generation;
  }

  public dispose(): void {
    if (!this.#disposed) {
      this.revokeAll();
      this.#disposed = true;
    }
  }

  private assertLive(): void {
    if (this.#disposed) {
      throw new Error('The capability grant controller is disposed.');
    }
  }
}
