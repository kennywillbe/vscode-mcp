import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BoundedJsonRpcMessageReader,
  BoundedJsonRpcMessageWriter,
} from '@vscode-mcp/protocol/bounded-jsonrpc';
import {
  IPC_METHODS,
  IPC_PROTOCOL_VERSION,
  PROTOCOL_LIMITS,
  TOOL_CONTRACT_VERSION,
} from '@vscode-mcp/protocol/constants';
import {
  RegistryRecordSchema,
  type RegistryRecord,
} from '@vscode-mcp/protocol/registry-schemas';
import {
  readRegistryRecordSnapshot,
  resolveRuntimeRegistryPaths,
  writeRegistryRecord,
  type RegistryRecordSnapshot,
  type RuntimeRegistryEnvironment,
  type RuntimeRegistryPaths,
} from '@vscode-mcp/protocol/runtime-registry';
import type { ExtensionToolInvocation } from '@vscode-mcp/protocol/tool-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message, ResponseMessage } from 'vscode-jsonrpc/node';

import { canonicalPathsEqual, probeRegistryRecord } from './ipc-client.js';
import { LocalInstanceRegistry } from './local-instance-registry.js';

const fixtures: string[] = [];
const servers: FixtureServer[] = [];

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeFixtureServer));
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })),
  );
});

