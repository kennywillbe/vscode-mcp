import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BoundedJsonRpcMessageReader,
  BoundedJsonRpcMessageWriter,
} from '@vscode-mcp/protocol/bounded-jsonrpc';
import {
  IPC_APPLICATION_ERROR_CODE,
  IPC_METHODS,
  PROTOCOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import type { InstanceCredentialDependencies } from '@vscode-mcp/protocol/credentials';
import {
  CallToolResponseMessageSchema,
  CloseSessionResultSchema,
  CloseSessionSuccessResponseMessageSchema,
  HelloResultSchema,
  HelloSuccessResponseMessageSchema,
  IpcApplicationErrorResponseMessageSchema,
  IpcCallToolResultSchema,
} from '@vscode-mcp/protocol/ipc-schemas';
import {
  CallToolRequestType,
  CloseSessionRequestType,
  HelloRequestType,
} from '@vscode-mcp/protocol/rpc-methods';
import {
  NODE_RUNTIME_REGISTRY_DEPENDENCIES,
  discoverRegistryRecords,
  resolveRuntimeRegistryPaths,
  type RegistryRecordSnapshot,
  type RuntimeRegistryDependencies,
  type RuntimeRegistryEnvironment,
  type RuntimeRegistryPaths,
} from '@vscode-mcp/protocol/runtime-registry';
import type { V1AllExtensionToolName } from '@vscode-mcp/protocol/tool-schemas-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CancellationTokenSource,
  createMessageConnection,
  ErrorCodes,
  type Message,
  ResponseError,
  type MessageConnection,
  type NotificationMessage,
  type RequestMessage,
} from 'vscode-jsonrpc/node';

import {
  IpcInstanceService,
  type IpcCallToolHandler,
  type IpcInstanceServiceIdentity,
} from './ipc-instance-service.js';
import type { SchedulerRuntime, SchedulerTimer } from './request-scheduler.js';

const fixtures: string[] = [];
const services: IpcInstanceService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })),
  );
});

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('The IPC service unit tests require a POSIX uid.');
  }
  return process.getuid();
}

function currentPosixPlatform(): 'darwin' | 'linux' {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform;
  }
  throw new Error('The IPC service unit tests require a POSIX platform.');
}

interface RunningFixture {
  readonly service: IpcInstanceService;
  readonly paths: RuntimeRegistryPaths;
  readonly snapshot: RegistryRecordSnapshot;
}

interface FixtureServiceOptions {
  readonly extensionTools?: readonly V1AllExtensionToolName[];
  readonly callTool?: IpcCallToolHandler;
  readonly schedulerRuntime?: SchedulerRuntime;
  readonly credentialDependencies?: InstanceCredentialDependencies;
  readonly isEligible?: () => boolean;
  readonly onUnexpectedStop?: () => void;
}

async function startFixture(
  options: FixtureServiceOptions = {},
): Promise<RunningFixture> {
  const fixture = await mkdtemp('/tmp/vscode-mcp-ipc-service-');
  fixtures.push(fixture);
  const xdgRuntimeDirectory = join(fixture, 'xdg');
  const workspacePath = join(fixture, 'workspace');
  await mkdir(xdgRuntimeDirectory, { mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });

  const runtimeEnvironment: RuntimeRegistryEnvironment = {
    platform: currentPosixPlatform(),
    uid: currentUid(),
    xdgRuntimeDirectory,
    temporaryDirectory: fixture,
  };
  const identity: IpcInstanceServiceIdentity = {
    extensionVersion: '0.0.0',
    displayName: 'IPC fixture',
    workspaceFingerprint: 'a'.repeat(64),
    workspaceFileUri: null,
    workspaceFolders: [
      {
        workspaceFolderId: 'root',
        name: 'fixture',
        uri: pathToFileURL(workspacePath).href,
        canonicalPath: workspacePath,
      },
    ],
  };
  const service = new IpcInstanceService({
    identity,
    runtimeEnvironment,
    isEligible: options.isEligible ?? (() => true),
    ...(options.extensionTools === undefined
      ? {}
      : { extensionTools: options.extensionTools }),
    ...(options.callTool === undefined ? {} : { callTool: options.callTool }),
    ...(options.schedulerRuntime === undefined
      ? {}
      : { schedulerRuntime: options.schedulerRuntime }),
    ...(options.credentialDependencies === undefined
      ? {}
      : { credentialDependencies: options.credentialDependencies }),
    ...(options.onUnexpectedStop === undefined
      ? {}
      : { onUnexpectedStop: options.onUnexpectedStop }),
  });
  services.push(service);

  const started = await service.start();
  if (started.status !== 'ready') {
    throw new Error(`The IPC fixture failed to start: ${started.reason}`);
  }

  const resolution = await resolveRuntimeRegistryPaths(runtimeEnvironment);
  if (resolution.status !== 'ready') {
    throw new Error('The IPC fixture runtime could not be resolved.');
  }
  const discovery = await discoverRegistryRecords(resolution.paths);
  if (discovery.status !== 'ready' || discovery.records.length !== 1) {
    throw new Error('The IPC fixture registry record was not published.');
  }
  const snapshot = discovery.records[0];
  if (snapshot === undefined) {
    throw new Error('The IPC fixture registry record is missing.');
  }
  return { service, paths: resolution.paths, snapshot };
}

