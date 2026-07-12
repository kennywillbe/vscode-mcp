export class BoundedReadScheduler {
  readonly #limit: number;
  readonly #waiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly signal: AbortSignal;
    readonly abort: () => void;
  }> = [];
  #active = 0;

  public constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('A positive read-concurrency limit is required.');
    }
    this.#limit = limit;
  }

  public async run<Value>(
    signal: AbortSignal,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    await this.acquire(signal);
    try {
      if (signal.aborted) {
        throw cancelled();
      }
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw cancelled();
    }
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: (): void => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) {
            this.#waiters.splice(index, 1);
          }
          reject(cancelled());
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  private release(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#active -= 1;
      return;
    }
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  }
}

function cancelled(): Error {
  const error = new Error('The scheduled read was cancelled.');
  error.name = 'AbortError';
  return error;
}