describePosix('registry authentication acceptance', () => {
  it('M1-AUT-007 rejects every live registry/hello mismatch and verifies canonical roots', async () => {
    const { paths } = await fixtureRuntime();
    const firstRoot = join(paths.runtimeRoot, 'workspace-a');
    const secondRoot = join(paths.runtimeRoot, 'workspace-b');
    const aliasRoot = join(paths.runtimeRoot, 'workspace-alias');
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await symlink(firstRoot, aliasRoot);

    const base = fixtureRecord(paths, 1, [
      folder('root-a', aliasRoot, await realpath(firstRoot)),
      folder('root-b', secondRoot, await realpath(secondRoot)),
    ]);
    const matchingServer = await startFixtureServer(base.endpoint.path, () =>
      helloResult(base),
    );
    const verified = await probeRegistryRecord(snapshot(base));
    expect(verified).toMatchObject({ status: 'authenticated' });
    if (verified.status !== 'authenticated') {
      throw new Error('The matching live registry fixture did not authenticate.');
    }
    expect(verified.instance.canonicalWorkspaceRoots).toEqual([
      await realpath(firstRoot),
      await realpath(secondRoot),
    ]);
    expect(matchingServer.helloCalls).toBe(1);

    const otherRoot = join(paths.runtimeRoot, 'workspace-other');
    await mkdir(otherRoot);
    const firstFolder = required(base.workspaceFolders[0]);
    const secondFolder = required(base.workspaceFolders[1]);
    const cases: Array<{
      readonly label: string;
      readonly record: RegistryRecord;
      readonly hello: object;
    }> = [
      {
        label: 'instance ID / redirected endpoint',
        record: { ...base, endpoint: endpoint(paths, 2) },
        hello: helloResult(base, {
          instanceId: '00000000-0000-4000-8000-000000000099',
        }),
      },
      {
        label: 'protocol version',
        record: { ...base, protocolVersion: 2, endpoint: endpoint(paths, 3) },
        hello: helloResult(base),
      },
      {
        label: 'tool-contract version',
        record: {
          ...base,
          toolContractVersion: '0.2.0',
          endpoint: endpoint(paths, 4),
        },
        hello: helloResult(base),
      },
      {
        label: 'workspace fingerprint',
        record: { ...base, endpoint: endpoint(paths, 5) },
        hello: helloResult(base, { workspaceFingerprint: 'f'.repeat(64) }),
      },
      {
        label: 'workspace-folder order',
        record: { ...base, endpoint: endpoint(paths, 6) },
        hello: helloResult(base, {
          workspaceFolders: [...base.workspaceFolders].reverse(),
        }),
      },
      {
        label: 'canonical root',
        record: RegistryRecordSchema.parse({
          ...base,
          endpoint: endpoint(paths, 7),
          workspaceFolders: [
            { ...firstFolder, canonicalPath: await realpath(otherRoot) },
            secondFolder,
          ],
        }),
        hello: helloResult(base),
      },
      {
        label: 'non-file URI',
        record: { ...base, endpoint: endpoint(paths, 8) },
        hello: helloResult(base, {
          workspaceFolders: [
            { ...firstFolder, uri: 'https://invalid.example/root' },
            secondFolder,
          ],
        }),
      },
      {
        label: 'malformed URI',
        record: { ...base, endpoint: endpoint(paths, 9) },
        hello: helloResult(base, {
          workspaceFolders: [{ ...firstFolder, uri: 'not a URI' }, secondFolder],
        }),
      },
      {
        label: 'workspace-folder count',
        record: { ...base, endpoint: endpoint(paths, 10) },
        hello: helloResult(base, { workspaceFolders: [firstFolder] }),
      },
    ];

    for (const mismatch of cases) {
      const server = await startFixtureServer(
        mismatch.record.endpoint.path,
        () => mismatch.hello,
      );
      await expect(
        probeRegistryRecord(snapshot(RegistryRecordSchema.parse(mismatch.record))),
        mismatch.label,
      ).resolves.toEqual({ status: 'rejected' });
      expect(server.helloCalls, mismatch.label).toBe(1);
    }

    expect(
      canonicalPathsEqual('C:\\Workspace\\Root', 'c:\\workspace\\root', 'win32'),
    ).toBe(true);
    expect(canonicalPathsEqual('/Workspace/Root', '/workspace/root', 'linux')).toBe(
      false,
    );
  });

  it('M1-AUT-007 does not fail over from a pinned mismatched record', async () => {
    const { environment, paths } = await fixtureRuntime();
    const wrongRoot = join(paths.runtimeRoot, 'wrong-root');
    const liveRoot = join(paths.runtimeRoot, 'live-root');
    await Promise.all([mkdir(wrongRoot), mkdir(liveRoot)]);
    const wrong = await publish(paths, 20, wrongRoot);
    const live = await publish(paths, 21, liveRoot);
    await startFixtureServer(wrong.record.endpoint.path, () =>
      helloResult(wrong.record, { workspaceFingerprint: 'e'.repeat(64) }),
    );
    const liveServer = await startFixtureServer(live.record.endpoint.path, () =>
      helloResult(live.record),
    );

    const registry = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      upperBound: { kind: 'instance', instanceId: wrong.record.instanceId },
      canonicalCwd: liveRoot,
    });
    await expect(registry.list()).resolves.toMatchObject({
      instances: [],
      resolution: { selectedInstanceId: null, method: 'explicit' },
    });
    await expect(
      registry.call(editorInvocation(), null, new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'INSTANCE_NOT_FOUND' },
    });
    expect(liveServer.toolCalls).toBe(0);
  });

  it('M1-REG-012 enforces the real 3-second probe deadline without deleting a fresh record', async () => {
    const { environment, paths } = await fixtureRuntime();
    const root = join(paths.runtimeRoot, 'timeout-root');
    await mkdir(root);
    const pending = await publish(paths, 30, root, '2026-07-10T00:01:30.001Z');
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await listen(server, pending.record.endpoint.path);
    servers.push({ server, sockets, helloCalls: 0, toolCalls: 0 });

    const startedAt = Date.now();
    const result = await new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      now: () => Date.parse('2026-07-10T00:02:00.000Z'),
    }).list();
    const elapsed = Date.now() - startedAt;

    expect(PROTOCOL_LIMITS.endpointProbeTimeoutMs).toBe(3_000);
    expect(elapsed).toBeGreaterThanOrEqual(2_850);
    expect(elapsed).toBeLessThan(6_000);
    expect(result).toMatchObject({
      instances: [],
      resolution: { selectedInstanceId: null, method: 'none' },
    });
    await expect(
      readRegistryRecordSnapshot(paths, pending.record.instanceId),
    ).resolves.not.toBeNull();
  }, 8_000);

  it('M1-SEL-008 admits only the live match from mixed untrusted discovery', async () => {
    const { environment, paths } = await fixtureRuntime();
    const now = Date.parse('2026-07-10T00:02:00.000Z');
    const roots = await Promise.all(
      [40, 41, 42, 43].map(async (index) => {
        const root = join(paths.runtimeRoot, `mixed-${index}`);
        await mkdir(root);
        return root;
      }),
    );
    const stale = await publish(
      paths,
      40,
      required(roots[0]),
      '2026-07-10T00:00:00.000Z',
    );
    const freshUnreachable = await publish(
      paths,
      41,
      required(roots[1]),
      '2026-07-10T00:01:30.001Z',
    );
    const mismatch = await publish(
      paths,
      42,
      required(roots[2]),
      '2026-07-10T00:01:30.001Z',
    );
    const live = await publish(
      paths,
      43,
      required(roots[3]),
      '2026-07-10T00:01:30.001Z',
    );
    await startFixtureServer(mismatch.record.endpoint.path, () =>
      helloResult(mismatch.record, { workspaceFingerprint: 'd'.repeat(64) }),
    );
    await startFixtureServer(live.record.endpoint.path, () => helloResult(live.record));
    const malformedId = '00000000-0000-4000-8000-000000000044';
    await writeFile(join(paths.instancesDirectory, `${malformedId}.json`), '{bad', {
      mode: 0o600,
    });

    const result = await new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      canonicalCwd: await realpath(required(roots[3])),
      now: () => now,
      probe: async (candidate) =>
        candidate.instanceId === stale.instanceId ||
        candidate.instanceId === freshUnreachable.instanceId
          ? { status: 'rejected' }
          : probeRegistryRecord(candidate),
    }).list();

    expect(result.instances.map((instance) => instance.instanceId)).toEqual([
      live.record.instanceId,
    ]);
    expect(result.resolution).toEqual({
      selectedInstanceId: live.record.instanceId,
      method: 'cwd',
      candidateInstanceIds: [live.record.instanceId],
    });
    const visible = JSON.stringify(result);
    for (const forbidden of [
      stale.record.authToken,
      freshUnreachable.record.endpoint.path,
      mismatch.record.workspaceFingerprint,
      live.record.endpoint.path,
      String(live.record.pid),
    ]) {
      if (forbidden !== undefined) {
        expect(visible).not.toContain(forbidden);
      }
    }
    expect(visible).not.toContain('"canonicalPath"');
    await expect(
      readRegistryRecordSnapshot(paths, stale.record.instanceId),
    ).resolves.toBeNull();
    await expect(
      readRegistryRecordSnapshot(paths, freshUnreachable.record.instanceId),
    ).resolves.not.toBeNull();
    await expect(
      readRegistryRecordSnapshot(paths, mismatch.record.instanceId),
    ).resolves.not.toBeNull();
  });
});

