import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import {
  HelloResultSchema,
  IpcCallToolResultSchema,
  type IpcTransportErrorData,
} from '@vscode-mcp/protocol/ipc-schemas';
import {
  CallToolRequestType,
  HelloRequestType,
} from '@vscode-mcp/protocol/rpc-methods';
import {
  discoverRegistryRecords,
  resolveRuntimeRegistryPaths,
  type RegistryRecordSnapshot,
  type RuntimeRegistryEnvironment,
  type RuntimeRegistryPaths,
} from '@vscode-mcp/protocol/runtime-registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMessageConnection,
  ResponseError,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

import { IpcInstanceService, type IpcCallToolHandler } from './ipc-instance-service.js';

const fixtures: string[] = [];
const services: IpcInstanceService[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })),
  );
});

interface RunningFixture {
  readonly service: IpcInstanceService;
  readonly paths: RuntimeRegistryPaths;
  readonly snapshot: RegistryRecordSnapshot;
}

interface StartFixtureOptions {
  readonly extensionTools?: readonly ['get_editor_context'];
  readonly callTool?: IpcCallToolHandler;
  readonly fixtureName?: string;
}

interface TestClient {
  readonly socket: Socket;
  readonly connection: MessageConnection;
}

function posixPlatform(): 'darwin' | 'linux' {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform;
  }
  throw new Error('The IPC hardening tests require a POSIX platform.');
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('The IPC hardening tests require a POSIX uid.');
  }
  return process.getuid();
}

async function startFixture(
  options: StartFixtureOptions = {},
): Promise<RunningFixture> {
  const fixture = await mkdtemp(
    join('/tmp', options.fixtureName ?? 'vscode-mcp-ipc-hardening-'),
  );
  fixtures.push(fixture);
  const xdgRuntimeDirectory = join(fixture, 'xdg');
  const workspacePath = join(fixture, 'workspace');
  await mkdir(xdgRuntimeDirectory, { mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });

  const runtimeEnvironment: RuntimeRegistryEnvironment = {
    platform: posixPlatform(),
    uid: currentUid(),
    xdgRuntimeDirectory,
    temporaryDirectory: fixture,
  };
  const service = new IpcInstanceService({
    identity: {
      extensionVersion: '1.0.0-test',
      displayName: 'Security fixture',
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
    runtimeEnvironment,
    isEligible: () => true,
    ...(options.extensionTools === undefined
      ? {}
      : { extensionTools: options.extensionTools }),
    ...(options.callTool === undefined ? {} : { callTool: options.callTool }),
  });
  services.push(service);
  const result = await service.start();
  if (result.status !== 'ready') {
    throw new Error(`The IPC hardening fixture failed to start: ${result.reason}`);
  }

  const resolution = await resolveRuntimeRegistryPaths(runtimeEnvironment);
  if (resolution.status !== 'ready') {
    throw new Error('The IPC hardening runtime was not available.');
  }
  const snapshot = await onlySnapshot(resolution.paths);
  return { service, paths: resolution.paths, snapshot };
}

async function onlySnapshot(
  paths: RuntimeRegistryPaths,
): Promise<RegistryRecordSnapshot> {
  const discovery = await discoverRegistryRecords(paths);
  if (discovery.status !== 'ready' || discovery.records.length !== 1) {
    throw new Error('Expected exactly one published IPC record.');
  }
  const snapshot = discovery.records[0];
  if (snapshot === undefined) {
    throw new Error('The published IPC record is missing.');
  }
  return snapshot;
}

function trackSocket(socket: Socket): Socket {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  return socket;
}

async function connectSocket(path: string): Promise<Socket> {
  const socket = trackSocket(createConnection(path));
  await once(socket, 'connect');
  return socket;
}

async function connectClient(path: string): Promise<TestClient> {
  const socket = await connectSocket(path);
  const connection = createMessageConnection(
    new BoundedJsonRpcMessageReader(
      socket,
      PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
    ),
    new BoundedJsonRpcMessageWriter(
      socket,
      PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
    ),
  );
  connection.listen();
  return { socket, connection };
}

function helloParams(snapshot: RegistryRecordSnapshot): object {
  return {
    protocolVersion: 1,
    toolContractVersion: '1.0.0',
    instanceId: snapshot.record.instanceId,
    authToken: snapshot.record.authToken,
    client: { name: 'vscode-mcp-bridge', version: '1.0.0-test' },
  };
}

async function authenticate(client: TestClient, snapshot: RegistryRecordSnapshot) {
  return HelloResultSchema.parse(
    await client.connection.sendRequest(HelloRequestType, helloParams(snapshot)),
  );
}

async function responseError(
  operation: Promise<unknown>,
): Promise<ResponseError<IpcTransportErrorData>> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof ResponseError) {
      return error as ResponseError<IpcTransportErrorData>;
    }
    throw error;
  }
  throw new Error('Expected the JSON-RPC request to fail.');
}

