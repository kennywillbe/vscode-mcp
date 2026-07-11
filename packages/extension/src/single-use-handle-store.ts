export type HandleTakeResult<Value> =
  | { readonly status: 'ok'; readonly value: Value }
  | { readonly status: 'missing' | 'expired' | 'authorityChanged' };

interface HandleRecord<Value> {
  readonly value: Value;
  readonly generation: number;
  readonly workspaceFingerprint: string;
  readonly expiresAt: number;
}

interface HandleStoreOptions {
  readonly maximumHandles: number;
  readonly lifetimeMs: number;
  readonly createToken: () => string;
  readonly now?: () => number;
}

/** Memory-only, bounded, single-use authority-bound handle storage. */
export class SingleUseHandleStore<Value> {
  readonly #records = new Map<string, HandleRecord<Value>>();
  readonly #options: HandleStoreOptions;
  readonly #now: () => number;

  public constructor(options: HandleStoreOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  public create(
    value: Value,
    generation: number,
    workspaceFingerprint: string,
  ): string | null {
    this.removeExpired();
    if (this.#records.size >= this.#options.maximumHandles) return null;
    const token = this.#options.createToken();
    if (this.#records.has(token)) return null;
    this.#records.set(token, {
      value,
      generation,
      workspaceFingerprint,
      expiresAt: this.#now() + this.#options.lifetimeMs,
    });
    return token;
  }

  public take(
    token: string,
    generation: number,
    workspaceFingerprint: string,
  ): HandleTakeResult<Value> {
    const record = this.#records.get(token);
    this.#records.delete(token);
    if (record === undefined) return { status: 'missing' };
    if (record.expiresAt < this.#now()) return { status: 'expired' };
    if (
      record.generation !== generation ||
      record.workspaceFingerprint !== workspaceFingerprint
    )
      return { status: 'authorityChanged' };
    return { status: 'ok', value: record.value };
  }

  public clear(): void {
    this.#records.clear();
  }

  private removeExpired(): void {
    const now = this.#now();
    for (const [token, record] of this.#records) {
      if (record.expiresAt < now) this.#records.delete(token);
    }
  }
}