interface FixtureServer {
  readonly server: Server;
  readonly sockets: Set<Socket>;
  helloCalls: number;
  toolCalls: number;
}

async function startFixtureServer(
  socketPath: string,
  hello: () => object,
): Promise<FixtureServer> {
  const state: FixtureServer = {
    server: createServer(),
    sockets: new Set(),
    helloCalls: 0,
    toolCalls: 0,
  };
  state.server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.once('close', () => state.sockets.delete(socket));
    const reader = new BoundedJsonRpcMessageReader(
      socket,
      PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
    );
    const writer = new BoundedJsonRpcMessageWriter(
      socket,
      PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
    );
    reader.listen((message) => {
      void handleFixtureMessage(state, socket, writer, message, hello).catch(() => {
        socket.destroy();
      });
    });
  });
  await listen(state.server, socketPath);
  servers.push(state);
  return state;
}

async function handleFixtureMessage(
  state: FixtureServer,
  socket: Socket,
  writer: BoundedJsonRpcMessageWriter,
  message: Message,
  hello: () => object,
): Promise<void> {
  const value: unknown = message;
  if (
    !isRecord(value) ||
    !isRequestId(value['id']) ||
    typeof value['method'] !== 'string'
  ) {
    socket.destroy();
    return;
  }
  let result: object;
  if (value['method'] === IPC_METHODS.hello) {
    state.helloCalls += 1;
    result = hello();
  } else if (value['method'] === IPC_METHODS.closeSession) {
    result = { closed: true };
  } else if (value['method'] === IPC_METHODS.callTool) {
    state.toolCalls += 1;
    result = editorContextSuccess();
  } else {
    socket.destroy();
    return;
  }

  const response: ResponseMessage = { jsonrpc: '2.0', id: value['id'], result };
  await writer.write(response);
  if (value['method'] === IPC_METHODS.closeSession) {
    socket.end();
  }
}

async function fixtureRuntime(): Promise<{
  readonly environment: RuntimeRegistryEnvironment;
  readonly paths: RuntimeRegistryPaths;
}> {
  if (typeof process.getuid !== 'function') {
    throw new Error('The registry acceptance fixtures require a POSIX uid.');
  }
  const fixture = await mkdtemp(join('/tmp', 'vmcp-ra-'));
  fixtures.push(fixture);
  const xdgRuntimeDirectory = join(fixture, 'xdg');
  await mkdir(xdgRuntimeDirectory, { mode: 0o700 });
  await chmod(xdgRuntimeDirectory, 0o700);
  const environment: RuntimeRegistryEnvironment = {
    platform: process.platform,
    uid: process.getuid(),
    xdgRuntimeDirectory,
    temporaryDirectory: fixture,
  };
  const resolution = await resolveRuntimeRegistryPaths(environment);
  if (resolution.status !== 'ready') {
    throw new Error('The registry acceptance runtime could not be prepared.');
  }
  return { environment, paths: resolution.paths };
}

