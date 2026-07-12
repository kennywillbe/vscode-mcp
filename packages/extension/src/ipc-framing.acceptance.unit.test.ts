import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BoundedJsonRpcMessageReader } from '@vscode-mcp/protocol/bounded-jsonrpc';
import {
  IPC_METHODS,
  IPC_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  PROTOCOL_LIMITS,
  TOOL_CONTRACT_VERSION,
} from '@vscode-mcp/protocol/constants';
import {
  HelloResultSchema,
  IpcCallToolResultSchema,
} from '@vscode-mcp/protocol/ipc-schemas';
import {
  discoverRegistryRecords,
  resolveRuntimeRegistryPaths,
  type RegistryRecordSnapshot,
  type RuntimeRegistryEnvironment,
} from '@vscode-mcp/protocol/runtime-registry';
import type { V1AllExtensionToolName } from '@vscode-mcp/protocol/tool-schemas-v1';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from 'vscode-jsonrpc/node';

import { IpcInstanceService, type IpcCallToolHandler } from './ipc-instance-service.js';

const fixtures: string[] = [];
const services: IpcInstanceService[] = [];
const clients = new Set<RawClient>();

afterEach(async () => {
  for (const client of clients) {
    client.destroy();
  }
  clients.clear();
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })),
  );
});

class MessageQueue {
  private readonly messages: Message[] = [];
  private readonly waiters: Array<(message: Message) => void> = [];
  public received = 0;

  public push(message: Message): void {
    this.received += 1;
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.messages.push(message);
      return;
    }
    waiter(message);
  }

  public next(): Promise<Message> {
    const message = this.messages.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class RawClient {
  public readonly messages = new MessageQueue();
  private readonly reader: BoundedJsonRpcMessageReader;

  public constructor(public readonly socket: Socket) {
    this.reader = new BoundedJsonRpcMessageReader(
      socket,
      PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
    );
    this.reader.onError(() => undefined);
    this.reader.listen((message) => this.messages.push(message));
  }

  public destroy(): void {
    this.reader.dispose();
    this.socket.destroy();
  }
}

interface RunningFixture {
  readonly snapshot: RegistryRecordSnapshot;
}

function posixRuntimeEnvironment(
  fixture: string,
  xdgRuntimeDirectory: string,
): RuntimeRegistryEnvironment {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('The IPC framing acceptance tests require POSIX sockets.');
  }
  if (typeof process.getuid !== 'function') {
    throw new Error('The IPC framing acceptance tests require a POSIX uid.');
  }
  return {
    platform: process.platform,
    uid: process.getuid(),
    xdgRuntimeDirectory,
    temporaryDirectory: fixture,
  };
}

async function startFixture(callTool: IpcCallToolHandler): Promise<RunningFixture> {
  // Keep the generated Unix-domain socket below Darwin's short path ceiling.
  const fixture = await mkdtemp(join('/tmp', 'vscode-mcp-framing-'));
  fixtures.push(fixture);
  const xdgRuntimeDirectory = join(fixture, 'xdg');
  const workspacePath = join(fixture, 'workspace');
  await mkdir(xdgRuntimeDirectory, { mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });

  const runtimeEnvironment = posixRuntimeEnvironment(fixture, xdgRuntimeDirectory);
  const service = new IpcInstanceService({
    identity: {
      extensionVersion: '1.0.0-test',
      displayName: 'Framing acceptance fixture',
      workspaceFingerprint: 'd'.repeat(64),
      workspaceFileUri: null,
      workspaceFolders: [
        {
          workspaceFolderId: 'workspace',
          name: 'Workspace',
          uri: pathToFileURL(workspacePath).href,
          canonicalPath: workspacePath,
        },
      ],
    },
    runtimeEnvironment,
    isEligible: () => true,
    extensionTools: ['get_editor_context'],
    callTool,
  });
  services.push(service);
  const started = await service.start();
  if (started.status !== 'ready') {
    throw new Error(`The framing fixture did not start: ${started.reason}`);
  }

  const resolution = await resolveRuntimeRegistryPaths(runtimeEnvironment);
  if (resolution.status !== 'ready') {
    throw new Error('The framing fixture runtime could not be resolved.');
  }
  const discovery = await discoverRegistryRecords(resolution.paths);
  if (discovery.status !== 'ready' || discovery.records.length !== 1) {
    throw new Error('Expected one framing fixture registry record.');
  }
  const snapshot = discovery.records[0];
  if (snapshot === undefined) {
    throw new Error('The framing fixture registry record is missing.');
  }
  return { snapshot };
}

