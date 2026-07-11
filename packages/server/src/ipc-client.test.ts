import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BoundedJsonRpcMessageReader,
  BoundedJsonRpcMessageWriter,
} from '@vscode-mcp/protocol/bounded-jsonrpc';
import {
  IPC_PROTOCOL_VERSION,
  PROTOCOL_LIMITS,
  TOOL_CONTRACT_VERSION,
} from '@vscode-mcp/protocol/constants';
import { RegistryRecordSchema } from '@vscode-mcp/protocol/registry-schemas';
import type { RegistryRecordSnapshot } from '@vscode-mcp/protocol/runtime-registry';
import {
  CallToolRequestType,
  HelloRequestType,
} from '@vscode-mcp/protocol/rpc-methods';
import type { ExtensionToolInvocation } from '@vscode-mcp/protocol/tool-schemas';
import {
  createMessageConnection,
  NullLogger,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it } from 'vitest';

import { callRegistryRecord, probeRegistryRecord } from './ipc-client.js';

const fixtures: string[] = [];
const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

describePosix('IPC client', () => {
  it('fails closed on a real absent Unix socket without a late process error', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'vscode-mcp-ipc-absent-'));
    fixtures.push(fixture);
    const socketPath = join(fixture, 'no-listener.sock');
    const snapshot = await canonicalSnapshot(socketPath);
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
      await expect(probeRegistryRecord(snapshot, { timeoutMs: 500 })).resolves.toEqual({
        status: 'rejected',
      });
      await expect(
        callRegistryRecord(snapshot, hoverInvocation(), { timeoutMs: 500 }),
      ).resolves.toEqual({ status: 'disconnected' });

      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(uncaught).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', recordUncaught);
      process.removeListener('unhandledRejection', recordUnhandled);
    }
  });

  it('settles a pending tool call when the authenticated socket closes', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'vscode-mcp-ipc-client-'));
    fixtures.push(fixture);
    const socketPath = join(fixture, 'extension.sock');
    const snapshot = await canonicalSnapshot(socketPath);
    const entered = deferred();
    let peerSocket: Socket | undefined;
    let peerConnection: MessageConnection | undefined;

    const server = createServer((socket) => {
      peerSocket = socket;
      const connection = createMessageConnection(
        new BoundedJsonRpcMessageReader(
          socket,
          PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
        ),
        new BoundedJsonRpcMessageWriter(
          socket,
          PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
        ),
        NullLogger,
      );
      peerConnection = connection;
      connection.onRequest(HelloRequestType, () => helloResult(snapshot));
      connection.onRequest(CallToolRequestType, async () => {
        entered.resolve();
        connection.dispose();
        socket.destroy();
        return await new Promise<never>(() => undefined);
      });
      connection.listen();
    });

    try {
      await listen(server, socketPath);
      const resultPromise = callRegistryRecord(snapshot, hoverInvocation(), {
        connect: (path) => createConnection(path),
      });

      await withDeadline(entered.promise, 'peer tool handler');
      await expect(withDeadline(resultPromise, 'pending tool call')).resolves.toEqual({
        status: 'disconnected',
      });
    } finally {
      peerConnection?.dispose();
      peerSocket?.destroy();
      await closeServer(server);
    }
  });
});

async function canonicalSnapshot(socketPath: string): Promise<RegistryRecordSnapshot> {
  const initialSnapshot = fixtureSnapshot(socketPath);
  const workspaceFolder = initialSnapshot.record.workspaceFolders[0];
  if (workspaceFolder === undefined) {
    throw new Error('The IPC fixture workspace is missing.');
  }
  await mkdir(workspaceFolder.canonicalPath, { recursive: true });
  return {
    ...initialSnapshot,
    record: {
      ...initialSnapshot.record,
      workspaceFolders: [
        {
          ...workspaceFolder,
          canonicalPath: await realpath(workspaceFolder.canonicalPath),
        },
      ],
    },
  };
}

function fixtureSnapshot(socketPath: string): RegistryRecordSnapshot {
  const workspacePath = join(socketPath, '..', 'workspace');
  const record = RegistryRecordSchema.parse({
    schemaVersion: 1,
    protocolVersion: IPC_PROTOCOL_VERSION,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    instanceId: '00000000-0000-4000-8000-000000000001',
    extensionVersion: '1.0.0',
    pid: 42,
    publishedAt: '2026-07-10T00:00:00.000Z',
    heartbeatAt: '2026-07-10T00:00:00.000Z',
    endpoint: { kind: 'unix', path: socketPath },
    authToken: 'A'.repeat(43),
    displayName: 'IPC fixture',
    workspaceFingerprint: '1'.repeat(64),
    workspaceFileUri: null,
    workspaceFolders: [
      {
        workspaceFolderId: 'workspace',
        name: 'Workspace',
        uri: pathToFileURL(workspacePath).href,
        canonicalPath: workspacePath,
      },
    ],
  });
  return { fileName: 'fixture.json', instanceId: record.instanceId, record };
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

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function withDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle.`)), 1_000);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
