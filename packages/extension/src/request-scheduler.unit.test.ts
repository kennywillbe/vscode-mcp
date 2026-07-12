import { describe, expect, it } from 'vitest';

import {
  RequestScheduler,
  type SchedulerResult,
  type SchedulerRuntime,
  type SchedulerTimer,
} from './request-scheduler.js';

type TimerEntry = {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
};

class FakeSchedulerRuntime implements SchedulerRuntime {
  private currentTime = 0;
  private nextTimerId = 1;
  private readonly timers: TimerEntry[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimer(delayMs: number, callback: () => void): SchedulerTimer {
    const entry: TimerEntry = {
      id: this.nextTimerId,
      dueAt: this.currentTime + delayMs,
      callback,
      cancelled: false,
    };
    this.nextTimerId += 1;
    this.timers.push(entry);
    return {
      cancel: (): void => {
        entry.cancelled = true;
      },
    };
  }

  advanceBy(milliseconds: number): void {
    const targetTime = this.currentTime + milliseconds;
    while (true) {
      let next: TimerEntry | undefined;
      for (const entry of this.timers) {
        if (
          !entry.cancelled &&
          entry.dueAt <= targetTime &&
          (next === undefined ||
            entry.dueAt < next.dueAt ||
            (entry.dueAt === next.dueAt && entry.id < next.id))
        ) {
          next = entry;
        }
      }

      if (next === undefined) {
        break;
      }
      next.cancelled = true;
      this.currentTime = next.dueAt;
      next.callback();
    }
    this.currentTime = targetTime;
  }

  /** Simulates an event-loop stall where a due timer has not run yet. */
  elapseWithoutRunningTimers(milliseconds: number): void {
    this.currentTime += milliseconds;
  }
}

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
};

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value): void => {
      if (resolvePromise === undefined) {
        throw new Error('Deferred promise is not initialized.');
      }
      resolvePromise(value);
    },
    reject: (error): void => {
      if (rejectPromise === undefined) {
        throw new Error('Deferred promise is not initialized.');
      }
      rejectPromise(error);
    },
  };
}

function expectErrorCode<Value>(
  result: SchedulerResult<Value>,
  code: 'SERVER_BUSY' | 'TIMEOUT' | 'CANCELLED',
): void {
  expect(result.outcome).toBe('toolError');
  if (result.outcome === 'toolError') {
    expect(result.error.code).toBe(code);
  }
}

