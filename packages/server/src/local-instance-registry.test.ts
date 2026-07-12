import { chmod, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
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
import type { ExtensionToolInvocation } from '@vscode-mcp/protocol/tool-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedInstance } from './ipc-client.js';
import { LocalInstanceRegistry } from './local-instance-registry.js';

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

describePosix('local instance registry', () => {
  it('returns only authenticated records with deterministic cwd selection', async () => {
    const { environment, paths } = await fixtureRuntime();
    const first = await publish(paths, 1, '/workspace');
    await publish(paths, 2, '/other');

    const registry = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      canonicalCwd: '/workspace/src',
      probe: authenticate,
    });
    const result = await registry.list();

    expect(result.instances.map((instance) => instance.instanceId)).toEqual([
      first.record.instanceId,
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(result.resolution).toEqual({
      selectedInstanceId: first.record.instanceId,
      method: 'cwd',
      candidateInstanceIds: [first.record.instanceId],
    });
  });

  it('applies a pinned instance as a visibility upper bound', async () => {
    const { environment, paths } = await fixtureRuntime();
    await publish(paths, 1, '/workspace');
    const second = await publish(paths, 2, '/other');

    const result = await new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      upperBound: { kind: 'instance', instanceId: second.record.instanceId },
      canonicalCwd: '/workspace',
      probe: authenticate,
    }).list();

    expect(result.instances.map((instance) => instance.instanceId)).toEqual([
      second.record.instanceId,
    ]);
    expect(result.resolution.selectedInstanceId).toBe(second.record.instanceId);
    expect(result.resolution.method).toBe('explicit');
  });

  it('deletes only stale rejected records and keeps incompatible records', async () => {
    const { environment, paths } = await fixtureRuntime();
    const rejected = await publish(paths, 1, '/workspace', '2026-07-10T00:00:00.000Z');
    const incompatible = await publish(paths, 2, '/other', '2026-07-10T00:00:00.000Z');
    const now = Date.parse('2026-07-10T00:02:00.000Z');

    const registry = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      now: () => now,
      probe: async (snapshot) =>
        snapshot.instanceId === rejected.instanceId
          ? { status: 'rejected' }
          : { status: 'incompatible' },
    });
    await expect(registry.list()).resolves.toMatchObject({ instances: [] });

    await expect(
      readRegistryRecordSnapshot(paths, rejected.record.instanceId),
    ).resolves.toBeNull();
    await expect(
      readRegistryRecordSnapshot(paths, incompatible.record.instanceId),
    ).resolves.not.toBeNull();
  });

  it('resolves an authenticated instance per call and forwards cancellation', async () => {
    const { environment, paths } = await fixtureRuntime();
    const snapshot = await publish(paths, 1, '/workspace');
    const controller = new AbortController();
    const callRecord = vi.fn(async () => ({
      status: 'completed' as const,
      instance: authenticatedInstance(snapshot),
      result: editorContextSuccess(),
    }));
    const registry = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      canonicalCwd: '/workspace/src',
      probe: authenticate,
      callRecord,
    });

    await expect(
      registry.call(editorInvocation(), null, controller.signal),
    ).resolves.toEqual({
      status: 'completed',
      instanceId: snapshot.record.instanceId,
      result: editorContextSuccess(),
    });
    expect(callRecord).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: snapshot.record.instanceId }),
      editorInvocation(),
      { signal: controller.signal },
    );
  });

  it('maps ambiguous and pinned-scope selection failures to public errors', async () => {
    const { environment, paths } = await fixtureRuntime();
    const first = await publish(paths, 1, '/workspace');
    const second = await publish(paths, 2, '/other');
    const callRecord = vi.fn();

    const ambiguous = await new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      canonicalCwd: null,
      probe: authenticate,
      callRecord,
    }).call(editorInvocation(), null, new AbortController().signal);
    expect(ambiguous).toMatchObject({
      status: 'failed',
      error: { code: 'INSTANCE_AMBIGUOUS', retryable: false },
    });

    const outsidePinnedScope = await new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      upperBound: { kind: 'instance', instanceId: first.record.instanceId },
      probe: authenticate,
      callRecord,
    }).call(editorInvocation(), second.record.instanceId, new AbortController().signal);
    expect(outsidePinnedScope).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_ARGUMENT', retryable: false },
    });
    expect(callRecord).not.toHaveBeenCalled();
  });

  it('suggests one recently observed same-workspace replacement instance', async () => {
    const { environment, paths } = await fixtureRuntime();
    const original = await publish(paths, 1, '/workspace');
    const registry = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      probe: authenticate,
    });
    await registry.list();
    await unlink(join(paths.instancesDirectory, original.fileName));
    const replacement = await publish(paths, 2, '/workspace');

    await expect(
      registry.call(
        editorInvocation(),
        original.record.instanceId,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'INSTANCE_NOT_FOUND',
        retryable: true,
        details: { replacementInstanceId: replacement.record.instanceId },
      },
    });
  });

  it('omits a replacement hint when same-workspace identity is ambiguous', async () => {
    const { environment, paths } = await fixtureRuntime();
    const original = await publish(paths, 1, '/workspace');
    const registry = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      probe: authenticate,
    });
    await registry.list();
    await unlink(join(paths.instancesDirectory, original.fileName));
    await publish(paths, 2, '/workspace');
    await publish(paths, 3, '/workspace');

    await expect(
      registry.call(
        editorInvocation(),
        original.record.instanceId,
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'INSTANCE_NOT_FOUND',
        message: 'No eligible VS Code instance matches this request.',
        retryable: true,
      },
    });
  });

  it('expires replacement identity history and never hints across a pinned instance', async () => {
    const { environment, paths } = await fixtureRuntime();
    const original = await publish(paths, 1, '/workspace');
    let now = 1_000;
    const expiring = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      now: () => now,
      probe: authenticate,
    });
    await expiring.list();
    await unlink(join(paths.instancesDirectory, original.fileName));
    const replacement = await publish(paths, 2, '/workspace');
    now += 60_001;
    const expired = await expiring.call(
      editorInvocation(),
      original.record.instanceId,
      new AbortController().signal,
    );
    expect(expired).toMatchObject({
      status: 'failed',
      error: { code: 'INSTANCE_NOT_FOUND' },
    });
    expect(expired.status === 'failed' ? expired.error : null).not.toHaveProperty(
      'details',
    );

    const pinned = new LocalInstanceRegistry({
      runtimeEnvironment: environment,
      upperBound: { kind: 'instance', instanceId: original.record.instanceId },
      probe: authenticate,
    });
    await publish(paths, 1, '/workspace');
    await pinned.list();
    await unlink(join(paths.instancesDirectory, original.fileName));
    const pinnedResult = await pinned.call(
      editorInvocation(),
      original.record.instanceId,
      new AbortController().signal,
    );
    expect(pinnedResult).toMatchObject({
      status: 'failed',
      error: { code: 'INSTANCE_NOT_FOUND' },
    });
    expect(
      pinnedResult.status === 'failed' ? pinnedResult.error : null,
    ).not.toHaveProperty('details');
    expect(replacement.record.instanceId).not.toBe(original.record.instanceId);
  });

  it.each([
    ['disconnected', 'INSTANCE_DISCONNECTED', true],
    ['rejected', 'INSTANCE_DISCONNECTED', true],
    ['incompatible', 'INSTANCE_DISCONNECTED', true],
    ['capabilityUnavailable', 'PROVIDER_UNAVAILABLE', false],
  ] as const)(
    'maps %s call status to %s',
    async (status, expectedCode, expectedRetryable) => {
      const { environment, paths } = await fixtureRuntime();
      await publish(paths, 1, '/workspace');
      const registry = new LocalInstanceRegistry({
        runtimeEnvironment: environment,
        canonicalCwd: '/workspace',
        probe: authenticate,
        callRecord: async () => ({ status }),
      });

      await expect(
        registry.call(editorInvocation(), null, new AbortController().signal),
      ).resolves.toMatchObject({
        status: 'failed',
        error: { code: expectedCode, retryable: expectedRetryable },
      });
    },
  );

  it('returns CANCELLED without discovery when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = vi.fn();
    const callRecord = vi.fn();
    const registry = new LocalInstanceRegistry({ probe, callRecord });

    await expect(
      registry.call(editorInvocation(), null, controller.signal),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'CANCELLED' },
    });
    expect(probe).not.toHaveBeenCalled();
    expect(callRecord).not.toHaveBeenCalled();
  });
});