async function openRawClient(endpoint: string): Promise<RawClient> {
  const socket = createConnection(endpoint);
  await once(socket, 'connect');
  socket.on('error', () => undefined);
  const client = new RawClient(socket);
  clients.add(client);
  return client;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageId(message: Message): number | undefined {
  const value: unknown = message;
  if (!isRecord(value)) {
    return undefined;
  }
  const id = value['id'];
  return typeof id === 'number' ? id : undefined;
}

function messageResult(message: Message): unknown {
  const value: unknown = message;
  return isRecord(value) ? value['result'] : undefined;
}

function helloRequest(snapshot: RegistryRecordSnapshot, id = 1): object {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: IPC_METHODS.hello,
    params: {
      protocolVersion: IPC_PROTOCOL_VERSION,
      toolContractVersion: TOOL_CONTRACT_VERSION,
      instanceId: snapshot.record.instanceId,
      authToken: snapshot.record.authToken,
      client: { name: 'vscode-mcp-bridge', version: '1.0.0-test' },
    },
  };
}

function callToolRequest(id = 2): object {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: IPC_METHODS.callTool,
    params: { tool: 'get_editor_context', arguments: {} },
  };
}

function serialize(value: unknown): Buffer {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('The test message is not serializable.');
  }
  return Buffer.from(serialized, 'utf8');
}

function frameMessage(value: unknown, exactBodyBytes?: number): Buffer {
  let body = serialize(value);
  if (exactBodyBytes !== undefined) {
    const paddingBytes = exactBodyBytes - body.byteLength;
    if (paddingBytes < 0) {
      throw new Error('The exact framing target is smaller than the JSON message.');
    }
    body = Buffer.concat([body, Buffer.alloc(paddingBytes, 0x20)]);
  }
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

async function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) {
    return;
  }
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
}

async function authenticate(
  client: RawClient,
  snapshot: RegistryRecordSnapshot,
): Promise<void> {
  await writeSocket(client.socket, frameMessage(helloRequest(snapshot)));
  const response = await client.messages.next();
  expect(messageId(response)).toBe(1);
  HelloResultSchema.parse(messageResult(response));
}

function providerFailure(tool: V1AllExtensionToolName): object {
  return {
    outcome: 'toolError',
    tool,
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The framing fixture handler ran.',
      retryable: false,
    },
  };
}

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