async function publish(
  paths: RuntimeRegistryPaths,
  index: number,
  workspacePath: string,
  heartbeatAt = '2026-07-10T00:01:30.001Z',
): Promise<RegistryRecordSnapshot> {
  const record = fixtureRecord(
    paths,
    index,
    [folder(`root-${index}`, workspacePath, await realpath(workspacePath))],
    heartbeatAt,
  );
  await writeRegistryRecord(paths, record);
  const stored = await readRegistryRecordSnapshot(paths, record.instanceId);
  if (stored === null) {
    throw new Error('The registry acceptance record was not published.');
  }
  return stored;
}

function fixtureRecord(
  paths: RuntimeRegistryPaths,
  index: number,
  workspaceFolders: RegistryRecord['workspaceFolders'],
  heartbeatAt = '2026-07-10T00:01:30.001Z',
): RegistryRecord {
  return RegistryRecordSchema.parse({
    schemaVersion: 1,
    protocolVersion: IPC_PROTOCOL_VERSION,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    instanceId: instanceId(index),
    extensionVersion: '1.0.0-test',
    pid: 9000 + index,
    publishedAt: '2026-07-10T00:00:00.000Z',
    heartbeatAt,
    endpoint: endpoint(paths, index),
    authToken: String.fromCharCode(65 + (index % 20)).repeat(43),
    displayName: `Window ${index}`,
    workspaceFingerprint: (index % 10).toString().repeat(64),
    workspaceFileUri: null,
    workspaceFolders,
  });
}

function folder(
  workspaceFolderId: string,
  uriPath: string,
  canonicalPath: string,
): RegistryRecord['workspaceFolders'][number] {
  return {
    workspaceFolderId,
    name: workspaceFolderId,
    uri: pathToFileURL(uriPath).href,
    canonicalPath,
  };
}

function helloResult(
  record: RegistryRecord,
  overrides: {
    readonly instanceId?: string;
    readonly workspaceFingerprint?: string;
    readonly workspaceFolders?: readonly RegistryRecord['workspaceFolders'][number][];
  } = {},
): object {
  const folders = overrides.workspaceFolders ?? record.workspaceFolders;
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    workspaceFingerprint: overrides.workspaceFingerprint ?? record.workspaceFingerprint,
    instance: {
      instanceId: overrides.instanceId ?? record.instanceId,
      displayName: record.displayName,
      trusted: true,
      publishedAt: record.publishedAt,
      workspaceFileUri: record.workspaceFileUri,
      workspaceFolders: folders.map((folder_) => ({
        workspaceFolderId: folder_.workspaceFolderId,
        name: folder_.name,
        uri: folder_.uri,
      })),
      protocolVersion: IPC_PROTOCOL_VERSION,
      toolContractVersion: TOOL_CONTRACT_VERSION,
    },
    capabilities: { extensionTools: ['get_editor_context'], cancellation: true },
  };
}

function snapshot(record: RegistryRecord): RegistryRecordSnapshot {
  return {
    fileName: `${record.instanceId}.json`,
    instanceId: record.instanceId,
    record,
  };
}

function endpoint(
  paths: RuntimeRegistryPaths,
  index: number,
): RegistryRecord['endpoint'] {
  return { kind: 'unix', path: join(paths.socketsDirectory, `${index}.sock`) };
}

function instanceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function editorInvocation(): ExtensionToolInvocation {
  return { tool: 'get_editor_context', arguments: {} };
}

function editorContextSuccess(): object {
  return {
    outcome: 'success',
    observedAt: '2026-07-10T00:00:00.000Z',
    truncated: false,
    warnings: [],
    payload: {
      tool: 'get_editor_context',
      result: {
        activeEditor: null,
        visibleEditors: [],
        openDocuments: [],
        tabs: [],
        omitted: { editors: 0, documents: 0, tabs: 0 },
      },
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

async function closeFixtureServer(fixture: FixtureServer): Promise<void> {
  for (const socket of fixture.sockets) {
    socket.destroy();
  }
  if (!fixture.server.listening) {
    return;
  }
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('A required registry fixture value was missing.');
  }
  return value;
}