describe('RequestScheduler capacity', () => {
  it('starts four calls for one connection and queues the fifth', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const gates = Array.from({ length: 5 }, () => deferred<string>());
    const started: number[] = [];

    const requests = gates.map((gate, requestId) =>
      scheduler.schedule({
        connectionId: 'a',
        requestId,
        timeoutMs: 5_000,
        execute: () => {
          started.push(requestId);
          return gate.promise;
        },
      }),
    );

    expect(scheduler.activeCountFor('a')).toBe(4);
    expect(scheduler.activeCount).toBe(4);
    expect(scheduler.queuedCount).toBe(1);
    expect(started).toEqual([0, 1, 2, 3]);

    gates[0]?.resolve('zero');
    await requests[0];
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(scheduler.activeCountFor('a')).toBe(4);
    expect(scheduler.queuedCount).toBe(0);

    for (let index = 1; index < gates.length; index += 1) {
      gates[index]?.resolve(String(index));
    }
    await Promise.all(requests);
    expect(scheduler.activeCount).toBe(0);
  });

  it('starts eight calls per window and queues the ninth', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const gates = Array.from({ length: 9 }, () => deferred<string>());
    const started: string[] = [];
    const requests: Array<Promise<SchedulerResult<string>>> = [];

    for (let index = 0; index < 4; index += 1) {
      requests.push(
        scheduler.schedule({
          connectionId: 'a',
          requestId: index,
          timeoutMs: 5_000,
          execute: () => {
            started.push(`a${index}`);
            return gates[index]?.promise ?? Promise.reject(new Error('Missing gate.'));
          },
        }),
      );
      requests.push(
        scheduler.schedule({
          connectionId: 'b',
          requestId: index,
          timeoutMs: 5_000,
          execute: () => {
            started.push(`b${index}`);
            return (
              gates[index + 4]?.promise ?? Promise.reject(new Error('Missing gate.'))
            );
          },
        }),
      );
    }
    requests.push(
      scheduler.schedule({
        connectionId: 'c',
        requestId: 0,
        timeoutMs: 5_000,
        execute: () => {
          started.push('c0');
          return gates[8]?.promise ?? Promise.reject(new Error('Missing gate.'));
        },
      }),
    );

    expect(scheduler.activeCount).toBe(8);
    expect(scheduler.queuedCount).toBe(1);
    expect(started).not.toContain('c0');

    gates[0]?.resolve('a0');
    await requests[0];
    expect(started).toContain('c0');
    expect(scheduler.activeCount).toBe(8);

    scheduler.cancelConnection('a');
    scheduler.cancelConnection('b');
    scheduler.cancelConnection('c');
    await Promise.all(requests);
    expect(scheduler.activeCount).toBe(8);
    for (const gate of gates) {
      gate.resolve('settled');
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.activeCount).toBe(0);
  });

  it('accepts sixteen queued calls and rejects the seventeenth as SERVER_BUSY', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const activeGates = Array.from({ length: 8 }, () => deferred<string>());
    const requests: Array<Promise<SchedulerResult<string>>> = [];

    for (let index = 0; index < 4; index += 1) {
      requests.push(
        scheduler.schedule({
          connectionId: 'a',
          requestId: index,
          timeoutMs: 5_000,
          execute: () =>
            activeGates[index]?.promise ?? Promise.reject(new Error('Missing gate.')),
        }),
      );
      requests.push(
        scheduler.schedule({
          connectionId: 'b',
          requestId: index,
          timeoutMs: 5_000,
          execute: () =>
            activeGates[index + 4]?.promise ??
            Promise.reject(new Error('Missing gate.')),
        }),
      );
    }

    for (let index = 0; index < 16; index += 1) {
      const connectionId = index % 2 === 0 ? 'a' : 'b';
      requests.push(
        scheduler.schedule({
          connectionId,
          requestId: 4 + index,
          timeoutMs: 5_000,
          execute: () => new Promise<string>(() => undefined),
        }),
      );
    }

    expect(scheduler.activeCount).toBe(8);
    expect(scheduler.queuedCount).toBe(16);

    const rejected = await scheduler.schedule({
      connectionId: 'c',
      requestId: 0,
      timeoutMs: 5_000,
      execute: () => Promise.resolve('must not run'),
    });
    expect(rejected).toEqual({
      outcome: 'toolError',
      error: {
        code: 'SERVER_BUSY',
        message: 'The VS Code MCP request queue is full.',
        retryable: true,
      },
    });
    expect(scheduler.queuedCount).toBe(16);

    scheduler.cancelConnection('a');
    scheduler.cancelConnection('b');
    await Promise.all(requests);
    expect(scheduler.activeCount).toBe(8);
    for (const gate of activeGates) {
      gate.resolve('settled');
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.activeCount).toBe(0);
  });
});

describe('RequestScheduler FIFO admission', () => {
  it('starts the oldest eligible request without head-of-line blocking', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const gates = new Map<string, Deferred<string>>();
    const started: string[] = [];
    const requests: Array<Promise<SchedulerResult<string>>> = [];

    const submit = (connectionId: string, requestId: number, label: string): void => {
      const gate = deferred<string>();
      gates.set(label, gate);
      requests.push(
        scheduler.schedule({
          connectionId,
          requestId,
          timeoutMs: 5_000,
          execute: () => {
            started.push(label);
            return gate.promise;
          },
        }),
      );
    };

    for (let index = 0; index < 4; index += 1) {
      submit('a', index, `a${index}`);
      submit('b', index, `b${index}`);
    }
    submit('a', 4, 'a4');
    submit('b', 4, 'b4');
    submit('a', 5, 'a5');

    gates.get('b0')?.resolve('b0');
    await requests[1];
    expect(started.at(-1)).toBe('b4');

    gates.get('a0')?.resolve('a0');
    await requests[0];
    expect(started.at(-1)).toBe('a4');

    gates.get('a1')?.resolve('a1');
    await requests[2];
    expect(started.at(-1)).toBe('a5');

    scheduler.cancelConnection('a');
    scheduler.cancelConnection('b');
    await Promise.all(requests);
    for (const gate of gates.values()) {
      gate.resolve('settled');
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.activeCount).toBe(0);
  });
});

