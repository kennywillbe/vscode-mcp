import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import {
  BoundedJsonRpcMessageReader,
  BoundedJsonRpcMessageWriter,
} from '@vscode-mcp/protocol/bounded-jsonrpc';
import {
  IPC_APPLICATION_ERROR_CODE,
  IPC_METHODS,
  IPC_PROTOCOL_VERSION,
  PROTOCOL_LIMITS,
  REGISTRY_SCHEMA_VERSION,
  TOOL_CONTRACT_VERSION,
} from '@vscode-mcp/protocol/constants';
import {
  createInstanceCredentials,
  type InstanceCredentialDependencies,
  type InstanceCredentials,
} from '@vscode-mcp/protocol/credentials';
import {
  evaluateHello,
  type HandshakeExpectation,
} from '@vscode-mcp/protocol/handshake';
import {
  CloseSessionParamsSchema,
  CloseSessionResultSchema,
  IpcCapabilitiesSchema,
  IpcTransportErrorDataSchema,
  type IpcCapabilities,
  type IpcTransportErrorData,
  type CloseSessionResult,
} from '@vscode-mcp/protocol/ipc-schemas';
import {
  V1IpcCallToolResultSchema,
  type V1IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas-v1';
import {
  RegistryRecordSchema,
  type RegistryRecord,
  type RegistryWorkspaceFolder,
} from '@vscode-mcp/protocol/registry-schemas';
import {
  CallToolRequestType,
  CloseSessionRequestType,
  HelloRequestType,
} from '@vscode-mcp/protocol/rpc-methods';
import {
  NODE_RUNTIME_REGISTRY_DEPENDENCIES,
  REGISTRY_HEARTBEAT_INTERVAL_MS,
  compareAndDeleteUnchangedRegistryRecord,
  readRegistryRecordSnapshot,
  resolveRuntimeRegistryPaths,
  writeRegistryRecord,
  type RegistryRecordSnapshot,
  type RuntimeRegistryDependencies,
  type RuntimeRegistryEnvironment,
  type RuntimeRegistryPaths,
} from '@vscode-mcp/protocol/runtime-registry';
import {
  InstanceDescriptorSchema,
  type InstanceDescriptor,
} from '@vscode-mcp/protocol/schemas';
import {
  V1AllExtensionToolInvocationSchema,
  type V1AllExtensionToolInvocation,
  type V1AllExtensionToolName,
} from '@vscode-mcp/protocol/tool-schemas-v1';
import {
  type AbstractCancellationTokenSource,
  CancellationSenderStrategy,
  type CancellationToken,
  CancellationTokenSource,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  ErrorCodes,
  type Event,
  type Message,
  ResponseError,
  type MessageConnection,
  type MessageReader,
  type PartialMessageInfo,
  type RequestCancellationReceiverStrategy,
  type RequestMessage,
} from 'vscode-jsonrpc/node';

import {
  createSchedulerError,
  RequestScheduler,
  type SchedulerError,
  type SchedulerRuntime,
} from './request-scheduler.js';

const SOCKET_MODE = 0o600;
const PERMISSION_MASK = 0o7777;
const LISTENER_START_ATTEMPTS = 3;
const LISTENER_START_RETRY_DELAY_MS = 25;

export interface IpcInstanceServiceIdentity {
  readonly extensionVersion: string;
  readonly displayName: string;
  readonly workspaceFingerprint: string;
  readonly workspaceFileUri: string | null;
  readonly workspaceFolders: readonly RegistryWorkspaceFolder[];
}

export interface IpcInstanceServiceOptions {
  readonly identity: IpcInstanceServiceIdentity;
  readonly runtimeEnvironment: RuntimeRegistryEnvironment;
  readonly isEligible: () => boolean;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly credentialDependencies?: InstanceCredentialDependencies;
  readonly registryDependencies?: RuntimeRegistryDependencies;
  readonly extensionTools?: readonly V1AllExtensionToolName[];
  readonly callTool?: IpcCallToolHandler;
  readonly schedulerRuntime?: SchedulerRuntime;
  readonly onUnexpectedStop?: () => void;
}

export type IpcCallToolHandler = (
  invocation: V1AllExtensionToolInvocation,
  signal: AbortSignal,
) => Promise<unknown>;

export type IpcInstanceServiceUnavailableReason =
  | 'INELIGIBLE'
  | 'LIFECYCLE_BUSY'
  | 'START_FAILED'
  | 'WINDOWS_ACL_NOT_IMPLEMENTED'
  | 'UNSUPPORTED_PLATFORM'
  | 'CURRENT_UID_UNAVAILABLE'
  | 'NO_SECURE_RUNTIME_DIRECTORY';

export type IpcInstanceServiceStartFailureStage =
  | 'RESOLVE_RUNTIME'
  | 'CREATE_LISTENER'
  | 'LISTEN'
  | 'SECURE_SOCKET'
  | 'PUBLISH_REGISTRY'
  | 'VERIFY_REGISTRY';

export type IpcInstanceServiceStartResult =
  | {
      readonly status: 'ready';
      readonly instanceId: string;
      readonly publishedAt: string;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: IpcInstanceServiceUnavailableReason;
      readonly stage?: IpcInstanceServiceStartFailureStage;
    };

type ServiceLifecycle = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

class StartInterruptedError extends Error {
  public constructor(public readonly reason: 'INELIGIBLE' | 'LIFECYCLE_BUSY') {
    super('The IPC listener start was interrupted.');
    this.name = 'StartInterruptedError';
  }
}

interface OwnedSocketIdentity {
  readonly device: number;
  readonly inode: number;
}

interface ActiveInstance {
  readonly credentials: InstanceCredentials;
  readonly paths: RuntimeRegistryPaths;
  readonly socketPath: string;
  readonly expectation: HandshakeExpectation;
  readonly publishedAt: string;
  record: RegistryRecord;
  snapshot: RegistryRecordSnapshot | undefined;
  socketIdentity: OwnedSocketIdentity | undefined;
}

function authenticationError(): ResponseError<IpcTransportErrorData> {
  return new ResponseError<IpcTransportErrorData>(
    IPC_APPLICATION_ERROR_CODE,
    'Authentication failed',
  );
}

function protocolError(
  code: 'PROTOCOL_VERSION_MISMATCH' | 'TOOL_CONTRACT_VERSION_MISMATCH',
  details: IpcTransportErrorData['details'],
): ResponseError<IpcTransportErrorData> {
  const data = IpcTransportErrorDataSchema.parse(
    details === undefined ? { code, fatal: true } : { code, fatal: true, details },
  );
  return new ResponseError<IpcTransportErrorData>(
    IPC_APPLICATION_ERROR_CODE,
    'Protocol version mismatch',
    data,
  );
}

function invalidParamsError(): ResponseError<IpcTransportErrorData> {
  return new ResponseError<IpcTransportErrorData>(
    ErrorCodes.InvalidParams,
    'Invalid params',
  );
}

function methodNotFoundError(): ResponseError<IpcTransportErrorData> {
  return new ResponseError<IpcTransportErrorData>(
    ErrorCodes.MethodNotFound,
    'Method not found',
  );
}

function duplicateRequestError(): ResponseError<IpcTransportErrorData> {
  return new ResponseError<IpcTransportErrorData>(
    IPC_APPLICATION_ERROR_CODE,
    'Duplicate request ID',
    IpcTransportErrorDataSchema.parse({
      code: 'DUPLICATE_REQUEST_ID',
      fatal: true,
    }),
  );
}

function toolFailure(
  tool: V1AllExtensionToolName,
  code: 'PROVIDER_UNAVAILABLE' | 'WORKSPACE_UNTRUSTED' | 'CANCELLED' | 'INTERNAL_ERROR',
  message: string,
): V1IpcCallToolResult {
  return V1IpcCallToolResultSchema.parse({
    outcome: 'toolError',
    tool,
    error: { code, message, retryable: false },
  });
}

function resultMatchesTool(
  result: V1IpcCallToolResult,
  tool: V1AllExtensionToolName,
): boolean {
  if (result.outcome === 'toolError') return result.tool === tool;
  return 'payload' in result ? result.payload.tool === tool : result.tool === tool;
}

function schedulerToolFailure(
  tool: V1AllExtensionToolName,
  error: SchedulerError,
): V1IpcCallToolResult {
  return V1IpcCallToolResultSchema.parse({
    outcome: 'toolError',
    tool,
    error,
  });
}

function timeoutForTool(tool: V1AllExtensionToolName): number {
  switch (tool) {
    case 'get_editor_context':
    case 'read_document':
    case 'get_diagnostics':
      return PROTOCOL_LIMITS.simpleOperationTimeoutMs;
    case 'get_hover':
    case 'get_definition':
    case 'find_references':
    case 'get_document_symbols':
    case 'search_workspace_symbols':
    case 'get_signature_help':
    case 'get_call_hierarchy':
      return PROTOCOL_LIMITS.providerOperationTimeoutMs;
    default:
      return PROTOCOL_LIMITS.providerOperationTimeoutMs;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cancellationRequestId(params: unknown): number | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const keys = Object.keys(params);
  return keys.length === 1 && keys[0] === 'id' && isRequestId(params['id'])
    ? params['id']
    : undefined;
}

type TrackedRequestIdentity =
  | {
      readonly kind: 'valid';
      readonly requestId: number;
      readonly method: string;
    }
  | {
      readonly kind: 'duplicate';
      readonly requestId: number;
      readonly method: string;
    }
  | { readonly kind: 'invalid' };

class SessionRequestTracker implements RequestCancellationReceiverStrategy {
  public readonly kind = 'request' as const;
  private readonly identityByMessage = new WeakMap<object, TrackedRequestIdentity>();
  private readonly identityByToken = new WeakMap<
    CancellationToken,
    TrackedRequestIdentity
  >();
  private readonly outstandingMethods = new Map<number, string>();
  private readonly pendingCancellations = new Set<number>();

  public observeRequest(message: Message, requestId: number, method: string): void {
    const identity: TrackedRequestIdentity = this.outstandingMethods.has(requestId)
      ? { kind: 'duplicate', requestId, method }
      : { kind: 'valid', requestId, method };
    this.identityByMessage.set(message, identity);
    if (identity.kind === 'valid') {
      this.outstandingMethods.set(requestId, method);
    }
  }

  public createCancellationTokenSource(
    requestMessage: RequestMessage,
  ): AbstractCancellationTokenSource {
    const source = new CancellationTokenSource();
    this.identityByToken.set(
      source.token,
      this.identityByMessage.get(requestMessage) ?? { kind: 'invalid' },
    );
    return source;
  }

  public identityFor(token: CancellationToken): TrackedRequestIdentity {
    return this.identityByToken.get(token) ?? { kind: 'invalid' };
  }

  public release(token: CancellationToken): void {
    const identity = this.identityByToken.get(token);
    this.identityByToken.delete(token);
    if (identity?.kind === 'valid') {
      this.outstandingMethods.delete(identity.requestId);
      this.pendingCancellations.delete(identity.requestId);
    }
  }

  public tracksCallTool(requestId: number): boolean {
    return this.outstandingMethods.get(requestId) === IPC_METHODS.callTool;
  }

  public deferCancellation(requestId: number): void {
    if (this.tracksCallTool(requestId)) {
      this.pendingCancellations.add(requestId);
    }
  }

  public takePendingCancellation(requestId: number): boolean {
    return this.pendingCancellations.delete(requestId);
  }

  public clear(): void {
    this.outstandingMethods.clear();
    this.pendingCancellations.clear();
  }
}

class InterceptingMessageReader implements MessageReader {
  public constructor(
    private readonly delegate: MessageReader,
    private readonly intercept: (message: Message, next: DataCallback) => void,
  ) {}

  public get onError(): Event<Error> {
    return this.delegate.onError;
  }

  public get onClose(): Event<void> {
    return this.delegate.onClose;
  }

  public get onPartialMessage(): Event<PartialMessageInfo> {
    return this.delegate.onPartialMessage;
  }

  public listen(callback: DataCallback): Disposable {
    return this.delegate.listen((message) => {
      this.intercept(message, callback);
    });
  }

  public dispose(): void {
    this.delegate.dispose();
  }
}

class IpcConnectionSession {
  private readonly connection: MessageConnection;
  private readonly writer: BoundedJsonRpcMessageWriter;
  private readonly handshakeTimer: NodeJS.Timeout;
  private readonly schedulerConnectionId = Symbol('ipc-connection');
  private readonly requestTracker = new SessionRequestTracker();
  private sessionCloseTimer: NodeJS.Timeout | undefined;
  private state: 'awaitingHello' | 'ready' | 'closing' | 'closed' = 'awaitingHello';

  public constructor(
    private readonly socket: Socket,
    private readonly expectation: HandshakeExpectation,
    private readonly isEligible: () => boolean,
    private readonly callTool: IpcCallToolHandler | undefined,
    private readonly scheduler: RequestScheduler<symbol, V1IpcCallToolResult>,
    private readonly onClosed: (session: IpcConnectionSession) => void,
  ) {
    const reader = new InterceptingMessageReader(
      new BoundedJsonRpcMessageReader(
        socket,
        PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
      ),
      this.handleInboundMessage,
    );
    this.writer = new BoundedJsonRpcMessageWriter(
      socket,
      PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
    );
    this.connection = createMessageConnection(reader, this.writer, undefined, {
      cancellationStrategy: {
        receiver: this.requestTracker,
        sender: CancellationSenderStrategy.Message,
      },
    });

    this.connection.onRequest(HelloRequestType, this.handleHello);
    this.connection.onRequest(CallToolRequestType, this.handleCallTool);
    this.connection.onRequest(CloseSessionRequestType, this.handleCloseSession);
    this.connection.onRequest(this.handleUnknownRequest);
    this.connection.onNotification(this.handleUnknownNotification);
    this.connection.onError(() => {
      this.forceClose();
    });
    this.connection.onClose(() => {
      this.finalizeClose();
    });
    this.socket.once('error', () => {
      this.forceClose();
    });
    this.socket.once('close', () => {
      this.finalizeClose();
    });

    this.handshakeTimer = setTimeout(() => {
      this.forceClose();
    }, PROTOCOL_LIMITS.handshakeTimeoutMs);
    this.handshakeTimer.unref();
    this.connection.listen();
  }

  public forceClose(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closing';
    clearTimeout(this.handshakeTimer);
    this.clearSessionCloseTimer();
    this.connection.dispose();
    this.socket.destroy();
    this.finalizeClose();
  }

  private readonly handleInboundMessage = (
    message: Message,
    next: DataCallback,
  ): void => {
    const rawMessage: unknown = message;
    if (!isRecord(rawMessage) || typeof rawMessage['method'] !== 'string') {
      this.forceClose();
      return;
    }

    const method = rawMessage['method'];
    if (Object.hasOwn(rawMessage, 'id')) {
      const requestId = rawMessage['id'];
      if (!isRequestId(requestId)) {
        this.forceClose();
        return;
      }
      this.requestTracker.observeRequest(message, requestId, method);
      return next(message);
    }

    if (method !== IPC_METHODS.cancelRequest) {
      return next(message);
    }
    if (this.state !== 'ready') {
      this.forceClose();
      return;
    }

    const requestId = cancellationRequestId(rawMessage['params']);
    if (requestId === undefined) {
      this.forceClose();
      return;
    }
    if (
      this.requestTracker.tracksCallTool(requestId) &&
      !this.scheduler.cancel(this.schedulerConnectionId, requestId)
    ) {
      this.requestTracker.deferCancellation(requestId);
    }
  };

  private readonly handleHello = (
    params: unknown,
    cancellationToken: CancellationToken,
  ): unknown | ResponseError<IpcTransportErrorData> => {
    const identity = this.requestTracker.identityFor(cancellationToken);
    try {
      if (identity.kind === 'invalid') {
        this.forceClose();
        return authenticationError();
      }
      if (identity.kind === 'duplicate') {
        const authenticated = this.state === 'ready';
        this.closeAfterResponse();
        return authenticated ? duplicateRequestError() : authenticationError();
      }

      if (this.state !== 'awaitingHello') {
        this.closeAfterResponse();
        return authenticationError();
      }

      let decision: ReturnType<typeof evaluateHello>;
      try {
        decision = evaluateHello(params, this.expectation);
      } catch {
        this.closeAfterResponse();
        return authenticationError();
      }

      if (!decision.ok) {
        this.closeAfterResponse();
        if (
          decision.failure.kind === 'protocol' &&
          decision.failure.code !== undefined
        ) {
          return protocolError(decision.failure.code, decision.failure.details);
        }
        return authenticationError();
      }

      if (!this.eligibilityIsCurrent()) {
        this.closeAfterResponse();
        return authenticationError();
      }

      clearTimeout(this.handshakeTimer);
      this.state = 'ready';
      return decision.result;
    } finally {
      this.requestTracker.release(cancellationToken);
    }
  };

  private readonly handleCallTool = async (
    params: unknown,
    cancellationToken: CancellationToken,
  ): Promise<V1IpcCallToolResult | ResponseError<IpcTransportErrorData>> => {
    const identity = this.requestTracker.identityFor(cancellationToken);
    try {
      if (identity.kind === 'invalid') {
        this.forceClose();
        return authenticationError();
      }
      if (identity.kind === 'duplicate') {
        const authenticated = this.state === 'ready';
        this.closeAfterResponse();
        return authenticated ? duplicateRequestError() : authenticationError();
      }

      if (this.state !== 'ready') {
        this.closeAfterResponse();
        return authenticationError();
      }

      const parsed = V1AllExtensionToolInvocationSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParamsError();
      }

      if (!this.eligibilityIsCurrent()) {
        return toolFailure(
          parsed.data.tool,
          'WORKSPACE_UNTRUSTED',
          'The workspace is no longer eligible.',
        );
      }

      if (
        this.callTool === undefined ||
        !this.expectation.capabilities.extensionTools.includes(parsed.data.tool)
      ) {
        return toolFailure(
          parsed.data.tool,
          'PROVIDER_UNAVAILABLE',
          'The provider is not available in this milestone.',
        );
      }

      if (
        cancellationToken.isCancellationRequested ||
        this.requestTracker.takePendingCancellation(identity.requestId)
      ) {
        return schedulerToolFailure(
          parsed.data.tool,
          createSchedulerError('CANCELLED'),
        );
      }

      const cancellation = cancellationToken.onCancellationRequested(() => {
        this.scheduler.cancel(this.schedulerConnectionId, identity.requestId);
      });
      try {
        const scheduledPromise = this.scheduler.schedule({
          connectionId: this.schedulerConnectionId,
          requestId: identity.requestId,
          timeoutMs: timeoutForTool(parsed.data.tool),
          execute: (context) => this.executeCallTool(parsed.data, context.signal),
        });
        if (cancellationToken.isCancellationRequested) {
          this.scheduler.cancel(this.schedulerConnectionId, identity.requestId);
        }
        const scheduled = await scheduledPromise;
        return scheduled.outcome === 'success'
          ? scheduled.value
          : schedulerToolFailure(parsed.data.tool, scheduled.error);
      } finally {
        cancellation.dispose();
      }
    } finally {
      this.requestTracker.release(cancellationToken);
    }
  };

  private readonly handleCloseSession = (
    params: unknown,
    cancellationToken: CancellationToken,
  ): CloseSessionResult | ResponseError<IpcTransportErrorData> => {
    const identity = this.requestTracker.identityFor(cancellationToken);
    try {
      if (identity.kind === 'invalid') {
        this.forceClose();
        return authenticationError();
      }
      if (identity.kind === 'duplicate') {
        const authenticated = this.state === 'ready';
        this.closeAfterResponse();
        return authenticated ? duplicateRequestError() : authenticationError();
      }
      if (this.state !== 'ready') {
        this.closeAfterResponse();
        return authenticationError();
      }

      const parsed = CloseSessionParamsSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParamsError();
      }

      this.beginGracefulClose(identity.requestId);
      return CloseSessionResultSchema.parse({ closed: true });
    } finally {
      this.requestTracker.release(cancellationToken);
    }
  };

  private async executeCallTool(
    invocation: V1AllExtensionToolInvocation,
    signal: AbortSignal,
  ): Promise<V1IpcCallToolResult> {
    if (!this.eligibilityIsCurrent()) {
      return toolFailure(
        invocation.tool,
        'WORKSPACE_UNTRUSTED',
        'The workspace is no longer eligible.',
      );
    }

    const callTool = this.callTool;
    if (callTool === undefined) {
      return toolFailure(
        invocation.tool,
        'PROVIDER_UNAVAILABLE',
        'The provider is not available in this milestone.',
      );
    }

    try {
      const untrustedResult = await callTool(invocation, signal);
      const result = V1IpcCallToolResultSchema.safeParse(untrustedResult);
      if (!result.success || !resultMatchesTool(result.data, invocation.tool)) {
        return toolFailure(
          invocation.tool,
          'INTERNAL_ERROR',
          'The tool handler returned an invalid result.',
        );
      }
      return result.data;
    } catch {
      return toolFailure(invocation.tool, 'INTERNAL_ERROR', 'The tool handler failed.');
    }
  }

  private readonly handleUnknownRequest = (
    method: string,
    params: object | unknown[] | undefined,
    cancellationToken: CancellationToken,
  ): ResponseError<IpcTransportErrorData> => {
    const identity = this.requestTracker.identityFor(cancellationToken);
    try {
      void method;
      void params;
      if (identity.kind === 'invalid') {
        this.forceClose();
        return authenticationError();
      }
      if (identity.kind === 'duplicate') {
        const authenticated = this.state === 'ready';
        this.closeAfterResponse();
        return authenticated ? duplicateRequestError() : authenticationError();
      }
      if (this.state !== 'ready') {
        this.closeAfterResponse();
        return authenticationError();
      }
      return methodNotFoundError();
    } finally {
      this.requestTracker.release(cancellationToken);
    }
  };

  private readonly handleUnknownNotification = (
    method: string,
    params: object | unknown[] | undefined,
  ): void => {
    void method;
    void params;
    if (this.state !== 'ready') {
      this.forceClose();
    }
  };

  private eligibilityIsCurrent(): boolean {
    try {
      return this.isEligible();
    } catch {
      return false;
    }
  }

  private closeAfterResponse(): void {
    if (this.state === 'closed' || this.state === 'closing') {
      return;
    }
    this.state = 'closing';
    clearTimeout(this.handshakeTimer);
    setImmediate(() => {
      if (this.state === 'closing') {
        this.connection.end();
      }
    });
  }

  private beginGracefulClose(requestId: number): void {
    if (this.state !== 'ready') {
      return;
    }
    this.state = 'closing';
    clearTimeout(this.handshakeTimer);
    const responseWritten = this.writer.waitForResponseWrite(requestId);
    this.sessionCloseTimer = setTimeout(() => {
      this.sessionCloseTimer = undefined;
      this.forceClose();
    }, PROTOCOL_LIMITS.sessionCloseTimeoutMs);
    this.sessionCloseTimer.unref();

    void responseWritten.then(
      () => {
        if (this.state !== 'closing') {
          return;
        }
        const finish = (): void => {
          this.clearSessionCloseTimer();
          this.finalizeClose();
        };
        this.socket.once('finish', finish);
        try {
          this.socket.end();
        } catch {
          this.socket.removeListener('finish', finish);
          this.forceClose();
        }
      },
      () => {
        this.forceClose();
      },
    );
  }

  private clearSessionCloseTimer(): void {
    if (this.sessionCloseTimer !== undefined) {
      clearTimeout(this.sessionCloseTimer);
      this.sessionCloseTimer = undefined;
    }
  }

  private finalizeClose(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    clearTimeout(this.handshakeTimer);
    this.clearSessionCloseTimer();
    this.scheduler.cancelConnection(this.schedulerConnectionId);
    this.requestTracker.clear();
    this.connection.dispose();
    this.onClosed(this);
    // A peer EOF closes the JSON-RPC reader, but Electron's extension-host socket may
    // remain half-open long enough for rapid bridge sessions to exhaust the four-slot
    // admission limit. Remove the session first, then close the server-side handle so
    // the bridge can observe deterministic release before opening its next session.
    this.socket.destroy();
  }
}

