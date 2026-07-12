import { PROTOCOL_LIMITS } from '@vscode-mcp/protocol/constants';

export type SchedulerErrorCode =
  'SERVER_BUSY' | 'TIMEOUT' | 'CANCELLED' | 'INTERNAL_ERROR';

export type SchedulerError = {
  readonly code: SchedulerErrorCode;
  readonly message: string;
  readonly retryable: boolean;
};

export type SchedulerResult<Value> =
  | { readonly outcome: 'success'; readonly value: Value }
  | { readonly outcome: 'toolError'; readonly error: SchedulerError };

export type ScheduledTaskContext = {
  readonly signal: AbortSignal;
  readonly receivedAt: number;
  readonly deadlineAt: number;
};

export type ScheduleRequest<ConnectionId, Value> = {
  readonly connectionId: ConnectionId;
  readonly requestId: number;
  readonly timeoutMs: number;
  readonly execute: (context: ScheduledTaskContext) => Value | PromiseLike<Value>;
};

export interface SchedulerTimer {
  cancel(): void;
}

export interface SchedulerRuntime {
  now(): number;
  setTimer(delayMs: number, callback: () => void): SchedulerTimer;
}

export const systemSchedulerRuntime: SchedulerRuntime = {
  now: () => performance.now(),
  setTimer: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    let cancelled = false;
    return {
      cancel: (): void => {
        if (!cancelled) {
          cancelled = true;
          clearTimeout(handle);
        }
      },
    };
  },
};

/**
 * Execution state is deliberately separate from client settlement. VS Code provider
 * promises are not generally cancellable, so a cancelled/timed-out client request may
 * remain `active` until its underlying promise actually settles.
 */
type JobStatus = 'pending' | 'queued' | 'active' | 'finished';

type ScheduledJob<ConnectionId, Value> = {
  readonly connectionId: ConnectionId;
  readonly requestId: number;
  readonly receivedAt: number;
  readonly deadlineAt: number;
  readonly execute: ScheduleRequest<ConnectionId, Value>['execute'];
  readonly abortController: AbortController;
  readonly resolve: (result: SchedulerResult<Value>) => void;
  status: JobStatus;
  clientSettled: boolean;
  deadlineTimer: SchedulerTimer | undefined;
};

export function createSchedulerError(code: SchedulerErrorCode): SchedulerError {
  switch (code) {
    case 'SERVER_BUSY':
      return {
        code,
        message: 'The VS Code MCP request queue is full.',
        retryable: true,
      };
    case 'TIMEOUT':
      return {
        code,
        message: 'The VS Code MCP request timed out.',
        retryable: true,
      };
    case 'CANCELLED':
      return {
        code,
        message: 'The VS Code MCP request was cancelled.',
        retryable: true,
      };
    case 'INTERNAL_ERROR':
      return {
        code,
        message: 'The VS Code MCP request failed internally.',
        retryable: false,
      };
  }
}

function schedulerFailure<Value>(code: SchedulerErrorCode): SchedulerResult<Value> {
  return { outcome: 'toolError', error: createSchedulerError(code) };
}

function schedulerSuccess<Value>(value: Value): SchedulerResult<Value> {
  return { outcome: 'success', value };
}

/**
 * Per-window admission, deadline, and cancellation control for extension IPC calls.
 * Tool execution and response serialization remain caller-owned composition points.
 */
export class RequestScheduler<ConnectionId, Value> {
  private readonly queued: Array<ScheduledJob<ConnectionId, Value>> = [];
  private readonly jobsByConnection = new Map<
    ConnectionId,
    Map<number, ScheduledJob<ConnectionId, Value>>
  >();
  private readonly activeByConnection = new Map<ConnectionId, number>();
  private readonly cancellingConnections = new Set<ConnectionId>();
  private totalActive = 0;
  private draining = false;

  public constructor(
    private readonly runtime: SchedulerRuntime = systemSchedulerRuntime,
  ) {}

  public get activeCount(): number {
    return this.totalActive;
  }

  public get queuedCount(): number {
    return this.queued.length;
  }