async function fixtureRuntime(): Promise<{
  environment: RuntimeRegistryEnvironment;
  paths: RuntimeRegistryPaths;
}> {
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    typeof process.getuid !== 'function'
  ) {
    throw new Error('POSIX runtime required.');
  }

  const fixture = await mkdtemp(join(tmpdir(), 'vscode-mcp-local-registry-'));
  fixtures.push(fixture);
  const xdg = join(fixture, 'xdg');
  await mkdir(xdg, { mode: 0o700 });
  await chmod(xdg, 0o700);
  const environment: RuntimeRegistryEnvironment = {
    platform: process.platform,
    uid: process.getuid(),
    xdgRuntimeDirectory: xdg,
    temporaryDirectory: fixture,
  };
  const resolution = await resolveRuntimeRegistryPaths(environment);
  if (resolution.status !== 'ready') {
    throw new Error('Fixture runtime unavailable.');
  }
  return { environment, paths: resolution.paths };
}

async function publish(
  paths: RuntimeRegistryPaths,
  index: number,
  workspacePath: string,
  heartbeatAt = '2026-07-10T00:00:05.000Z',
): Promise<RegistryRecordSnapshot> {
  const instanceId = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
  await writeRegistryRecord(paths, {
    schemaVersion: 1,
    protocolVersion: 1,
    toolContractVersion: '1.0.0',
    instanceId,
    extensionVersion: '0.0.0',
    pid: 42,
    publishedAt: '2026-07-10T00:00:00.000Z',
    heartbeatAt,
    endpoint: { kind: 'unix', path: join(paths.socketsDirectory, `${index}.sock`) },
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
    throw new Error('Fixture registry record was not published.');
  }
  return snapshot;
}

async function authenticate(snapshot: RegistryRecordSnapshot) {
  return {
    status: 'authenticated' as const,
    instance: authenticatedInstance(snapshot),
  };
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
    capabilities: {
      extensionTools: ['get_editor_context'],
      cancellation: true,
    },
  };
}

function editorInvocation(): ExtensionToolInvocation {
  return { tool: 'get_editor_context', arguments: {} };
}

function editorContextSuccess() {
  return {
    outcome: 'success' as const,
    observedAt: '2026-07-10T00:00:00.000Z',
    truncated: false,
    warnings: [],
    payload: {
      tool: 'get_editor_context' as const,
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