it('notifies once after an eligibility-losing heartbeat stops the service', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    let eligible = true;
    let notifications = 0;
    const notified = deferred();
    const running = await startFixture({
      isEligible: () => eligible,
      onUnexpectedStop: () => {
        notifications += 1;
        notified.resolve();
      },
    });

    eligible = false;
    await vi.advanceTimersByTimeAsync(PROTOCOL_LIMITS.registryHeartbeatIntervalMs);
    await notified.promise;

    expect(notifications).toBe(1);
    const discovery = await discoverRegistryRecords(running.paths);
    expect(discovery).toMatchObject({ status: 'ready', records: [] });
  } finally {
    vi.useRealTimers();
  }
});

interface TestClient {
  readonly socket: Socket;
  readonly connection: MessageConnection;
}

interface RawTestClient {
  readonly socket: Socket;
  write(message: Message): Promise<void>;
  nextMessage(): Promise<Message>;
  messageCount(): number;
  dispose(): void;
}

async function connectClient(socketPath: string): Promise<TestClient> {
  const socket = createConnection(socketPath);
  await once(socket, 'connect');
  const reader = new BoundedJsonRpcMessageReader(
    socket,
    PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
  );
  const writer = new BoundedJsonRpcMessageWriter(
    socket,
    PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
  );
  const connection = createMessageConnection(reader, writer);
  connection.listen();
  return { socket, connection };
}

async function connectRawClient(socketPath: string): Promise<RawTestClient> {
  const socket = createConnection(socketPath);
  await once(socket, 'connect');
  const reader = new BoundedJsonRpcMessageReader(
    socket,
    PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
  );
  const writer = new BoundedJsonRpcMessageWriter(
    socket,
    PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
  );
  const messages: Message[] = [];
  const waiters: Array<(message: Message) => void> = [];
  let messageCount = 0;
  reader.listen((message) => {
    messageCount += 1;
    const waiter = waiters.shift();
    if (waiter === undefined) {
      messages.push(message);
    } else {
      waiter(message);
    }
  });

  return {
    socket,
    write: (message) => writer.write(message),
    nextMessage: () => {
      const message = messages.shift();
      return message === undefined
        ? new Promise<Message>((resolve) => {
            waiters.push(resolve);
          })
        : Promise.resolve(message);
    },
    messageCount: () => messageCount,
    dispose: () => {
      reader.dispose();
      writer.dispose();
      socket.destroy();
    },
  };
}

function helloParams(snapshot: RegistryRecordSnapshot): object {
  return {
    protocolVersion: 1,
    toolContractVersion: '1.0.0',
    instanceId: snapshot.record.instanceId,
    authToken: snapshot.record.authToken,
    client: { name: 'vscode-mcp-bridge', version: '0.0.0' },
  };
}

type FakeTimer = {
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
};

class FakeSchedulerRuntime implements SchedulerRuntime {
  private currentTime = 0;
  private readonly timers: FakeTimer[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimer(delayMs: number, callback: () => void): SchedulerTimer {
    const timer: FakeTimer = {
      dueAt: this.currentTime + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return {
      cancel: (): void => {
        timer.cancelled = true;
      },
    };
  }

  advanceBy(milliseconds: number): void {
    const target = this.currentTime + milliseconds;
    while (true) {
      let next: FakeTimer | undefined;
      for (const timer of this.timers) {
        if (
          !timer.cancelled &&
          timer.dueAt <= target &&
          (next === undefined || timer.dueAt < next.dueAt)
        ) {
          next = timer;
        }
      }
      if (next === undefined) {
        break;
      }
      next.cancelled = true;
      this.currentTime = next.dueAt;
      next.callback();
    }
    this.currentTime = target;
  }
}

type Deferred = {
  readonly promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      if (resolvePromise === undefined) {
        throw new Error('Deferred promise is not initialized.');
      }
      resolvePromise();
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error('The expected IPC test state was not reached.');
}

function completedHandlerResult(tool: V1AllExtensionToolName): object {
  return {
    outcome: 'toolError',
    tool,
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The fixture handler completed.',
      retryable: false,
    },
  };
}

async function closeClient(client: TestClient): Promise<void> {
  if (!client.socket.destroyed) {
    const closed = once(client.socket, 'close');
    client.connection.end();
    await closed;
  }
  client.connection.dispose();
}

async function closeAuthenticatedSession(client: TestClient): Promise<void> {
  if (client.socket.closed) {
    client.connection.dispose();
    return;
  }

  const closed = once(client.socket, 'close').then(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    const ack = CloseSessionResultSchema.parse(
      await client.connection.sendRequest(CloseSessionRequestType, {}),
    );
    expect(ack).toEqual({ closed: true });
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('The bridge-style IPC close did not finish.')),
          500,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    client.socket.destroy();
    client.connection.dispose();
  }
}

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