  public activeCountFor(connectionId: ConnectionId): number {
    return this.activeByConnection.get(connectionId) ?? 0;
  }

  public requestCountFor(connectionId: ConnectionId): number {
    return this.jobsByConnection.get(connectionId)?.size ?? 0;
  }

  public schedule(
    request: ScheduleRequest<ConnectionId, Value>,
  ): Promise<SchedulerResult<Value>> {
    this.validateRequest(request);

    if (this.cancellingConnections.has(request.connectionId)) {
      return Promise.resolve(schedulerFailure('CANCELLED'));
    }
    if (this.findJob(request.connectionId, request.requestId) !== undefined) {
      throw new Error(
        'A request with this connection-local ID is already outstanding.',
      );
    }

    const receivedAt = this.runtime.now();
    const deadlineAt = receivedAt + request.timeoutMs;
    if (!Number.isFinite(receivedAt) || !Number.isFinite(deadlineAt)) {
      throw new RangeError('The scheduler clock returned an invalid time.');
    }

    return new Promise((resolve) => {
      const job: ScheduledJob<ConnectionId, Value> = {
        connectionId: request.connectionId,
        requestId: request.requestId,
        receivedAt,
        deadlineAt,
        execute: request.execute,
        abortController: new AbortController(),
        resolve,
        status: 'pending',
        clientSettled: false,
        deadlineTimer: undefined,
      };

      this.addJob(job);
      const deadlineTimer = this.runtime.setTimer(request.timeoutMs, () => {
        this.handleDeadline(job);
      });

      if (job.clientSettled) {
        deadlineTimer.cancel();
        return;
      }
      job.deadlineTimer = deadlineTimer;
      if (this.canStart(job.connectionId)) {
        this.start(job);
        return;
      }
      if (this.queued.length >= PROTOCOL_LIMITS.queuedCallsPerWindow) {
        this.settleClient(job, schedulerFailure('SERVER_BUSY'), false);
        return;
      }

      job.status = 'queued';
      this.queued.push(job);
    });
  }

  public cancel(connectionId: ConnectionId, requestId: number): boolean {
    const job = this.findJob(connectionId, requestId);
    if (job === undefined) {
      return false;
    }
    return this.settleClient(job, schedulerFailure('CANCELLED'), true);
  }

  /** Cancels every queued and active request owned by one disconnected connection. */
  public cancelConnection(connectionId: ConnectionId): number {
    const connectionJobs = this.jobsByConnection.get(connectionId);
    if (connectionJobs === undefined || connectionJobs.size === 0) {
      return 0;
    }

    this.cancellingConnections.add(connectionId);
    let cancelledCount = 0;
    try {
      const jobs = Array.from(connectionJobs.values());
      for (const job of jobs) {
        if (this.settleClient(job, schedulerFailure('CANCELLED'), true, false)) {
          cancelledCount += 1;
        }
      }
    } finally {
      this.cancellingConnections.delete(connectionId);
    }
    this.drain();
    return cancelledCount;
  }

  private validateRequest(request: ScheduleRequest<ConnectionId, Value>): void {
    if (
      !Number.isSafeInteger(request.requestId) ||
      request.requestId < 0 ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs <= 0
    ) {
      throw new RangeError('Scheduler request ID or timeout is outside valid bounds.');
    }
  }

  private addJob(job: ScheduledJob<ConnectionId, Value>): void {
    const existing = this.jobsByConnection.get(job.connectionId);
    if (existing !== undefined) {
      existing.set(job.requestId, job);
      return;
    }
    this.jobsByConnection.set(job.connectionId, new Map([[job.requestId, job]]));
  }

  private findJob(
    connectionId: ConnectionId,
    requestId: number,
  ): ScheduledJob<ConnectionId, Value> | undefined {
    return this.jobsByConnection.get(connectionId)?.get(requestId);
  }

  private canStart(connectionId: ConnectionId): boolean {
    return (
      this.totalActive < PROTOCOL_LIMITS.activeCallsPerWindow &&
      (this.activeByConnection.get(connectionId) ?? 0) <
        PROTOCOL_LIMITS.activeCallsPerConnection &&
      !this.cancellingConnections.has(connectionId)
    );
  }