describe('RequestScheduler deadlines and cancellation', () => {
  it('times out a queued request from its original receive time', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const activeRequests: Array<Promise<SchedulerResult<string>>> = [];
    let queuedStarted = false;

    for (let requestId = 0; requestId < 4; requestId += 1) {
      activeRequests.push(
        scheduler.schedule({
          connectionId: 'a',
          requestId,
          timeoutMs: 1_000,
          execute: () => new Promise<string>(() => undefined),
        }),
      );
    }
    const queued = scheduler.schedule({
      connectionId: 'a',
      requestId: 4,
      timeoutMs: 100,
      execute: () => {
        queuedStarted = true;
        return Promise.resolve('unexpected');
      },
    });

    runtime.advanceBy(100);
    const result = await queued;
    expect(result).toEqual({
      outcome: 'toolError',
      error: {
        code: 'TIMEOUT',
        message: 'The VS Code MCP request timed out.',
        retryable: true,
      },
    });
    expect(queuedStarted).toBe(false);
    expect(scheduler.queuedCount).toBe(0);

    scheduler.cancelConnection('a');
    await Promise.all(activeRequests);
    expect(scheduler.activeCount).toBe(4);
  });

  it('cancels a queued request without starting its handler', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const activeRequests: Array<Promise<SchedulerResult<string>>> = [];
    let queuedStarted = false;

    for (let requestId = 0; requestId < 4; requestId += 1) {
      activeRequests.push(
        scheduler.schedule({
          connectionId: 'a',
          requestId,
          timeoutMs: 1_000,
          execute: () => new Promise<string>(() => undefined),
        }),
      );
    }
    const queued = scheduler.schedule({
      connectionId: 'a',
      requestId: 4,
      timeoutMs: 1_000,
      execute: () => {
        queuedStarted = true;
        return Promise.resolve('unexpected');
      },
    });

    expect(scheduler.cancel('a', 4)).toBe(true);
    const result = await queued;
    expectErrorCode(result, 'CANCELLED');
    expect(queuedStarted).toBe(false);
    expect(scheduler.cancel('a', 4)).toBe(false);

    scheduler.cancelConnection('a');
    await Promise.all(activeRequests);
    expect(scheduler.activeCount).toBe(4);
  });

  it('aborts an active timeout and discards its late completion', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    let terminalCount = 0;
    const request = scheduler
      .schedule({
        connectionId: 'a',
        requestId: 0,
        timeoutMs: 100,
        execute: (context) => {
          signal = context.signal;
          return gate.promise;
        },
      })
      .then((result) => {
        terminalCount += 1;
        return result;
      });

    runtime.advanceBy(100);
    const result = await request;
    expectErrorCode(result, 'TIMEOUT');
    expect(signal?.aborted).toBe(true);
    expect(scheduler.activeCount).toBe(1);

    gate.resolve('late content');
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalCount).toBe(1);
    expect(scheduler.activeCount).toBe(0);
  });

  it('classifies completion and rejection after the absolute deadline as TIMEOUT', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);

    const completedGate = deferred<string>();
    const completed = scheduler.schedule({
      connectionId: 'a',
      requestId: 0,
      timeoutMs: 100,
      execute: () => completedGate.promise,
    });
    runtime.elapseWithoutRunningTimers(101);
    completedGate.resolve('late success');
    expectErrorCode(await completed, 'TIMEOUT');
    expect(scheduler.activeCount).toBe(0);

    const rejectedGate = deferred<string>();
    const rejected = scheduler.schedule({
      connectionId: 'a',
      requestId: 1,
      timeoutMs: 100,
      execute: () => rejectedGate.promise,
    });
    runtime.elapseWithoutRunningTimers(101);
    rejectedGate.reject(new Error('late failure'));
    expectErrorCode(await rejected, 'TIMEOUT');
    expect(scheduler.activeCount).toBe(0);

    // Deliver both delayed timer callbacks after execution settlement. They must not
    // create a second terminal result or corrupt accounting.
    runtime.advanceBy(0);
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.requestCountFor('a')).toBe(0);
  });

  it('keeps provider work bounded across repeated disconnect/cancel waves', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const activeGates = Array.from({ length: 8 }, () => deferred<string>());
    let executionsInFlight = 0;
    let maximumExecutionsInFlight = 0;
    let executionStarts = 0;
    const trackedExecutions: Array<Promise<string>> = [];

    const trackedExecution = (gate: Deferred<string>): Promise<string> => {
      executionStarts += 1;
      executionsInFlight += 1;
      maximumExecutionsInFlight = Math.max(
        maximumExecutionsInFlight,
        executionsInFlight,
      );
      const execution = gate.promise.finally(() => {
        executionsInFlight -= 1;
      });
      trackedExecutions.push(execution);
      return execution;
    };

    const activeRequests: Array<Promise<SchedulerResult<string>>> = [];
    for (let index = 0; index < activeGates.length; index += 1) {
      const gate = activeGates[index];
      if (gate === undefined) {
        throw new Error('Missing active provider gate.');
      }
      activeRequests.push(
        scheduler.schedule({
          connectionId: index < 4 ? 'a' : 'b',
          requestId: index % 4,
          timeoutMs: 10_000,
          execute: () => trackedExecution(gate),
        }),
      );
    }
    expect(scheduler.activeCount).toBe(8);

    expect(scheduler.cancelConnection('a')).toBe(4);
    expect(scheduler.cancelConnection('b')).toBe(4);
    await Promise.all(activeRequests);
    expect(scheduler.activeCount).toBe(8);
    expect(scheduler.requestCountFor('a')).toBe(0);
    expect(scheduler.requestCountFor('b')).toBe(0);

    for (let wave = 0; wave < 10; wave += 1) {
      const connectionId = `queued-${String(wave)}`;
      const queuedRequests = Array.from({ length: 16 }, (_, requestId) =>
        scheduler.schedule({
          connectionId,
          requestId,
          timeoutMs: 10_000,
          execute: () => {
            throw new Error('A replacement ran before provider capacity was free.');
          },
        }),
      );
      expect(scheduler.queuedCount).toBe(16);
      expect(scheduler.cancelConnection(connectionId)).toBe(16);
      await Promise.all(queuedRequests);
      expect(scheduler.activeCount).toBe(8);
      expect(scheduler.queuedCount).toBe(0);
      expect(executionStarts).toBe(8);
    }

    const replacementGate = deferred<string>();
    const replacementStarted = deferred<void>();
    const replacement = scheduler.schedule({
      connectionId: 'replacement',
      requestId: 0,
      timeoutMs: 10_000,
      execute: () => {
        replacementStarted.resolve();
        return trackedExecution(replacementGate);
      },
    });
    expect(scheduler.queuedCount).toBe(1);

    activeGates[0]?.resolve('settled');
    await replacementStarted.promise;
    expect(executionStarts).toBe(9);
    expect(scheduler.activeCount).toBe(8);
    expect(maximumExecutionsInFlight).toBe(8);

    expect(scheduler.cancel('replacement', 0)).toBe(true);
    expectErrorCode(await replacement, 'CANCELLED');
    expect(scheduler.activeCount).toBe(8);

    for (const gate of activeGates) {
      gate.resolve('settled');
    }
    replacementGate.resolve('settled');
    await Promise.all(trackedExecutions);
    expect(scheduler.activeCount).toBe(0);
    expect(executionsInFlight).toBe(0);
    expect(maximumExecutionsInFlight).toBe(8);
  });

  it('keeps timed-out provider waves in admission accounting until settlement', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const activeGates = Array.from({ length: 8 }, () => deferred<string>());
    let executionStarts = 0;
    const activeRequests = activeGates.map((gate, index) =>
      scheduler.schedule({
        connectionId: index < 4 ? 'a' : 'b',
        requestId: index % 4,
        timeoutMs: 100,
        execute: () => {
          executionStarts += 1;
          return gate.promise;
        },
      }),
    );

    runtime.advanceBy(100);
    const activeResults = await Promise.all(activeRequests);
    for (const result of activeResults) {
      expectErrorCode(result, 'TIMEOUT');
    }
    expect(scheduler.activeCount).toBe(8);

    for (let wave = 0; wave < 5; wave += 1) {
      const connectionId = `timeout-${String(wave)}`;
      const queuedRequests = Array.from({ length: 16 }, (_, requestId) =>
        scheduler.schedule({
          connectionId,
          requestId,
          timeoutMs: 50,
          execute: () => {
            executionStarts += 1;
            return Promise.resolve('unexpected');
          },
        }),
      );
      runtime.advanceBy(50);
      const queuedResults = await Promise.all(queuedRequests);
      for (const result of queuedResults) {
        expectErrorCode(result, 'TIMEOUT');
      }
      expect(scheduler.activeCount).toBe(8);
      expect(scheduler.queuedCount).toBe(0);
      expect(executionStarts).toBe(8);
    }

    for (const gate of activeGates) {
      gate.resolve('settled');
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.activeCount).toBe(0);
  });

  it('lets exactly one of active cancellation and completion win', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const cancelledGate = deferred<string>();
    let cancelledSignal: AbortSignal | undefined;
    let cancelledTerminalCount = 0;
    const cancelledRequest = scheduler
      .schedule({
        connectionId: 'a',
        requestId: 0,
        timeoutMs: 1_000,
        execute: (context) => {
          cancelledSignal = context.signal;
          return cancelledGate.promise;
        },
      })
      .then((result) => {
        cancelledTerminalCount += 1;
        return result;
      });

    expect(scheduler.cancel('a', 0)).toBe(true);
    expectErrorCode(await cancelledRequest, 'CANCELLED');
    expect(cancelledSignal?.aborted).toBe(true);
    cancelledGate.resolve('late');
    await Promise.resolve();
    expect(cancelledTerminalCount).toBe(1);

    const completedGate = deferred<string>();
    const completedRequest = scheduler.schedule({
      connectionId: 'a',
      requestId: 1,
      timeoutMs: 1_000,
      execute: () => completedGate.promise,
    });
    completedGate.resolve('done');
    const completed = await completedRequest;
    expect(completed).toEqual({ outcome: 'success', value: 'done' });
    expect(scheduler.cancel('a', 1)).toBe(false);
  });

  it('cancels all active and queued work for a disconnected connection', async () => {
    const runtime = new FakeSchedulerRuntime();
    const scheduler = new RequestScheduler<string, string>(runtime);
    const aGates = Array.from({ length: 6 }, () => deferred<string>());
    const bGates = Array.from({ length: 4 }, () => deferred<string>());
    const aSignals: AbortSignal[] = [];
    const aRequests = aGates.map((gate, requestId) =>
      scheduler.schedule({
        connectionId: 'a',
        requestId,
        timeoutMs: 1_000,
        execute: (context) => {
          aSignals.push(context.signal);
          return gate.promise;
        },
      }),
    );
    const bRequests = bGates.map((gate, requestId) =>
      scheduler.schedule({
        connectionId: 'b',
        requestId,
        timeoutMs: 1_000,
        execute: () => gate.promise,
      }),
    );

    expect(scheduler.activeCount).toBe(8);
    expect(scheduler.queuedCount).toBe(2);
    expect(scheduler.cancelConnection('a')).toBe(6);
    expect(scheduler.activeCountFor('a')).toBe(4);
    expect(scheduler.requestCountFor('a')).toBe(0);
    expect(scheduler.activeCount).toBe(8);
    expect(scheduler.queuedCount).toBe(0);
    expect(aSignals).toHaveLength(4);
    expect(aSignals.every((signal) => signal.aborted)).toBe(true);

    const aResults = await Promise.all(aRequests);
    for (const result of aResults) {
      expectErrorCode(result, 'CANCELLED');
    }

    for (const [index, gate] of bGates.entries()) {
      gate.resolve(`b${index}`);
    }
    const bResults = await Promise.all(bRequests);
    expect(bResults.every((result) => result.outcome === 'success')).toBe(true);

    for (const gate of aGates) {
      gate.resolve('late');
    }
    await Promise.resolve();
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.cancelConnection('missing')).toBe(0);
  });
});