async function waitForClose(socket: Socket, timeoutMs = 6_000): Promise<void> {
  if (socket.destroyed) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(socket, 'close').then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('The IPC socket did not close before the deadline.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function closeClient(client: TestClient): Promise<void> {
  if (!client.socket.destroyed) {
    const closed = once(client.socket, 'close');
    client.connection.end();
    await closed;
  }
  client.connection.dispose();
}

function wrongToken(current: string): string {
  const first = current.startsWith('A') ? 'B' : 'A';
  return `${first}${current.slice(1)}`;
}

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

describePosix('IpcInstanceService Milestone 4 hardening', () => {
  it('keeps four authenticated connections alive and closes the fifth', async () => {
    const running = await startFixture();
    const clients: TestClient[] = [];
    for (let index = 0; index < PROTOCOL_LIMITS.connectionsPerWindow; index += 1) {
      const client = await connectClient(running.snapshot.record.endpoint.path);
      clients.push(client);
      await authenticate(client, running.snapshot);
    }

    const fifth = trackSocket(createConnection(running.snapshot.record.endpoint.path));
    const fifthClosed = once(fifth, 'close');
    await once(fifth, 'connect');
    await fifthClosed;
    expect(fifth.destroyed).toBe(true);

    const existingResult = IpcCallToolResultSchema.parse(
      await clients[0]?.connection.sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      }),
    );
    expect(existingResult).toMatchObject({
      outcome: 'toolError',
      error: { code: 'PROVIDER_UNAVAILABLE' },
    });

    await Promise.all(clients.map(closeClient));
  });

  it('closes an idle pre-authentication connection at the exact handshake deadline', async () => {
    const running = await startFixture();
    expect(PROTOCOL_LIMITS.handshakeTimeoutMs).toBe(3_000);
    const startedAt = Date.now();
    const socket = await connectSocket(running.snapshot.record.endpoint.path);

    await waitForClose(socket, 8_000);

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(PROTOCOL_LIMITS.handshakeTimeoutMs - 150);
    expect(elapsed).toBeLessThan(PROTOCOL_LIMITS.handshakeTimeoutMs + 4_000);

    const healthy = await connectClient(running.snapshot.record.endpoint.path);
    await authenticate(healthy, running.snapshot);
    await closeClient(healthy);
  }, 10_000);

  it('rejects the complete non-hello first-message table and a repeated hello generically', async () => {
    let dispatchedCalls = 0;
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool: async () => {
        dispatchedCalls += 1;
        throw new Error('A pre-authentication tool request was dispatched.');
      },
    });

    const preAuth = await connectClient(running.snapshot.record.endpoint.path);
    const preAuthFailure = await responseError(
      preAuth.connection.sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      }),
    );
    expect(preAuthFailure).toMatchObject({
      code: IPC_APPLICATION_ERROR_CODE,
      message: 'Authentication failed',
      data: undefined,
    });
    await waitForClose(preAuth.socket);
    preAuth.connection.dispose();

    const otherMethod = await connectClient(running.snapshot.record.endpoint.path);
    const otherMethodFailure = await responseError(
      otherMethod.connection.sendRequest('vscode-mcp/unexpected', {}),
    );
    expect(otherMethodFailure).toMatchObject({
      code: IPC_APPLICATION_ERROR_CODE,
      message: 'Authentication failed',
      data: undefined,
    });
    await waitForClose(otherMethod.socket);
    otherMethod.connection.dispose();

    for (const [method, params] of [
      ['vscode-mcp/unexpectedNotification', {}],
      [IPC_METHODS.cancelRequest, { id: 0 }],
    ] as const) {
      const notification = await connectClient(running.snapshot.record.endpoint.path);
      await notification.connection.sendNotification(method, params);
      await waitForClose(notification.socket);
      notification.connection.dispose();
    }

    const batch = await connectSocket(running.snapshot.record.endpoint.path);
    let batchResponseBytes = 0;
    batch.on('data', (chunk: Buffer) => {
      batchResponseBytes += chunk.byteLength;
    });
    const batchBody = Buffer.from(
      JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 7,
          method: IPC_METHODS.hello,
          params: helloParams(running.snapshot),
        },
      ]),
      'utf8',
    );
    batch.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${batchBody.byteLength}\r\n\r\n`, 'ascii'),
        batchBody,
      ]),
    );
    await waitForClose(batch);
    expect(batchResponseBytes).toBe(0);
    expect(dispatchedCalls).toBe(0);

    const repeated = await connectClient(running.snapshot.record.endpoint.path);
    await authenticate(repeated, running.snapshot);
    const repeatedFailure = await responseError(
      repeated.connection.sendRequest(HelloRequestType, helloParams(running.snapshot)),
    );
    expect(repeatedFailure).toMatchObject({
      code: IPC_APPLICATION_ERROR_CODE,
      message: 'Authentication failed',
      data: undefined,
    });
    await waitForClose(repeated.socket);
    repeated.connection.dispose();
  });

  it('reveals version mismatch detail only after successful authentication', async () => {
    const running = await startFixture();
    const authenticated = await connectClient(running.snapshot.record.endpoint.path);
    const authenticatedFailure = await responseError(
      authenticated.connection.sendRequest(HelloRequestType, {
        ...helloParams(running.snapshot),
        protocolVersion: 2,
      }),
    );
    expect(authenticatedFailure).toMatchObject({
      code: IPC_APPLICATION_ERROR_CODE,
      message: 'Protocol version mismatch',
      data: { code: 'PROTOCOL_VERSION_MISMATCH', fatal: true },
    });
    const authenticatedText = JSON.stringify(authenticatedFailure);
    expect(authenticatedText).not.toContain(running.snapshot.record.authToken);
    expect(authenticatedText).not.toContain(running.snapshot.record.endpoint.path);
    await waitForClose(authenticated.socket);
    authenticated.connection.dispose();

    const unauthenticated = await connectClient(running.snapshot.record.endpoint.path);
    const unauthenticatedFailure = await responseError(
      unauthenticated.connection.sendRequest(HelloRequestType, {
        ...helloParams(running.snapshot),
        protocolVersion: 2,
        authToken: wrongToken(running.snapshot.record.authToken),
      }),
    );
    expect(unauthenticatedFailure).toMatchObject({
      code: IPC_APPLICATION_ERROR_CODE,
      message: 'Authentication failed',
      data: undefined,
    });
    await waitForClose(unauthenticated.socket);
    unauthenticated.connection.dispose();
  });

  it('rotates the endpoint and token on restart and rejects the previous credentials', async () => {
    const running = await startFixture();
    const previous = running.snapshot;
    await running.service.stop();

    const restarted = await running.service.start();
    expect(restarted.status).toBe('ready');
    const current = await onlySnapshot(running.paths);
    expect(current.record.instanceId).not.toBe(previous.record.instanceId);
    expect(current.record.authToken).not.toBe(previous.record.authToken);
    expect(current.record.endpoint.path).not.toBe(previous.record.endpoint.path);

    const staleClient = await connectClient(current.record.endpoint.path);
    const staleFailure = await responseError(
      staleClient.connection.sendRequest(HelloRequestType, helloParams(previous)),
    );
    expect(staleFailure).toMatchObject({
      code: IPC_APPLICATION_ERROR_CODE,
      message: 'Authentication failed',
      data: undefined,
    });
    await waitForClose(staleClient.socket);
    staleClient.connection.dispose();

    const currentClient = await connectClient(current.record.endpoint.path);
    const hello = await authenticate(currentClient, current);
    expect(hello.instance.instanceId).toBe(current.record.instanceId);
    await closeClient(currentClient);
  });

  it('survives malformed and oversized frames without affecting later clients', async () => {
    const running = await startFixture();
    const endpoint = running.snapshot.record.endpoint.path;

    const oversized = await connectSocket(endpoint);
    const oversizedClosed = once(oversized, 'close');
    oversized.write(
      `Content-Length: ${PROTOCOL_LIMITS.bridgeToExtensionFrameBytes + 1}\r\n\r\n`,
      'ascii',
    );
    await oversizedClosed;

    const malformed = await connectSocket(endpoint);
    const malformedClosed = once(malformed, 'close');
    malformed.write(
      Buffer.concat([
        Buffer.from('Content-Length: 1\r\n\r\n', 'ascii'),
        Buffer.from([0xff]),
      ]),
    );
    await malformedClosed;

    const healthy = await connectClient(endpoint);
    await authenticate(healthy, running.snapshot);
    await closeClient(healthy);
  });

  it('sanitizes handler and authentication failures and removes owned lifecycle data', async () => {
    const secretCanaries = [
      'SOURCE_CONTENT_CANARY_7a62',
      'PROVIDER_OUTPUT_CANARY_b149',
      'ABSOLUTE_PATH_CANARY_c083',
      'REQUEST_BODY_CANARY_18de',
    ] as const;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const callTool: IpcCallToolHandler = async () => {
      throw new Error(secretCanaries.join('|'));
    };
    const running = await startFixture({
      extensionTools: ['get_editor_context'],
      callTool,
      fixtureName: 'vscode-mcp-ABSOLUTE_PATH_CANARY_c083-',
    });
    const endpoint = running.snapshot.record.endpoint.path;
    const recordPath = join(
      running.paths.instancesDirectory,
      `${running.snapshot.record.instanceId}.json`,
    );

    const client = await connectClient(endpoint);
    await authenticate(client, running.snapshot);
    const handlerFailure = IpcCallToolResultSchema.parse(
      await client.connection.sendRequest(CallToolRequestType, {
        tool: 'get_editor_context',
        arguments: {},
      }),
    );
    const handlerFailureText = JSON.stringify(handlerFailure);
    expect(handlerFailure).toMatchObject({
      outcome: 'toolError',
      error: { code: 'INTERNAL_ERROR', message: 'The tool handler failed.' },
    });
    for (const canary of secretCanaries) {
      expect(handlerFailureText).not.toContain(canary);
    }
    expect(handlerFailureText).not.toContain(running.snapshot.record.authToken);
    expect(handlerFailureText).not.toContain(endpoint);
    await closeClient(client);

    const rejected = await connectClient(endpoint);
    const authenticationFailure = await responseError(
      rejected.connection.sendRequest(HelloRequestType, {
        ...helloParams(running.snapshot),
        authToken: wrongToken(running.snapshot.record.authToken),
      }),
    );
    const authenticationText = JSON.stringify(authenticationFailure);
    expect(authenticationFailure.message).toBe('Authentication failed');
    expect(authenticationFailure.data).toBeUndefined();
    expect(authenticationText).not.toContain(running.snapshot.record.authToken);
    expect(authenticationText).not.toContain(endpoint);
    await waitForClose(rejected.socket);
    rejected.connection.dispose();

    await running.service.stop();
    await expect(lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
