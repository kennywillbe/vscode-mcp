import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readRegistryRecordSnapshot,
  resolveRuntimeRegistryPaths,
  writeRegistryRecord,
  type RegistryRecordSnapshot,
  type RuntimeRegistryEnvironment,
  type RuntimeRegistryPaths,
} from '@vscode-mcp/protocol/runtime-registry';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthenticatedInstance } from './ipc-client.js';
import { LocalInstanceRegistry } from './local-instance-registry.js';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })),
  );
});

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

describePosix('stale registry cleanup hardening', () => {
  it('retains fresh failures and authenticated stale records but removes only an unchanged stale record', async () => {
    const { environment, paths } = await fixtureRuntime();
    const freshRejected = await publish(paths, 1, '2026-07-10T00:01:30.001Z');
    const staleAuthenticated = await publish(paths, 2, '2026-07-10T00:00:00.000Z');
    const staleRejected = await publish(paths, 3, '2026-07-10T00:00:00.000Z');
    await writeFile(staleRejected.record.endpoint.path, 'endpoint-sentinel', {
      mode: 0o600,
    });

    const registry = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      now: () => Date.parse('2026-07-10T00:02:00.000Z'),
      probe: async (snapshot) =>
        snapshot.instanceId === staleAuthenticated.instanceId
          ? {
              status: 'authenticated',
              instance: authenticatedInstance(staleAuthenticated),
            }
          : { status: 'rejected' },
    });

    const result = await registry.list();
    expect(result.instances.map((instance) => instance.instanceId)).toEqual([
      staleAuthenticated.instanceId,
    ]);
    await expect(
      readRegistryRecordSnapshot(paths, freshRejected.instanceId),
    ).resolves.not.toBeNull();
    await expect(
      readRegistryRecordSnapshot(paths, staleAuthenticated.instanceId),
    ).resolves.not.toBeNull();
    await expect(
      readRegistryRecordSnapshot(paths, staleRejected.instanceId),
    ).resolves.toBeNull();
    await expect(readFile(staleRejected.record.endpoint.path, 'utf8')).resolves.toBe(
      'endpoint-sentinel',
    );
  });

  it('loses the compare-delete race when a heartbeat, token, and endpoint rotate during the failed probe', async () => {
    const { environment, paths } = await fixtureRuntime();
    const original = await publish(paths, 4, '2026-07-10T00:00:00.000Z');
    const replacementHeartbeat = '2026-07-10T00:02:00.000Z';
    const replacementEndpoint = join(paths.socketsDirectory, 'replacement.sock');
    const replacementToken = 'Z'.repeat(43);

    const registry = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      now: () => Date.parse('2026-07-10T00:02:00.000Z'),
      probe: async () => {
        await writeRegistryRecord(paths, {
          ...original.record,
          heartbeatAt: replacementHeartbeat,
          endpoint: { kind: 'unix', path: replacementEndpoint },
          authToken: replacementToken,
        });
        return { status: 'rejected' };
      },
    });

    await registry.list();

    const current = await readRegistryRecordSnapshot(paths, original.instanceId);
    expect(current?.record).toMatchObject({
      heartbeatAt: replacementHeartbeat,
      endpoint: { kind: 'unix', path: replacementEndpoint },
      authToken: replacementToken,
    });
  });
});

async function fixtureRuntime(): Promise<{
  readonly environment: RuntimeRegistryEnvironment;
  readonly paths: RuntimeRegistryPaths;
}> {
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    typeof process.getuid !== 'function'
  ) {
    throw new Error('The stale cleanup fixtures require POSIX.');
  }

  const fixture = await mkdtemp(join(tmpdir(), 'vscode-mcp-stale-hardening-'));
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
    throw new Error('The stale cleanup fixture runtime was not ready.');
  }
  return { environment, paths: resolution.paths };
}

async function publish(
  paths: RuntimeRegistryPaths,
  index: number,
  heartbeatAt: string,
): Promise<RegistryRecordSnapshot> {
  const instanceId = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
  const workspacePath = join(paths.runtimeRoot, `workspace-${index}`);
  await writeRegistryRecord(paths, {
    schemaVersion: 1,
    protocolVersion: 1,
    toolContractVersion: '1.0.0',
    instanceId,
    extensionVersion: '1.0.0-test',
    pid: 42,
    publishedAt: '2026-07-10T00:00:00.000Z',
    heartbeatAt,
    endpoint: {
      kind: 'unix',
      path: join(paths.socketsDirectory, `${index}.sock`),
    },
    authToken: String.fromCharCode(64 + index).repeat(43),
    displayName: `Window ${index}`,
    workspaceFingerprint: index.toString(16).padStart(64, '0'),
    workspaceFileUri: null,
    workspaceFolders: [
      {
        workspaceFolderId: `root-${index}`,
        name: `Workspace ${index}`,
        uri: pathToFileURL(workspacePath).href,
        canonicalPath: workspacePath,
      },
    ],
  });
  const snapshot = await readRegistryRecordSnapshot(paths, instanceId);
  if (snapshot === null) {
    throw new Error('The stale cleanup fixture record was not published.');
  }
  return snapshot;
}

function authenticatedInstance(
  snapshot: RegistryRecordSnapshot,
): AuthenticatedInstance {
  return {
    safeDescriptor: {
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
      protocolVersion: 1,
      toolContractVersion: '1.0.0',
    },
    canonicalWorkspaceRoots: snapshot.record.workspaceFolders.map(
      (folder) => folder.canonicalPath,
    ),
    capabilities: { extensionTools: [], cancellation: true },
  };
}