  private start(job: ScheduledJob<ConnectionId, Value>): void {
    if (job.clientSettled || job.status === 'finished') {
      return;
    }
    if (this.runtime.now() >= job.deadlineAt) {
      this.settleClient(job, schedulerFailure('TIMEOUT'), true);
      return;
    }

    job.status = 'active';
    this.totalActive += 1;
    this.activeByConnection.set(
      job.connectionId,
      (this.activeByConnection.get(job.connectionId) ?? 0) + 1,
    );

    let execution: PromiseLike<Value>;
    try {
      execution = Promise.resolve(
        job.execute({
          signal: job.abortController.signal,
          receivedAt: job.receivedAt,
          deadlineAt: job.deadlineAt,
        }),
      );
    } catch {
      this.finishExecution(job, schedulerFailure('INTERNAL_ERROR'));
      return;
    }

    void execution.then(
      (value) => {
        this.finishExecution(job, schedulerSuccess(value));
      },
      () => {
        this.finishExecution(job, schedulerFailure('INTERNAL_ERROR'));
      },
    );
  }

  private handleDeadline(job: ScheduledJob<ConnectionId, Value>): void {
    if (job.clientSettled) {
      return;
    }

    const remainingMs = job.deadlineAt - this.runtime.now();
    if (remainingMs > 0) {
      job.deadlineTimer = this.runtime.setTimer(remainingMs, () => {
        this.handleDeadline(job);
      });
      return;
    }
    this.settleClient(job, schedulerFailure('TIMEOUT'), true);
  }

  /**
   * Settles the observable request exactly once. Queued work is fully released here;
   * active work keeps its admission slot until `finishExecution` observes the original
   * promise settling.
   */
  private settleClient(
    job: ScheduledJob<ConnectionId, Value>,
    result: SchedulerResult<Value>,
    abort: boolean,
    drainAfter = true,
  ): boolean {
    if (job.clientSettled) {
      return false;
    }

    job.clientSettled = true;
    job.deadlineTimer?.cancel();
    job.deadlineTimer = undefined;

    if (job.status === 'queued') {
      const queueIndex = this.queued.indexOf(job);
      if (queueIndex >= 0) {
        this.queued.splice(queueIndex, 1);
      }
      job.status = 'finished';
    } else if (job.status === 'pending') {
      job.status = 'finished';
    }

    const connectionJobs = this.jobsByConnection.get(job.connectionId);
    connectionJobs?.delete(job.requestId);
    if (connectionJobs?.size === 0) {
      this.jobsByConnection.delete(job.connectionId);
    }

    if (abort && !job.abortController.signal.aborted) {
      job.abortController.abort();
    }
    job.resolve(result);

    if (drainAfter) {
      this.drain();
    }
    return true;
  }

  /** Releases execution accounting only after the original provider promise settles. */
  private finishExecution(
    job: ScheduledJob<ConnectionId, Value>,
    result: SchedulerResult<Value>,
  ): void {
    if (job.status !== 'active') {
      return;
    }

    if (!job.clientSettled) {
      const completedAfterDeadline = this.runtime.now() >= job.deadlineAt;
      this.settleClient(
        job,
        completedAfterDeadline ? schedulerFailure('TIMEOUT') : result,
        completedAfterDeadline,
        false,
      );
    }

    job.status = 'finished';
    this.totalActive -= 1;
    const connectionActive = this.activeByConnection.get(job.connectionId) ?? 0;
    if (connectionActive <= 1) {
      this.activeByConnection.delete(job.connectionId);
    } else {
      this.activeByConnection.set(job.connectionId, connectionActive - 1);
    }
    this.drain();
  }

  private drain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.totalActive < PROTOCOL_LIMITS.activeCallsPerWindow) {
        const queueIndex = this.queued.findIndex((job) =>
          this.canStart(job.connectionId),
        );
        if (queueIndex < 0) {
          return;
        }

        const job = this.queued.splice(queueIndex, 1)[0];
        if (job !== undefined) {
          this.start(job);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