describePosix('IpcInstanceService', () => {
  it('releases bridge-style authenticated sessions before the next call', async () => {
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool: async (invocation) => completedHandlerResult(invocation.tool),
    });

    for (let index = 0; index < PROTOCOL_LIMITS.connectionsPerWindow + 2; index += 1) {
      const client = await connectClient(running.snapshot.record.endpoint.path);
      await client.connection.sendRequest(
        HelloRequestType,
        helloParams(running.snapshot),
      );
      const result = IpcCallToolResultSchema.parse(
        await client.connection.sendRequest(CallToolRequestType, {
          tool: 'get_editor_context',
          arguments: {},
        }),
      );
      expect(result).toMatchObject({
        outcome: 'toolError',
        tool: 'get_editor_context',
      });
      await closeAuthenticatedSession(client);
    }
  });

  it('requires authentication and strict empty params for graceful close', async () => {
    const running = await startFixture();
    const preAuth = await connectClient(running.snapshot.record.endpoint.path);
    const preAuthClosed = once(preAuth.socket, 'close');
    await expect(
      preAuth.connection.sendRequest(CloseSessionRequestType, {}),
    ).rejects.toMatchObject({
      code: IPC_APPLICATION_ERROR_CODE,
      message: 'Authentication failed',
      data: undefined,
    });
    await preAuthClosed;
    preAuth.connection.dispose();

    const authenticated = await connectClient(running.snapshot.record.endpoint.path);
    await authenticated.connection.sendRequest(
      HelloRequestType,
      helloParams(running.snapshot),
    );
    await expect(
      authenticated.connection.sendRequest(CloseSessionRequestType, {
        reason: 'not-allowed',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });

    await closeAuthenticatedSession(authenticated);
    expect(() =>
      authenticated.connection.sendRequest(CloseSessionRequestType, {}),
    ).toThrow('Connection is disposed.');
  });

  it('acknowledges only the first of repeated graceful close requests', async () => {
    const running = await startFixture();
    const client = await connectRawClient(running.snapshot.record.endpoint.path);
    const helloRequest: RequestMessage = {
      jsonrpc: '2.0',
      id: 0,
      method: IPC_METHODS.hello,
      params: helloParams(running.snapshot),
    };
    await client.write(helloRequest);
    HelloSuccessResponseMessageSchema.parse(await client.nextMessage());

    const closed = once(client.socket, 'close');
    const firstClose: RequestMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: IPC_METHODS.closeSession,
      params: {},
    };
    const repeatedClose: RequestMessage = {
      jsonrpc: '2.0',
      id: 2,
      method: IPC_METHODS.closeSession,
      params: {},
    };
    await client.write(firstClose);
    await client.write(repeatedClose);

    const ack = CloseSessionSuccessResponseMessageSchema.parse(
      await client.nextMessage(),
    );
    expect(ack).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { closed: true },
    });
    await closed;
    client.dispose();
  });

  it('publishes nothing when neither runtime-directory candidate is secure', async () => {
    const fixture = await mkdtemp('/tmp/vscode-mcp-ipc-unsafe-runtime-');
    fixtures.push(fixture);
    const unsafeXdg = join(fixture, 'unsafe-xdg');
    const temporaryTarget = join(fixture, 'temporary-target');
    const temporaryLink = join(fixture, 'temporary-link');
    const workspacePath = join(fixture, 'workspace');
    await mkdir(unsafeXdg, { mode: 0o700 });
    await chmod(unsafeXdg, 0o755);
    await mkdir(temporaryTarget, { mode: 0o700 });
    await symlink(temporaryTarget, temporaryLink);
    await mkdir(workspacePath, { mode: 0o700 });

    const service = new IpcInstanceService({
      identity: {
        extensionVersion: '0.0.0',
        displayName: 'Unsafe runtime fixture',
        workspaceFingerprint: 'c'.repeat(64),
        workspaceFileUri: null,
        workspaceFolders: [
          {
            workspaceFolderId: 'root',
            name: 'fixture',
            uri: pathToFileURL(workspacePath).href,
            canonicalPath: workspacePath,
          },
        ],
      },
      runtimeEnvironment: {
        platform: currentPosixPlatform(),
        uid: currentUid(),
        xdgRuntimeDirectory: unsafeXdg,
        temporaryDirectory: temporaryLink,
      },
      isEligible: () => true,
    });
    services.push(service);

    await expect(service.start()).resolves.toEqual({
      status: 'unavailable',
      reason: 'NO_SECURE_RUNTIME_DIRECTORY',
    });
    expect(await readdir(unsafeXdg)).toEqual([]);
    expect(await readdir(temporaryTarget)).toEqual([]);
  });

  it('cannot publish after stop interrupts an in-progress start', async () => {
    const fixture = await mkdtemp('/tmp/vscode-mcp-ipc-start-stop-race-');
    fixtures.push(fixture);
    const xdgRuntimeDirectory = join(fixture, 'xdg');
    const workspacePath = join(fixture, 'workspace');
    await mkdir(xdgRuntimeDirectory, { mode: 0o700 });
    await mkdir(workspacePath, { mode: 0o700 });

    const runtimeEnvironment: RuntimeRegistryEnvironment = {
      platform: currentPosixPlatform(),
      uid: currentUid(),
      xdgRuntimeDirectory,
      temporaryDirectory: fixture,
    };
    const resolutionGate = deferred();
    let resolutionBlocked = false;
    const nodeFileSystem = NODE_RUNTIME_REGISTRY_DEPENDENCIES.fileSystem;
    const registryDependencies: RuntimeRegistryDependencies = {
      randomBytes: NODE_RUNTIME_REGISTRY_DEPENDENCIES.randomBytes,
      fileSystem: {
        ...nodeFileSystem,
        lstat: async (path) => {
          if (!resolutionBlocked) {
            resolutionBlocked = true;
            await resolutionGate.promise;
          }
          return nodeFileSystem.lstat(path);
        },
      },
    };
    const service = new IpcInstanceService({
      identity: {
        extensionVersion: '0.0.0',
        displayName: 'Start-stop race fixture',
        workspaceFingerprint: 'b'.repeat(64),
        workspaceFileUri: null,
        workspaceFolders: [
          {
            workspaceFolderId: 'root',
            name: 'fixture',
            uri: pathToFileURL(workspacePath).href,
            canonicalPath: workspacePath,
          },
        ],
      },
      runtimeEnvironment,
      registryDependencies,
      isEligible: () => true,
    });
    services.push(service);

    const startOperation = service.start();
    await waitUntil(() => resolutionBlocked);
    const stopOperation = service.stop();
    resolutionGate.resolve();

    await expect(startOperation).resolves.toEqual({
      status: 'unavailable',
      reason: 'LIFECYCLE_BUSY',
    });
    await stopOperation;

    const resolution = await resolveRuntimeRegistryPaths(runtimeEnvironment);
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready') {
      return;
    }
    const discovery = await discoverRegistryRecords(resolution.paths);
    expect(discovery).toMatchObject({ status: 'ready', records: [] });
    expect(await readdir(resolution.paths.socketsDirectory)).toEqual([]);
  });

  it('publishes a strict record and removes the record and socket on stop', async () => {
    const running = await startFixture();
    const socketStats = await lstat(running.snapshot.record.endpoint.path);
    const recordStats = await lstat(
      join(
        running.paths.instancesDirectory,
        `${running.snapshot.record.instanceId}.json`,
      ),
    );

    expect(socketStats.isSocket()).toBe(true);
    expect(socketStats.mode & 0o7777).toBe(0o600);
    expect(recordStats.isFile()).toBe(true);
    expect(recordStats.mode & 0o7777).toBe(0o600);

    await running.service.stop();

    await expect(lstat(running.snapshot.record.endpoint.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const discovery = await discoverRegistryRecords(running.paths);
    expect(discovery.status).toBe('ready');
    expect(discovery.records).toEqual([]);
  });

  it('uses exact deterministic token and endpoint entropy on two listener starts', async () => {
    const firstTokenBytes = Buffer.alloc(PROTOCOL_LIMITS.authTokenBytes, 0x11);
    const firstEndpointBytes = Buffer.alloc(PROTOCOL_LIMITS.endpointEntropyBytes, 0x22);
    const secondTokenBytes = Buffer.alloc(PROTOCOL_LIMITS.authTokenBytes, 0x33);
    const secondEndpointBytes = Buffer.alloc(
      PROTOCOL_LIMITS.endpointEntropyBytes,
      0x44,
    );
    const entropy = [
      firstTokenBytes,
      firstEndpointBytes,
      secondTokenBytes,
      secondEndpointBytes,
    ];
    const requestedSizes: number[] = [];
    const credentialDependencies: InstanceCredentialDependencies = {
      randomBytes: (size) => {
        requestedSizes.push(size);
        const bytes = entropy.shift();
        if (bytes === undefined) {
          throw new Error('Unexpected credential entropy request.');
        }
        expect(bytes.byteLength).toBe(size);
        return bytes;
      },
    };

    const running = await startFixture({ credentialDependencies });
    expect(running.snapshot.record.authToken).toBe(
      firstTokenBytes.toString('base64url'),
    );
    expect(running.snapshot.record.endpoint.path).toBe(
      join(
        running.paths.socketsDirectory,
        `${firstEndpointBytes.toString('base64url')}.sock`,
      ),
    );

    await running.service.stop();
    await expect(running.service.start()).resolves.toMatchObject({ status: 'ready' });
    const discovery = await discoverRegistryRecords(running.paths);
    expect(discovery.status).toBe('ready');
    if (discovery.status !== 'ready') {
      return;
    }
    expect(discovery.records).toHaveLength(1);
    const restarted = discovery.records[0];
    expect(restarted).toBeDefined();
    if (restarted === undefined) {
      return;
    }
    expect(restarted.record.authToken).toBe(secondTokenBytes.toString('base64url'));
    expect(restarted.record.endpoint.path).toBe(
      join(
        running.paths.socketsDirectory,
        `${secondEndpointBytes.toString('base64url')}.sock`,
      ),
    );
    expect(requestedSizes).toEqual([
      PROTOCOL_LIMITS.authTokenBytes,
      PROTOCOL_LIMITS.endpointEntropyBytes,
      PROTOCOL_LIMITS.authTokenBytes,
      PROTOCOL_LIMITS.endpointEntropyBytes,
    ]);
    expect(entropy).toEqual([]);
  });

  it('authenticates hello and returns a bounded provider failure after auth', async () => {
    const running = await startFixture();
    const client = await connectClient(running.snapshot.record.endpoint.path);

    const hello = HelloResultSchema.parse(
      await client.connection.sendRequest(
        HelloRequestType,
        helloParams(running.snapshot),
      ),
    );
    expect(hello.instance.instanceId).toBe(running.snapshot.record.instanceId);
    expect(hello.capabilities).toEqual({
      extensionTools: [],
      cancellation: true,
    });

    const call = IpcCallToolResultSchema.parse(
      await client.connection.sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      }),
    );
    expect(call).toEqual({
      outcome: 'toolError',
      tool: 'get_editor_context',
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The provider is not available in this milestone.',
        retryable: false,
      },
    });

    await closeClient(client);
  });

  it('advertises a canonical handler seam and validates async handler results', async () => {
    const extensionTools: V1AllExtensionToolName[] = ['get_editor_context'];
    let calls = 0;
    let receivedAbortSignal = false;
    const callTool: IpcCallToolHandler = async (invocation, signal) => {
      calls += 1;
      receivedAbortSignal = signal instanceof AbortSignal;
      if (calls === 1) {
        return {
          outcome: 'toolError',
          tool: invocation.tool,
          error: {
            code: 'PROVIDER_UNAVAILABLE',
            message: 'The fixture handler ran.',
            retryable: false,
          },
        };
      }
      return { invalid: true };
    };
    const running = await startFixture({ extensionTools, callTool });
    const client = await connectClient(running.snapshot.record.endpoint.path);

    const hello = HelloResultSchema.parse(
      await client.connection.sendRequest(
        HelloRequestType,
        helloParams(running.snapshot),
      ),
    );
    expect(hello.capabilities.extensionTools).toEqual(extensionTools);

    const invocation = { tool: 'get_editor_context', arguments: {} };
    const first = IpcCallToolResultSchema.parse(
      await client.connection.sendRequest(CallToolRequestType, invocation),
    );
    expect(first).toMatchObject({
      outcome: 'toolError',
      error: { message: 'The fixture handler ran.' },
    });
    expect(receivedAbortSignal).toBe(true);

    const invalid = IpcCallToolResultSchema.parse(
      await client.connection.sendRequest(CallToolRequestType, invocation),
    );
    expect(invalid).toMatchObject({
      outcome: 'toolError',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The tool handler returned an invalid result.',
      },
    });

    await closeClient(client);
  });

  it('uses the shared scheduler to queue the fifth call on one connection', async () => {
    const gates = Array.from({ length: 5 }, () => deferred());
    let started = 0;
    const callTool: IpcCallToolHandler = async (invocation) => {
      const gate = gates[started];
      started += 1;
      if (gate === undefined) {
        throw new Error('The scheduler started an unexpected handler.');
      }
      await gate.promise;
      return completedHandlerResult(invocation.tool);
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool,
    });
    const client = await connectClient(running.snapshot.record.endpoint.path);
    await client.connection.sendRequest(
      HelloRequestType,
      helloParams(running.snapshot),
    );

    const requests = Array.from({ length: 5 }, () =>
      client.connection.sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      }),
    );
    await waitUntil(() => started === 4);
    expect(started).toBe(4);

    gates[0]?.resolve();
    IpcCallToolResultSchema.parse(await requests[0]);
    await waitUntil(() => started === 5);

    for (let index = 1; index < gates.length; index += 1) {
      gates[index]?.resolve();
    }
    const results = await Promise.all(requests);
    expect(results.map((result) => IpcCallToolResultSchema.parse(result))).toHaveLength(
      5,
    );
    await closeClient(client);
  });

  it('enforces the eight-active and sixteen-queued window limits across clients', async () => {
    const activeGates: Deferred[] = [];
    let blockHandlers = true;
    let started = 0;
    const callTool: IpcCallToolHandler = async (invocation) => {
      started += 1;
      if (blockHandlers) {
        const gate = deferred();
        activeGates.push(gate);
        await gate.promise;
      }
      return completedHandlerResult(invocation.tool);
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool,
    });
    const clients = await Promise.all(
      Array.from({ length: 4 }, () =>
        connectClient(running.snapshot.record.endpoint.path),
      ),
    );
    await Promise.all(
      clients.map((client) =>
        client.connection.sendRequest(HelloRequestType, helloParams(running.snapshot)),
      ),
    );
    const [first, second, third, fourth] = clients;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      throw new Error('The multi-client fixture did not create four clients.');
    }

    const activeRequests = [first, second].flatMap((client) =>
      Array.from({ length: 4 }, () =>
        client.connection.sendRequest(CallToolRequestType, {
          tool: 'get_editor_context',
          arguments: {},
        }),
      ),
    );
    await waitUntil(() => started === 8);

    const queuedRequests = Array.from({ length: 16 }, () =>
      third.connection.sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      }),
    );
    await expect(
      third.connection.sendRequest('vscode-mcp/test-barrier'),
    ).rejects.toMatchObject({ code: ErrorCodes.MethodNotFound });
    expect(started).toBe(8);

    const overflow = IpcCallToolResultSchema.parse(
      await fourth.connection.sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      }),
    );
    expect(overflow).toMatchObject({
      outcome: 'toolError',
      error: { code: 'SERVER_BUSY' },
    });

    blockHandlers = false;
    for (const gate of activeGates) {
      gate.resolve();
    }
    const accepted = await Promise.all([...activeRequests, ...queuedRequests]);
    expect(
      accepted.map((result) => IpcCallToolResultSchema.parse(result)),
    ).toHaveLength(24);
    await Promise.all(clients.map(closeClient));
  });

  it('cancels a queued real-socket request without starting its handler', async () => {
    const gates = Array.from({ length: 4 }, () => deferred());
    let started = 0;
    const callTool: IpcCallToolHandler = async (invocation) => {
      const gate = gates[started];
      started += 1;
      if (gate === undefined) {
        throw new Error('A cancelled queued handler was unexpectedly started.');
      }
      await gate.promise;
      return completedHandlerResult(invocation.tool);
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool,
    });
    const client = await connectClient(running.snapshot.record.endpoint.path);
    await client.connection.sendRequest(
      HelloRequestType,
      helloParams(running.snapshot),
    );

    const activeRequests = Array.from({ length: 4 }, () =>
      client.connection.sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      }),
    );
    await waitUntil(() => started === 4);
    const cancellation = new CancellationTokenSource();
    const queuedRequest = client.connection.sendRequest(
      CallToolRequestType,
      { tool: 'get_editor_context', arguments: {} },
      cancellation.token,
    );
    cancellation.cancel();

    const cancelled = IpcCallToolResultSchema.parse(await queuedRequest);
    expect(cancelled).toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED' },
    });
    expect(started).toBe(4);

    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(activeRequests);
    cancellation.dispose();
    await closeClient(client);
  });

  it('ignores unknown cancellation IDs and aborts the matching active handler', async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const callTool: IpcCallToolHandler = async (invocation, receivedSignal) => {
      signal = receivedSignal;
      await gate.promise;
      return completedHandlerResult(invocation.tool);
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool,
    });
    const client = await connectClient(running.snapshot.record.endpoint.path);
    await client.connection.sendRequest(
      HelloRequestType,
      helloParams(running.snapshot),
    );

    await client.connection.sendNotification(IPC_METHODS.cancelRequest, { id: 999 });
    const cancellation = new CancellationTokenSource();
    const request = client.connection.sendRequest(
      CallToolRequestType,
      { tool: 'get_editor_context', arguments: {} },
      cancellation.token,
    );
    await waitUntil(() => signal !== undefined);
    expect(signal?.aborted).toBe(false);

    cancellation.cancel();
    const result = IpcCallToolResultSchema.parse(await request);
    expect(result).toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED' },
    });
    expect(signal?.aborted).toBe(true);

    gate.resolve();
    cancellation.dispose();
    await closeClient(client);
  });

  it('gives each real-socket terminal race one winner and releases the session exactly once', async () => {
    type RaceEvent = 'completion' | 'cancellation' | 'timeout' | 'disconnect';
    const cases: ReadonlyArray<{
      readonly order: readonly RaceEvent[];
      readonly expectedCode: string | undefined;
    }> = [
      {
        order: ['completion', 'cancellation', 'timeout', 'disconnect'],
        expectedCode: 'PROVIDER_UNAVAILABLE',
      },
      {
        order: ['cancellation', 'completion', 'timeout', 'disconnect'],
        expectedCode: 'CANCELLED',
      },
      {
        order: ['timeout', 'completion', 'cancellation', 'disconnect'],
        expectedCode: 'TIMEOUT',
      },
      {
        order: ['disconnect', 'completion', 'timeout', 'cancellation'],
        expectedCode: undefined,
      },
    ];
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const recordUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('uncaughtException', recordUncaught);
    process.on('unhandledRejection', recordUnhandled);

    try {
      for (const testCase of cases) {
        const schedulerRuntime = new FakeSchedulerRuntime();
        const completion = deferred();
        const handlerReturned = deferred();
        let handlerCalls = 0;
        let raceSignal: AbortSignal | undefined;
        const running = await startFixture({
          extensionTools: ['get_editor_context'],
          schedulerRuntime,
          callTool: async (invocation, signal) => {
            handlerCalls += 1;
            if (handlerCalls === 1) {
              raceSignal = signal;
              await completion.promise;
              handlerReturned.resolve();
            }
            return completedHandlerResult(invocation.tool);
          },
        });
        const client = await connectRawClient(running.snapshot.record.endpoint.path);
        const helloRequest: RequestMessage = {
          jsonrpc: '2.0',
          id: 0,
          method: IPC_METHODS.hello,
          params: helloParams(running.snapshot),
        };
        await client.write(helloRequest);
        HelloSuccessResponseMessageSchema.parse(await client.nextMessage());
        const callRequest: RequestMessage = {
          jsonrpc: '2.0',
          id: 1,
          method: IPC_METHODS.callTool,
          params: { tool: 'get_editor_context', arguments: {} },
        };
        const cancellationNotification: NotificationMessage = {
          jsonrpc: '2.0',
          method: IPC_METHODS.cancelRequest,
          params: { id: 1 },
        };
        await client.write(callRequest);
        await waitUntil(() => raceSignal !== undefined);

        for (const [eventIndex, event] of testCase.order.entries()) {
          switch (event) {
            case 'completion':
              completion.resolve();
              await handlerReturned.promise;
              break;
            case 'cancellation':
              if (client.socket.closed) {
                await expect(client.write(cancellationNotification)).rejects.toThrow();
              } else {
                await client.write(cancellationNotification);
              }
              break;
            case 'timeout':
              schedulerRuntime.advanceBy(PROTOCOL_LIMITS.simpleOperationTimeoutMs);
              break;
            case 'disconnect': {
              const closed = once(client.socket, 'close');
              client.socket.destroy();
              await closed;
              break;
            }
          }

          if (eventIndex === 0 && testCase.expectedCode !== undefined) {
            const response = CallToolResponseMessageSchema.parse(
              await client.nextMessage(),
            );
            expect(response.id).toBe(1);
            expect(response.result).toMatchObject({
              outcome: 'toolError',
              error: { code: testCase.expectedCode },
            });
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(client.messageCount()).toBe(
            testCase.expectedCode === undefined ? 1 : 2,
          );
        }

        expect(raceSignal?.aborted).toBe(testCase.order[0] !== 'completion');
        client.dispose();

        // A new authenticated session and call prove that both connection admission
        // and scheduler capacity were released after every first-terminal ordering.
        const replacement = await connectClient(running.snapshot.record.endpoint.path);
        await replacement.connection.sendRequest(
          HelloRequestType,
          helloParams(running.snapshot),
        );
        const followUp = IpcCallToolResultSchema.parse(
          await replacement.connection.sendRequest(CallToolRequestType, {
            tool: 'get_editor_context',
            arguments: {},
          }),
        );
        expect(followUp).toMatchObject({
          outcome: 'toolError',
          error: { code: 'PROVIDER_UNAVAILABLE' },
        });
        expect(handlerCalls).toBe(2);
        await closeAuthenticatedSession(replacement);
        await running.service.stop();
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', recordUncaught);
      process.removeListener('unhandledRejection', recordUnhandled);
    }
  });

  it('rejects a duplicate outstanding JSON-RPC request ID and closes the session', async () => {
    const gate = deferred();
    let started = false;
    const callTool: IpcCallToolHandler = async (invocation) => {
      started = true;
      await gate.promise;
      return completedHandlerResult(invocation.tool);
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool,
    });
    const client = await connectRawClient(running.snapshot.record.endpoint.path);

    const helloRequest: RequestMessage = {
      jsonrpc: '2.0',
      id: 0,
      method: IPC_METHODS.hello,
      params: helloParams(running.snapshot),
    };
    await client.write(helloRequest);
    HelloSuccessResponseMessageSchema.parse(await client.nextMessage());

    const duplicateCall: RequestMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: IPC_METHODS.callTool,
      params: { tool: 'get_editor_context', arguments: {} },
    };
    await client.write(duplicateCall);
    await waitUntil(() => started);
    const closed = once(client.socket, 'close');
    await client.write(duplicateCall);

    const failure = IpcApplicationErrorResponseMessageSchema.parse(
      await client.nextMessage(),
    );
    expect(failure.error.data).toMatchObject({
      code: 'DUPLICATE_REQUEST_ID',
      fatal: true,
    });
    await closed;

    gate.resolve();
    client.dispose();
  });

  it('enforces the five-second simple and fifteen-second provider deadlines', async () => {
    const schedulerRuntime = new FakeSchedulerRuntime();
    const gates = [deferred(), deferred()];
    const signals: AbortSignal[] = [];
    let callIndex = 0;
    const callTool: IpcCallToolHandler = async (invocation, signal) => {
      const gate = gates[callIndex];
      callIndex += 1;
      signals.push(signal);
      if (gate === undefined) {
        throw new Error('The timeout fixture received an unexpected call.');
      }
      await gate.promise;
      return completedHandlerResult(invocation.tool);
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context', 'get_hover'],
      callTool,
      schedulerRuntime,
    });
    const client = await connectClient(running.snapshot.record.endpoint.path);
    await client.connection.sendRequest(
      HelloRequestType,
      helloParams(running.snapshot),
    );

    const simpleRequest = client.connection.sendRequest(CallToolRequestType, {
      tool: 'get_editor_context',
      arguments: {},
    });
    await waitUntil(() => signals.length === 1);
    schedulerRuntime.advanceBy(PROTOCOL_LIMITS.simpleOperationTimeoutMs - 1);
    expect(signals[0]?.aborted).toBe(false);
    schedulerRuntime.advanceBy(1);
    const simpleResult = IpcCallToolResultSchema.parse(await simpleRequest);
    expect(simpleResult).toMatchObject({
      outcome: 'toolError',
      error: { code: 'TIMEOUT' },
    });
    expect(signals[0]?.aborted).toBe(true);

    const providerRequest = client.connection.sendRequest(CallToolRequestType, {
      tool: 'get_hover',
      arguments: {
        document: {
          kind: 'workspacePath',
          workspaceFolderId: 'root',
          relativePath: 'src/index.ts',
        },
        position: { line: 0, character: 0 },
      },
    });
    await waitUntil(() => signals.length === 2);
    schedulerRuntime.advanceBy(PROTOCOL_LIMITS.providerOperationTimeoutMs - 1);
    expect(signals[1]?.aborted).toBe(false);
    schedulerRuntime.advanceBy(1);
    const providerResult = IpcCallToolResultSchema.parse(await providerRequest);
    expect(providerResult).toMatchObject({
      outcome: 'toolError',
      error: { code: 'TIMEOUT' },
    });
    expect(signals[1]?.aborted).toBe(true);

    for (const gate of gates) {
      gate.resolve();
    }
    await closeClient(client);
  });

  it('cancels active session work when the service stops', async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const callTool: IpcCallToolHandler = async (invocation, receivedSignal) => {
      signal = receivedSignal;
      await gate.promise;
      return completedHandlerResult(invocation.tool);
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool,
    });
    const client = await connectClient(running.snapshot.record.endpoint.path);
    await client.connection.sendRequest(
      HelloRequestType,
      helloParams(running.snapshot),
    );

    const request = client.connection
      .sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      })
      .then(
        () => undefined,
        () => undefined,
      );
    await waitUntil(() => signal !== undefined);
    await running.service.stop();
    client.connection.dispose();
    await request;
    expect(signal?.aborted).toBe(true);

    gate.resolve();
  });

  it('cancels active and queued session work together when the service stops', async () => {
    const gates = Array.from({ length: 4 }, () => deferred());
    const signals: AbortSignal[] = [];
    let started = 0;
    const callTool: IpcCallToolHandler = async (invocation, signal) => {
      const gate = gates[started];
      started += 1;
      signals.push(signal);
      if (gate === undefined) {
        throw new Error('Queued work started while the service was stopping.');
      }
      await gate.promise;
      return completedHandlerResult(invocation.tool);
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool,
    });
    const client = await connectClient(running.snapshot.record.endpoint.path);
    await client.connection.sendRequest(
      HelloRequestType,
      helloParams(running.snapshot),
    );

    const requests = Array.from({ length: 5 }, () =>
      client.connection
        .sendRequest(CallToolRequestType, {
          tool: 'get_editor_context',
          arguments: {},
        })
        .then(
          () => undefined,
          () => undefined,
        ),
    );
    await waitUntil(() => started === 4);
    await running.service.stop();
    client.connection.dispose();
    await Promise.all(requests);

    expect(started).toBe(4);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const gate of gates) {
      gate.resolve();
    }
  });

  it('returns the generic authentication error for a wrong token and closes', async () => {
    const running = await startFixture();
    const client = await connectClient(running.snapshot.record.endpoint.path);
    const closed = once(client.socket, 'close');
    const params = {
      ...helloParams(running.snapshot),
      authToken: 'B'.repeat(43),
    };

    let failure: unknown;
    try {
      await client.connection.sendRequest(HelloRequestType, params);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ResponseError);
    if (failure instanceof ResponseError) {
      expect(failure.code).toBe(IPC_APPLICATION_ERROR_CODE);
      expect(failure.message).toBe('Authentication failed');
      expect(failure.data).toBeUndefined();
    }
    await closed;
    expect(client.socket.destroyed).toBe(true);
    client.connection.dispose();
  });
});
