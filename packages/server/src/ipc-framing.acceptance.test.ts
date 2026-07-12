import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
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
import { RegistryRecordSchema } from '@vscode-mcp/protocol/registry-schemas';
import type { RegistryRecordSnapshot } from '@vscode-mcp/protocol/runtime-registry';
import type { ExtensionToolInvocation } from '@vscode-mcp/protocol/tool-schemas';
import { describe, expect, it } from 'vitest';
import type { Message } from 'vscode-jsonrpc/node';

import { callRegistryRecord } from './ipc-client.js';

type ResponseMode = 'exact' | 'oversized' | 'healthy';

interface FakeExtension {
  readonly connectionCount: () => number;
  readonly close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestIdentity(
  message: Message,
): { readonly id: number; readonly method: string } | undefined {
  const value: unknown = message;
  if (!isRecord(value)) {
    return undefined;
  }
  const id = value['id'];
  const method = value['method'];
  return typeof id === 'number' && typeof method === 'string'
    ? { id, method }
    : undefined;
}

function serialize(value: unknown): Buffer {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('The fake extension message is not serializable.');
  }
  return Buffer.from(serialized, 'utf8');
}

function frameMessage(value: unknown, exactBodyBytes?: number): Buffer {
  let body = serialize(value);
  if (exactBodyBytes !== undefined) {
    const paddingBytes = exactBodyBytes - body.byteLength;
    if (paddingBytes < 0) {
      throw new Error('The transport target is smaller than the response message.');
    }
    // Padding is JSON whitespace and disappears during parsing. The application result
    // stays small; this exercises only the independent 2 MiB transport ceiling.
    body = Buffer.concat([body, Buffer.alloc(paddingBytes, 0x20)]);
  }
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

function fixtureSnapshot(
  socketPath: string,
  canonicalWorkspacePath: string,
): RegistryRecordSnapshot {
  const record = RegistryRecordSchema.parse({
    schemaVersion: 1,
    protocolVersion: IPC_PROTOCOL_VERSION,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    instanceId: '00000000-0000-4000-8000-000000000005',
    extensionVersion: '1.0.0-test',
    pid: 42,
    publishedAt: '2026-07-10T00:00:00.000Z',
    heartbeatAt: '2026-07-10T00:00:00.000Z',
    endpoint: { kind: 'unix', path: socketPath },
    authToken: 'A'.repeat(43),
    displayName: 'Framing acceptance fixture',
    workspaceFingerprint: '5'.repeat(64),
    workspaceFileUri: null,
    workspaceFolders: [
      {
        workspaceFolderId: 'workspace',
        name: 'Workspace',
        uri: pathToFileURL(canonicalWorkspacePath).href,
        canonicalPath: canonicalWorkspacePath,
      },
    ],
  });
  return {
    fileName: `${record.instanceId}.json`,
    instanceId: record.instanceId,
    record,
  };
}

function helloResult(snapshot: RegistryRecordSnapshot): object {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    workspaceFingerprint: snapshot.record.workspaceFingerprint,
    instance: {
      instanceId: snapshot.record.instanceId,
      displayName: snapshot.record.displayName,
      trusted: true,
      publishedAt: snapshot.record.publishedAt,
      workspaceFileUri: snapshot.record.workspaceFileUri,
      workspaceFolders: snapshot.record.workspaceFolders.map((folder) => ({
        workspaceFolderId: folder.workspaceFolderId,
        name: folder.name,
        uri: folder.uri,
      })),
      protocolVersion: IPC_PROTOCOL_VERSION,
      toolContractVersion: TOOL_CONTRACT_VERSION,
    },
    capabilities: { extensionTools: ['get_hover'], cancellation: true },
  };
}

function toolResult(): object {
  return {
    outcome: 'toolError',
    tool: 'get_hover',
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The synthetic extension response was accepted.',
      retryable: false,
    },
  };
}

function hoverInvocation(): ExtensionToolInvocation {
  return {
    tool: 'get_hover',
    arguments: {
      document: {
        kind: 'workspacePath',
        workspaceFolderId: 'workspace',
        relativePath: 'index.ts',
      },
      position: { line: 0, character: 0 },
    },
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startFakeExtension(
  socketPath: string,
  snapshot: RegistryRecordSnapshot,
  modes: readonly ResponseMode[],
): Promise<FakeExtension> {
  let acceptedConnections = 0;
  const sockets = new Set<Socket>();
  const readers = new Set<BoundedJsonRpcMessageReader>();
  const server = createServer((socket) => {
    const mode = modes[acceptedConnections];
    acceptedConnections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    if (mode === undefined) {
      socket.destroy();
      return;
    }

    const reader = new BoundedJsonRpcMessageReader(
      socket,
      PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
    );
    readers.add(reader);
    reader.onError(() => undefined);
    reader.onClose(() => readers.delete(reader));
    reader.listen((message) => {
      const request = requestIdentity(message);
      if (request === undefined) {
        socket.destroy();
        return;
      }

      if (request.method === IPC_METHODS.hello) {
        socket.write(
          frameMessage({
            jsonrpc: JSON_RPC_VERSION,
            id: request.id,
            result: helloResult(snapshot),
          }),
          () => undefined,
        );
        return;
      }

      if (request.method === IPC_METHODS.callTool) {
        const bodyBytes =
          mode === 'exact'
            ? PROTOCOL_LIMITS.extensionToBridgeFrameBytes
            : mode === 'oversized'
              ? PROTOCOL_LIMITS.extensionToBridgeFrameBytes + 1
              : undefined;
        socket.write(
          frameMessage(
            {
              jsonrpc: JSON_RPC_VERSION,
              id: request.id,
              result: toolResult(),
            },
            bodyBytes,
          ),
          () => undefined,
        );
        return;
      }

      if (request.method === IPC_METHODS.closeSession) {
        socket.end(
          frameMessage({
            jsonrpc: JSON_RPC_VERSION,
            id: request.id,
            result: { closed: true },
          }),
        );
        return;
      }

      socket.destroy();
    });
  });
  await listen(server, socketPath);

  return {
    connectionCount: () => acceptedConnections,
    close: async () => {
      for (const reader of readers) {
        reader.dispose();
      }
      readers.clear();
      await closeServer(server, sockets);
    },
  };
}

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

describePosix('bridge extension-to-client framing acceptance', () => {
  it('accepts exactly 2 MiB, rejects limit plus one, and reconnects cleanly', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'vscode-mcp-bridge-framing-'));
    const socketPath = join(fixture, 'extension.sock');
    const workspacePath = join(fixture, 'workspace');
    await mkdir(workspacePath);
    const snapshot = fixtureSnapshot(socketPath, await realpath(workspacePath));
    const fakeExtension = await startFakeExtension(socketPath, snapshot, [
      'exact',
      'oversized',
      'healthy',
    ]);

    try {
      const exact = await callRegistryRecord(snapshot, hoverInvocation());
      expect(exact).toMatchObject({
        status: 'completed',
        result: {
          outcome: 'toolError',
          tool: 'get_hover',
          error: { message: 'The synthetic extension response was accepted.' },
        },
      });
      expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBeLessThan(
        PROTOCOL_LIMITS.mcpResultBytes,
      );

      const oversized = await callRegistryRecord(snapshot, hoverInvocation());
      expect(oversized).toEqual({ status: 'disconnected' });

      const healthy = await callRegistryRecord(snapshot, hoverInvocation());
      expect(healthy).toMatchObject({ status: 'completed' });
      expect(fakeExtension.connectionCount()).toBe(3);
    } finally {
      await fakeExtension.close();
      await rm(fixture, { force: true, recursive: true });
    }
  });
});