describePosix('real-socket IPC framing acceptance', () => {
  it('dispatches one request only after a frame fragmented at every byte boundary completes', async () => {
    let dispatches = 0;
    const running = await startFixture(async (invocation) => {
      dispatches += 1;
      return providerFailure(invocation.tool);
    });
    const client = await openRawClient(running.snapshot.record.endpoint.path);
    await authenticate(client, running.snapshot);

    const frame = frameMessage(callToolRequest());
    for (const byte of frame.subarray(0, -1)) {
      await writeSocket(client.socket, Buffer.from([byte]));
      await nextEventLoopTurn();
    }
    expect(dispatches).toBe(0);

    await writeSocket(client.socket, frame.subarray(-1));
    const response = await client.messages.next();
    expect(messageId(response)).toBe(2);
    IpcCallToolResultSchema.parse(messageResult(response));
    expect(dispatches).toBe(1);
  });

  it('reconstructs coalesced hello and tool frames once and in wire order', async () => {
    const dispatchOrder: string[] = [];
    const running = await startFixture(async (invocation) => {
      dispatchOrder.push(invocation.tool);
      return providerFailure(invocation.tool);
    });
    const client = await openRawClient(running.snapshot.record.endpoint.path);

    await writeSocket(
      client.socket,
      Buffer.concat([
        frameMessage(helloRequest(running.snapshot)),
        frameMessage(callToolRequest()),
      ]),
    );

    const helloResponse = await client.messages.next();
    const toolResponse = await client.messages.next();
    expect([messageId(helloResponse), messageId(toolResponse)]).toEqual([1, 2]);
    HelloResultSchema.parse(messageResult(helloResponse));
    IpcCallToolResultSchema.parse(messageResult(toolResponse));
    expect(dispatchOrder).toEqual(['get_editor_context']);
  });

  it('dispatches an exact 256 KiB application frame and isolates limit plus one', async () => {
    let dispatches = 0;
    const running = await startFixture(async (invocation) => {
      dispatches += 1;
      return providerFailure(invocation.tool);
    });
    const endpoint = running.snapshot.record.endpoint.path;

    const exact = await openRawClient(endpoint);
    await authenticate(exact, running.snapshot);
    const exactFrame = frameMessage(
      callToolRequest(),
      PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
    );
    await writeSocket(exact.socket, exactFrame);
    const exactResponse = await exact.messages.next();
    expect(messageId(exactResponse)).toBe(2);
    IpcCallToolResultSchema.parse(messageResult(exactResponse));
    expect(dispatches).toBe(1);

    const oversized = await openRawClient(endpoint);
    await authenticate(oversized, running.snapshot);
    const oversizedClosed = waitForSocketClose(oversized.socket);
    const oversizedFrame = frameMessage(
      callToolRequest(),
      PROTOCOL_LIMITS.bridgeToExtensionFrameBytes + 1,
    );
    oversized.socket.write(oversizedFrame, () => undefined);
    await oversizedClosed;
    expect(dispatches).toBe(1);

    const healthy = await openRawClient(endpoint);
    await authenticate(healthy, running.snapshot);
    await writeSocket(healthy.socket, frameMessage(callToolRequest()));
    const healthyResponse = await healthy.messages.next();
    expect(messageId(healthyResponse)).toBe(2);
    IpcCallToolResultSchema.parse(messageResult(healthyResponse));
    expect(dispatches).toBe(2);
  });

  it.each([
    [
      'missing',
      (length: number): string => {
        void length;
        return 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n';
      },
    ],
    [
      'duplicate',
      (length: number) =>
        `Content-Length: ${length}\r\nContent-Length: ${length}\r\n\r\n`,
    ],
    ['negative', (length: number) => `Content-Length: -${length}\r\n\r\n`],
    ['signed', (length: number) => `Content-Length: +${length}\r\n\r\n`],
    ['fractional', (length: number) => `Content-Length: ${length}.0\r\n\r\n`],
    [
      'hexadecimal',
      (length: number) => `Content-Length: 0x${length.toString(16)}\r\n\r\n`,
    ],
    ['non-numeric', () => 'Content-Length: many\r\n\r\n'],
    ['overflowing', () => 'Content-Length: 9007199254740992\r\n\r\n'],
    [
      'whitespace-corrupted',
      (length: number) => `Content-Length: ${length} ${length}\r\n\r\n`,
    ],
  ] as const)(
    'rejects a %s Content-Length over the service socket without dispatch or echo',
    async (_name, headerForLength) => {
      let dispatches = 0;
      const running = await startFixture(async (invocation) => {
        dispatches += 1;
        return providerFailure(invocation.tool);
      });
      const client = await openRawClient(running.snapshot.record.endpoint.path);
      await authenticate(client, running.snapshot);

      const body = serialize(callToolRequest());
      const closed = waitForSocketClose(client.socket);
      client.socket.write(
        Buffer.concat([Buffer.from(headerForLength(body.byteLength), 'ascii'), body]),
        () => undefined,
      );
      await closed;

      expect(dispatches).toBe(0);
      expect(client.messages.received).toBe(1);

      const healthy = await openRawClient(running.snapshot.record.endpoint.path);
      await authenticate(healthy, running.snapshot);
      await writeSocket(healthy.socket, frameMessage(callToolRequest()));
      const response = await healthy.messages.next();
      IpcCallToolResultSchema.parse(messageResult(response));
      expect(dispatches).toBe(1);
    },
  );
});