function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (): void => {
      server.removeListener('listening', handleListening);
      reject(new Error('The local IPC listener failed to start.'));
    };
    const handleListening = (): void => {
      server.removeListener('error', handleError);
      resolve();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(socketPath);
  });
}

function beginServerClose(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function inspectOwnedSocket(
  socketPath: string,
  uid: number,
): Promise<OwnedSocketIdentity> {
  const stats = await lstat(socketPath);
  if (
    stats.isSymbolicLink() ||
    !stats.isSocket() ||
    stats.uid !== uid ||
    (stats.mode & PERMISSION_MASK) !== SOCKET_MODE
  ) {
    throw new Error('The local IPC socket is not secure.');
  }
  return { device: stats.dev, inode: stats.ino };
}

async function removeOwnedSocket(
  socketPath: string,
  uid: number,
  identity: OwnedSocketIdentity | undefined,
): Promise<void> {
  if (identity === undefined) {
    return;
  }

  try {
    const stats = await lstat(socketPath);
    if (
      !stats.isSymbolicLink() &&
      stats.isSocket() &&
      stats.uid === uid &&
      stats.dev === identity.device &&
      stats.ino === identity.inode
    ) {
      await unlink(socketPath);
    }
  } catch {
    // Missing or replaced paths are deliberately left untouched.
  }
}

export class IpcInstanceService {
  private lifecycle: ServiceLifecycle = 'idle';
  private active: ActiveInstance | undefined;
  private server: Server | undefined;
  private readonly connections = new Set<IpcConnectionSession>();
  private readonly scheduler: RequestScheduler<symbol, V1IpcCallToolResult>;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatOperation: Promise<void> | undefined;
  private startOperation: Promise<IpcInstanceServiceStartResult> | undefined;
  private stopOperation: Promise<void> | undefined;
  private stopRequested = false;
  private unexpectedStopNotified = false;

  public constructor(private readonly options: IpcInstanceServiceOptions) {
    this.scheduler = new RequestScheduler(options.schedulerRuntime);
  }

  public async start(): Promise<IpcInstanceServiceStartResult> {
    if (this.lifecycle === 'running' && this.active !== undefined) {
      return {
        status: 'ready',
        instanceId: this.active.credentials.instanceId,
        publishedAt: this.active.publishedAt,
      };
    }
    if (this.lifecycle === 'starting' || this.lifecycle === 'stopping') {
      return { status: 'unavailable', reason: 'LIFECYCLE_BUSY' };
    }
    if (!this.eligibilityIsCurrent()) {
      return { status: 'unavailable', reason: 'INELIGIBLE' };
    }

    this.stopRequested = false;
    this.lifecycle = 'starting';
    const operation = this.performStartWithRetry();
    this.startOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.startOperation === operation) {
        this.startOperation = undefined;
      }
    }
  }

  private async performStartWithRetry(): Promise<IpcInstanceServiceStartResult> {
    // performStart removes only its owned random socket and unpublished registry
    // artifacts before returning START_FAILED. Initial secure-runtime and eligibility
    // rejections use distinct reasons; bounded retries never repair or delete unsafe
    // paths.
    for (let attempt = 1; attempt <= LISTENER_START_ATTEMPTS; attempt += 1) {
      const result = await this.performStart();
      if (
        result.status === 'ready' ||
        result.reason !== 'START_FAILED' ||
        attempt === LISTENER_START_ATTEMPTS
      ) {
        return result;
      }
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, LISTENER_START_RETRY_DELAY_MS),
      );
      if (this.stopRequested) {
        return { status: 'unavailable', reason: 'LIFECYCLE_BUSY' };
      }
      if (!this.eligibilityIsCurrent()) {
        return { status: 'unavailable', reason: 'INELIGIBLE' };
      }
      this.lifecycle = 'starting';
    }
    return { status: 'unavailable', reason: 'START_FAILED' };
  }

  private async performStart(): Promise<IpcInstanceServiceStartResult> {
    const dependencies =
      this.options.registryDependencies ?? NODE_RUNTIME_REGISTRY_DEPENDENCIES;
    let stage: IpcInstanceServiceStartFailureStage = 'RESOLVE_RUNTIME';
    try {
      const resolution = await resolveRuntimeRegistryPaths(
        this.options.runtimeEnvironment,
        dependencies,
      );
      this.assertStartMayContinue();
      if (resolution.status !== 'ready') {
        this.lifecycle = 'stopped';
        return { status: 'unavailable', reason: resolution.reason };
      }

      stage = 'CREATE_LISTENER';
      const active = this.createActiveInstance(resolution.paths);
      this.active = active;
      const server = createServer((socket) => {
        this.acceptConnection(socket);
      });
      this.server = server;

      stage = 'LISTEN';
      await listenOnSocket(server, active.socketPath);
      server.on('error', this.handleServerError);
      stage = 'SECURE_SOCKET';
      await chmod(active.socketPath, SOCKET_MODE);
      active.socketIdentity = await inspectOwnedSocket(
        active.socketPath,
        active.paths.uid,
      );
      this.assertStartMayContinue();

      stage = 'PUBLISH_REGISTRY';
      await writeRegistryRecord(active.paths, active.record, dependencies);
      this.assertStartMayContinue();
      stage = 'VERIFY_REGISTRY';
      const publishedSnapshot = await readRegistryRecordSnapshot(
        active.paths,
        active.credentials.instanceId,
        dependencies,
      );
      if (publishedSnapshot === null) {
        throw new Error('The registry publication could not be verified.');
      }
      active.snapshot = publishedSnapshot;
      this.assertStartMayContinue();

      this.lifecycle = 'running';
      this.startHeartbeat();
      return {
        status: 'ready',
        instanceId: active.credentials.instanceId,
        publishedAt: active.publishedAt,
      };
    } catch (error: unknown) {
      await this.performStop();
      return {
        status: 'unavailable',
        reason: error instanceof StartInterruptedError ? error.reason : 'START_FAILED',
        ...(error instanceof StartInterruptedError ? {} : { stage }),
      };
    }
  }

  public async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.stopOperation !== undefined) {
      await this.stopOperation;
      return;
    }

    const operation = this.stopAfterPendingStart();
    this.stopOperation = operation;
    try {
      await operation;
    } finally {
      if (this.stopOperation === operation) {
        this.stopOperation = undefined;
      }
    }
  }

  private async stopAfterPendingStart(): Promise<void> {
    if (this.lifecycle === 'starting') {
      this.lifecycle = 'stopping';
    }

    const pendingStart = this.startOperation;
    if (pendingStart !== undefined) {
      await pendingStart.then(
        () => undefined,
        () => undefined,
      );
    }
    await this.performStop();
  }

  private createActiveInstance(paths: RuntimeRegistryPaths): ActiveInstance {
    const credentials = createInstanceCredentials(this.options.credentialDependencies);
    const publishedAt = this.nowIso();
    const socketPath = join(
      paths.socketsDirectory,
      `${credentials.endpointEntropy}.sock`,
    );
    const workspaceFolders = this.options.identity.workspaceFolders.map((folder) => ({
      workspaceFolderId: folder.workspaceFolderId,
      name: folder.name,
      uri: folder.uri,
      canonicalPath: folder.canonicalPath,
    }));
    const instance: InstanceDescriptor = InstanceDescriptorSchema.parse({
      instanceId: credentials.instanceId,
      displayName: this.options.identity.displayName,
      trusted: true,
      publishedAt,
      workspaceFileUri: this.options.identity.workspaceFileUri,
      workspaceFolders: workspaceFolders.map((folder) => ({
        workspaceFolderId: folder.workspaceFolderId,
        name: folder.name,
        uri: folder.uri,
      })),
      protocolVersion: IPC_PROTOCOL_VERSION,
      toolContractVersion: TOOL_CONTRACT_VERSION,
    });
    const capabilities: IpcCapabilities = {
      ...IpcCapabilitiesSchema.parse({
        extensionTools: [...(this.options.extensionTools ?? [])],
        cancellation: true,
      }),
    };
    const expectation: HandshakeExpectation = {
      instance,
      workspaceFingerprint: this.options.identity.workspaceFingerprint,
      authToken: credentials.authToken,
      capabilities,
    };
    const record = RegistryRecordSchema.parse({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      protocolVersion: IPC_PROTOCOL_VERSION,
      toolContractVersion: TOOL_CONTRACT_VERSION,
      instanceId: credentials.instanceId,
      extensionVersion: this.options.identity.extensionVersion,
      pid: this.options.pid ?? process.pid,
      publishedAt,
      heartbeatAt: publishedAt,
      endpoint: { kind: 'unix', path: socketPath },
      authToken: credentials.authToken,
      displayName: this.options.identity.displayName,
      workspaceFingerprint: this.options.identity.workspaceFingerprint,
      workspaceFileUri: this.options.identity.workspaceFileUri,
      workspaceFolders,
    });

    return {
      credentials,
      paths,
      socketPath,
      expectation,
      publishedAt,
      record,
      snapshot: undefined,
      socketIdentity: undefined,
    };
  }

  private acceptConnection(socket: Socket): void {
    const active = this.active;
    if (
      active === undefined ||
      (this.lifecycle !== 'starting' && this.lifecycle !== 'running') ||
      this.connections.size >= PROTOCOL_LIMITS.connectionsPerWindow
    ) {
      socket.destroy();
      return;
    }

    const session = new IpcConnectionSession(
      socket,
      active.expectation,
      this.options.isEligible,
      this.options.callTool,
      this.scheduler,
      (closedSession) => {
        this.connections.delete(closedSession);
      },
    );
    this.connections.add(session);
  }

  private readonly handleServerError = (): void => {
    if (this.lifecycle === 'running' || this.lifecycle === 'starting') {
      this.stopUnexpectedly();
    }
  };

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.scheduleHeartbeat();
    }, REGISTRY_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private scheduleHeartbeat(): void {
    if (
      this.lifecycle !== 'running' ||
      this.active === undefined ||
      this.heartbeatOperation !== undefined
    ) {
      return;
    }

    const operation = this.performHeartbeat();
    this.heartbeatOperation = operation;
    void operation.then(
      () => {
        if (this.heartbeatOperation === operation) {
          this.heartbeatOperation = undefined;
        }
      },
      () => {
        if (this.heartbeatOperation === operation) {
          this.heartbeatOperation = undefined;
        }
        this.stopUnexpectedly();
      },
    );
  }

  private stopUnexpectedly(): void {
    if (this.unexpectedStopNotified) {
      return;
    }
    this.unexpectedStopNotified = true;
    const notify = (): void => {
      this.options.onUnexpectedStop?.();
    };
    void this.stop().then(notify, notify);
  }

  private async performHeartbeat(): Promise<void> {
    const active = this.active;
    if (active === undefined || !this.eligibilityIsCurrent()) {
      throw new Error('The instance is no longer eligible.');
    }

    const dependencies =
      this.options.registryDependencies ?? NODE_RUNTIME_REGISTRY_DEPENDENCIES;
    const nextRecord = RegistryRecordSchema.parse({
      ...active.record,
      heartbeatAt: this.nowIso(),
    });
    await writeRegistryRecord(active.paths, nextRecord, dependencies);
    const snapshot = await readRegistryRecordSnapshot(
      active.paths,
      active.credentials.instanceId,
      dependencies,
    );
    if (snapshot === null) {
      throw new Error('The heartbeat publication could not be verified.');
    }
    active.record = nextRecord;
    active.snapshot = snapshot;
  }

  private async performStop(): Promise<void> {
    if (this.lifecycle === 'idle' || this.lifecycle === 'stopped') {
      this.lifecycle = 'stopped';
      return;
    }

    this.lifecycle = 'stopping';
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    const heartbeatOperation = this.heartbeatOperation;
    if (heartbeatOperation !== undefined) {
      await heartbeatOperation.then(
        () => undefined,
        () => undefined,
      );
      if (this.heartbeatOperation === heartbeatOperation) {
        this.heartbeatOperation = undefined;
      }
    }

    const active = this.active;
    const server = this.server;
    if (server !== undefined) {
      server.removeListener('error', this.handleServerError);
    }
    const serverClosed = beginServerClose(server);
    for (const connection of this.connections) {
      connection.forceClose();
    }
    this.connections.clear();
    await serverClosed;

    if (active !== undefined) {
      const dependencies =
        this.options.registryDependencies ?? NODE_RUNTIME_REGISTRY_DEPENDENCIES;
      const snapshot =
        active.snapshot ??
        (await readRegistryRecordSnapshot(
          active.paths,
          active.credentials.instanceId,
          dependencies,
        ));
      if (snapshot !== null && snapshot !== undefined) {
        await compareAndDeleteUnchangedRegistryRecord(
          active.paths,
          snapshot,
          dependencies,
        );
      }
      await removeOwnedSocket(
        active.socketPath,
        active.paths.uid,
        active.socketIdentity,
      );
    }

    this.server = undefined;
    this.active = undefined;
    this.lifecycle = 'stopped';
  }

  private eligibilityIsCurrent(): boolean {
    try {
      return this.options.isEligible();
    } catch {
      return false;
    }
  }

  private assertStartMayContinue(): void {
    if (this.lifecycle !== 'starting') {
      throw new StartInterruptedError('LIFECYCLE_BUSY');
    }
    if (!this.eligibilityIsCurrent()) {
      throw new StartInterruptedError('INELIGIBLE');
    }
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
