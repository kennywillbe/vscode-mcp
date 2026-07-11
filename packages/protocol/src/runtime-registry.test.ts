import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { PROTOCOL_LIMITS } from './constants.js';
import { RegistryRecordSchema, type RegistryRecord } from './registry-schemas.js';
import {
  REGISTRY_DISCOVERY_MAX_RECORDS,
  REGISTRY_HEARTBEAT_INTERVAL_MS,
  REGISTRY_RECORD_MAX_BYTES,
  NODE_RUNTIME_REGISTRY_DEPENDENCIES,
  REGISTRY_STALE_AFTER_MS,
  RuntimeRegistryError,
  compareAndDeleteUnchangedRegistryRecord,
  discoverRegistryRecords,
  isRegistryRecordStale,
  readRegistryRecordSnapshot,
  resolveRuntimeRegistryPaths,
  writeRegistryRecord,
  type RuntimeRegistryDependencies,
  type RuntimeRegistryEnvironment,
  type RuntimeRegistryPaths,
  type SupportedPosixPlatform,
} from './runtime-registry.js';

const fixtures: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      await rm(fixture, { force: true, recursive: true });
    }),
  );
});

function posixPlatform(): SupportedPosixPlatform {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return process.platform;
  }
  throw new Error('These fixtures require a POSIX platform.');
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('These fixtures require a POSIX uid.');
  }
  return process.getuid();
}

async function createFixture(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), 'vscode-mcp-registry-test-'));
  fixtures.push(fixture);
  return fixture;
}

function environment(
  temporaryDirectory: string,
  xdgRuntimeDirectory: string | undefined,
  uid = currentUid(),
): RuntimeRegistryEnvironment {
  return {
    platform: posixPlatform(),
    uid,
    xdgRuntimeDirectory,
    temporaryDirectory,
  };
}

async function requireReadyPaths(fixture: string): Promise<RuntimeRegistryPaths> {
  const xdgRuntimeDirectory = join(fixture, 'xdg');
  await mkdir(xdgRuntimeDirectory, { mode: 0o700 });
  const result = await resolveRuntimeRegistryPaths(
    environment(fixture, xdgRuntimeDirectory),
  );
  if (result.status !== 'ready') {
    throw new Error('Expected the test runtime to be ready.');
  }
  return result.paths;
}

function instanceId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function recordFor(
  paths: RuntimeRegistryPaths,
  index: number,
  heartbeatAt = '2026-07-10T12:00:00.000Z',
): RegistryRecord {
  const id = instanceId(index);
  const workspacePath = join(paths.runtimeRoot, `workspace-${index}`);
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    toolContractVersion: '1.0.0',
    instanceId: id,
    extensionVersion: '1.0.0',
    pid: Math.max(process.pid, 1),
    publishedAt: '2026-07-10T12:00:00.000Z',
    heartbeatAt,
    endpoint: {
      kind: 'unix',
      path: join(paths.socketsDirectory, `socket-${index}`),
    },
    authToken: 'A'.repeat(PROTOCOL_LIMITS.authTokenBase64UrlCharacters),
    displayName: `fixture-${index}`,
    workspaceFingerprint: 'a'.repeat(64),
    workspaceFileUri: null,
    workspaceFolders: [
      {
        workspaceFolderId: `root-${index}`,
        name: `fixture-${index}`,
        uri: pathToFileURL(workspacePath).href,
        canonicalPath: workspacePath,
      },
    ],
  };
}

async function writeRawRecord(
  paths: RuntimeRegistryPaths,
  record: RegistryRecord,
): Promise<void> {
  const path = join(paths.instancesDirectory, `${record.instanceId}.json`);
  await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
}

function permissionMode(mode: number): number {
  return mode & 0o7777;
}

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

describe('runtime registry platform support', () => {
  it('fails closed on Windows until ACL enforcement is implemented', async () => {
    const result = await resolveRuntimeRegistryPaths({
      platform: 'win32',
      uid: undefined,
      xdgRuntimeDirectory: undefined,
      temporaryDirectory: 'C:\\Temp',
    });

    expect(result).toEqual({
      status: 'unsupported',
      reason: 'WINDOWS_ACL_NOT_IMPLEMENTED',
    });
  });

  it.each([undefined, -1, 1.5, Number.NaN])(
    'fails closed when the current uid is unavailable or invalid: %s',
    async (uid) => {
      const result = await resolveRuntimeRegistryPaths({
        platform: process.platform === 'linux' ? 'linux' : 'darwin',
        uid,
        xdgRuntimeDirectory: undefined,
        temporaryDirectory: '/tmp',
      });

      expect(result).toEqual({
        status: 'unavailable',
        reason: 'CURRENT_UID_UNAVAILABLE',
      });
    },
  );
});

describePosix('POSIX runtime registry', () => {
  it('creates the XDG runtime, instances, and sockets directories as 0700', async () => {
    const fixture = await createFixture();
    const xdgRuntimeDirectory = join(fixture, 'xdg');
    await mkdir(xdgRuntimeDirectory, { mode: 0o700 });

    const result = await resolveRuntimeRegistryPaths(
      environment(fixture, xdgRuntimeDirectory),
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      return;
    }
    expect(result.paths.runtimeRoot).toBe(join(xdgRuntimeDirectory, 'vscode-mcp'));
    for (const path of [
      result.paths.runtimeRoot,
      result.paths.instancesDirectory,
      result.paths.socketsDirectory,
    ]) {
      const stats = await lstat(path);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.uid).toBe(currentUid());
      expect(permissionMode(stats.mode)).toBe(0o700);
    }
  });

  it('falls back when the XDG directory is permissive or a symlink', async () => {
    for (const unsafeKind of ['mode', 'symlink']) {
      const fixture = await createFixture();
      const xdgTarget = join(fixture, `xdg-target-${unsafeKind}`);
      await mkdir(xdgTarget, { mode: 0o700 });

      let xdgRuntimeDirectory = xdgTarget;
      if (unsafeKind === 'mode') {
        await chmod(xdgTarget, 0o755);
      } else {
        xdgRuntimeDirectory = join(fixture, 'xdg-link');
        await symlink(xdgTarget, xdgRuntimeDirectory);
      }

      const result = await resolveRuntimeRegistryPaths(
        environment(fixture, xdgRuntimeDirectory),
      );
      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.paths.runtimeRoot).toBe(
          join(fixture, `vscode-mcp-${currentUid()}`),
        );
      }
    }
  });

  it.each(['absent', 'relative', 'missing'] as const)(
    'uses the secure temporary fallback when XDG_RUNTIME_DIR is %s',
    async (xdgState) => {
      const fixture = await createFixture();
      const xdgRuntimeDirectory =
        xdgState === 'absent'
          ? undefined
          : xdgState === 'relative'
            ? 'relative/runtime'
            : join(fixture, 'missing-xdg');

      const result = await resolveRuntimeRegistryPaths(
        environment(fixture, xdgRuntimeDirectory),
      );

      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.paths.runtimeRoot).toBe(
          join(fixture, `vscode-mcp-${currentUid()}`),
        );
      }
    },
  );

  it('fails closed when XDG is absent and the temporary path is relative', async () => {
    const result = await resolveRuntimeRegistryPaths(
      environment('relative/tmp', undefined),
    );

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'NO_SECURE_RUNTIME_DIRECTORY',
    });
  });

  it('fails closed when neither candidate can be secured', async () => {
    const fixture = await createFixture();
    const unsafeXdg = join(fixture, 'unsafe-xdg');
    const temporaryTarget = join(fixture, 'temporary-target');
    const temporaryLink = join(fixture, 'temporary-link');
    await mkdir(unsafeXdg, { mode: 0o755 });
    await mkdir(temporaryTarget, { mode: 0o700 });
    await symlink(temporaryTarget, temporaryLink);

    const result = await resolveRuntimeRegistryPaths(
      environment(temporaryLink, unsafeXdg),
    );

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'NO_SECURE_RUNTIME_DIRECTORY',
    });
  });

  it('fails closed when the supplied uid does not own either candidate', async () => {
    const fixture = await createFixture();
    const xdgRuntimeDirectory = join(fixture, 'xdg');
    await mkdir(xdgRuntimeDirectory, { mode: 0o700 });

    const result = await resolveRuntimeRegistryPaths(
      environment(fixture, xdgRuntimeDirectory, currentUid() + 1),
    );

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'NO_SECURE_RUNTIME_DIRECTORY',
    });
  });

  it('publishes 0600 records atomically without discoverable temp files', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const initial = recordFor(paths, 1);
    await writeRegistryRecord(paths, initial);

    const destination = join(paths.instancesDirectory, `${initial.instanceId}.json`);
    expect(permissionMode((await lstat(destination)).mode)).toBe(0o600);
    expect(await readdir(paths.instancesDirectory)).toEqual([
      `${initial.instanceId}.json`,
    ]);

    const observedHeartbeats = new Set<string>();
    const writer = async (): Promise<void> => {
      for (let index = 1; index <= 20; index += 1) {
        await writeRegistryRecord(paths, {
          ...initial,
          heartbeatAt: new Date(
            Date.parse(initial.heartbeatAt) + index * 1_000,
          ).toISOString(),
        });
      }
    };
    const reader = async (): Promise<void> => {
      for (let index = 0; index < 80; index += 1) {
        const snapshot = await readRegistryRecordSnapshot(paths, initial.instanceId);
        expect(snapshot).not.toBeNull();
        if (snapshot !== null) {
          observedHeartbeats.add(snapshot.record.heartbeatAt);
        }
      }
    };

    await Promise.all([writer(), reader()]);

    expect(observedHeartbeats.size).toBeGreaterThan(0);
    expect(
      (await readdir(paths.instancesDirectory)).every((name) => name.endsWith('.json')),
    ).toBe(true);
    expect(
      RegistryRecordSchema.safeParse(JSON.parse(await readFile(destination, 'utf8')))
        .success,
    ).toBe(true);
  });

  it('rejects a strict but oversized record before publication', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const base = recordFor(paths, 2);
    const oversized = {
      ...base,
      workspaceFolders: Array.from({ length: 3 }, (_, index) => ({
        workspaceFolderId: `large-${index}`,
        name: `large-${index}`,
        uri: `file:///workspace-${index}`,
        canonicalPath: `/${'x'.repeat(30_000)}-${index}`,
      })),
    };

    expect(RegistryRecordSchema.safeParse(oversized).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(
      REGISTRY_RECORD_MAX_BYTES,
    );
    await expect(writeRegistryRecord(paths, oversized)).rejects.toMatchObject({
      code: 'REGISTRY_RECORD_TOO_LARGE',
    });
    expect(await readdir(paths.instancesDirectory)).toEqual([]);
  });

  it('publishes and discovers a schema-valid record at exactly 64 KiB', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const base = recordFor(paths, 23);
    const maximized = {
      ...base,
      workspaceFileUri: 'file:///w',
      workspaceFolders: [
        {
          ...base.workspaceFolders[0],
          uri: `file:///${'u'.repeat(16_384 - 'file:///'.length)}`,
          canonicalPath: `/${'p'.repeat(32_768 - 1)}`,
        },
      ],
    };
    const remainingBytes =
      REGISTRY_RECORD_MAX_BYTES - Buffer.byteLength(JSON.stringify(maximized), 'utf8');
    expect(remainingBytes).toBeGreaterThan(0);
    const exact = {
      ...maximized,
      workspaceFileUri: `file:///w${'x'.repeat(remainingBytes)}`,
    };

    expect(RegistryRecordSchema.safeParse(exact).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(
      REGISTRY_RECORD_MAX_BYTES,
    );

    await writeRegistryRecord(paths, exact);
    const discovery = await discoverRegistryRecords(paths);
    expect(discovery.status).toBe('ready');
    expect(discovery.records.map((snapshot) => snapshot.instanceId)).toEqual([
      exact.instanceId,
    ]);
  });

  it('ignores malformed, oversized, symlinked, and permissive records', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const valid = recordFor(paths, 3);
    await writeRegistryRecord(paths, valid);

    const malformedId = instanceId(4);
    const malformedPath = join(paths.instancesDirectory, `${malformedId}.json`);
    await writeFile(malformedPath, '{', { mode: 0o600 });
    await chmod(malformedPath, 0o600);

    const oversizedId = instanceId(5);
    const oversizedPath = join(paths.instancesDirectory, `${oversizedId}.json`);
    await writeFile(oversizedPath, Buffer.alloc(REGISTRY_RECORD_MAX_BYTES + 1, 0x20), {
      mode: 0o600,
    });
    await chmod(oversizedPath, 0o600);

    const symlinkId = instanceId(6);
    await symlink(
      join(paths.instancesDirectory, `${valid.instanceId}.json`),
      join(paths.instancesDirectory, `${symlinkId}.json`),
    );

    const permissive = recordFor(paths, 7);
    const permissivePath = join(
      paths.instancesDirectory,
      `${permissive.instanceId}.json`,
    );
    await writeFile(permissivePath, JSON.stringify(permissive), { mode: 0o644 });
    await chmod(permissivePath, 0o644);

    const result = await discoverRegistryRecords(paths);
    expect(result.status).toBe('ready');
    expect(result.records.map((snapshot) => snapshot.instanceId)).toEqual([
      valid.instanceId,
    ]);
  });

  it('rejects directory, FIFO, and socket registry entries without blocking or altering them', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const directoryPath = join(paths.instancesDirectory, `${instanceId(24)}.json`);
    const fifoPath = join(paths.instancesDirectory, `${instanceId(25)}.json`);
    const socketPath = join(paths.instancesDirectory, `${instanceId(26)}.json`);
    await mkdir(directoryPath, { mode: 0o700 });
    await execFileAsync('mkfifo', [fifoPath]);
    await chmod(fifoPath, 0o600);

    const shortSocketFixture = await mkdtemp('/tmp/vscode-mcp-reg-socket-');
    fixtures.push(shortSocketFixture);
    const boundSocketPath = join(shortSocketFixture, 'entry.sock');
    const server = createServer();
    server.listen(boundSocketPath);
    await once(server, 'listening');
    await rename(boundSocketPath, socketPath);
    await chmod(socketPath, 0o600);

    try {
      const discovery = await discoverRegistryRecords(paths);
      expect(discovery).toEqual({ status: 'ready', records: [] });
      expect((await lstat(directoryPath)).isDirectory()).toBe(true);
      expect((await lstat(fifoPath)).isFIFO()).toBe(true);
      expect((await lstat(socketPath)).isSocket()).toBe(true);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects device and foreign-owner entries before opening or altering them', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const foreignName = `${instanceId(27)}.json`;
    const deviceName = `${instanceId(28)}.json`;
    const foreignPath = join(paths.instancesDirectory, foreignName);
    const devicePath = join(paths.instancesDirectory, deviceName);
    await writeFile(foreignPath, '{}', { mode: 0o600 });
    await chmod(foreignPath, 0o600);

    let unsafeOpenAttempted = false;
    const nodeFileSystem = NODE_RUNTIME_REGISTRY_DEPENDENCIES.fileSystem;
    const dependencies: RuntimeRegistryDependencies = {
      randomBytes: NODE_RUNTIME_REGISTRY_DEPENDENCIES.randomBytes,
      fileSystem: {
        ...nodeFileSystem,
        readdir: async () => [foreignName, deviceName],
        lstat: async (path) => {
          if (path === foreignPath) {
            const stats = await nodeFileSystem.lstat(path);
            return new Proxy(stats, {
              get(target, property, receiver) {
                return property === 'uid'
                  ? currentUid() + 1
                  : Reflect.get(target, property, receiver);
              },
            });
          }
          if (path === devicePath) {
            return nodeFileSystem.lstat('/dev/null');
          }
          return nodeFileSystem.lstat(path);
        },
        open: async (path, flags, mode) => {
          if (path === foreignPath || path === devicePath) {
            unsafeOpenAttempted = true;
            throw new Error('Unsafe registry entries must not be opened.');
          }
          return mode === undefined
            ? nodeFileSystem.open(path, flags)
            : nodeFileSystem.open(path, flags, mode);
        },
      },
    };

    expect(await discoverRegistryRecords(paths, dependencies)).toEqual({
      status: 'ready',
      records: [],
    });
    expect(unsafeOpenAttempted).toBe(false);
    expect(await readFile(foreignPath, 'utf8')).toBe('{}');
  });

  it('does not replace an unsafe existing registry target', async () => {
    const fixture = await createFixture();
    const paths = await requireReadyPaths(fixture);
    const record = recordFor(paths, 8);
    const outside = join(fixture, 'outside');
    const destination = join(paths.instancesDirectory, `${record.instanceId}.json`);
    await writeFile(outside, 'outside', { mode: 0o600 });
    await symlink(outside, destination);

    await expect(writeRegistryRecord(paths, record)).rejects.toBeInstanceOf(
      RuntimeRegistryError,
    );
    expect(await readFile(outside, 'utf8')).toBe('outside');
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
  });

  it('discovers valid records in deterministic instance-id order', async () => {
    const paths = await requireReadyPaths(await createFixture());
    for (const index of [12, 10, 11]) {
      await writeRawRecord(paths, recordFor(paths, index));
    }

    const result = await discoverRegistryRecords(paths);
    expect(result.status).toBe('ready');
    expect(result.records.map((snapshot) => snapshot.instanceId)).toEqual([
      instanceId(10),
      instanceId(11),
      instanceId(12),
    ]);
  });

  it('fails closed instead of returning a partial 65-record discovery', async () => {
    const paths = await requireReadyPaths(await createFixture());
    for (let index = 1; index <= REGISTRY_DISCOVERY_MAX_RECORDS + 1; index += 1) {
      await writeRawRecord(paths, recordFor(paths, index));
    }

    const result = await discoverRegistryRecords(paths);
    expect(result).toMatchObject({ status: 'capacityExceeded', records: [] });
  });

  it('preserves a record changed during compare-delete, then deletes unchanged bytes', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const original = recordFor(paths, 20);
    await writeRegistryRecord(paths, original);
    const originalSnapshot = await readRegistryRecordSnapshot(
      paths,
      original.instanceId,
    );
    expect(originalSnapshot).not.toBeNull();
    if (originalSnapshot === null) {
      return;
    }

    await writeRegistryRecord(paths, {
      ...original,
      heartbeatAt: '2026-07-10T12:00:05.000Z',
    });
    expect(await compareAndDeleteUnchangedRegistryRecord(paths, originalSnapshot)).toBe(
      'changed',
    );

    const currentSnapshot = await readRegistryRecordSnapshot(
      paths,
      original.instanceId,
    );
    expect(currentSnapshot).not.toBeNull();
    if (currentSnapshot === null) {
      return;
    }
    expect(await compareAndDeleteUnchangedRegistryRecord(paths, currentSnapshot)).toBe(
      'deleted',
    );
    expect(await readRegistryRecordSnapshot(paths, original.instanceId)).toBeNull();
  });

  it('fails registry operations closed after directory permissions broaden', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const record = recordFor(paths, 21);
    await chmod(paths.instancesDirectory, 0o755);

    expect(await discoverRegistryRecords(paths)).toEqual({
      status: 'unavailable',
      reason: 'INSECURE_REGISTRY_DIRECTORY',
      records: [],
    });
    await expect(writeRegistryRecord(paths, record)).rejects.toMatchObject({
      code: 'INSECURE_REGISTRY_DIRECTORY',
    });
  });

  it('classifies staleness purely at the 60-second heartbeat boundary', async () => {
    const paths = await requireReadyPaths(await createFixture());
    const record = recordFor(paths, 22);
    const heartbeat = Date.parse(record.heartbeatAt);

    expect(REGISTRY_HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(REGISTRY_STALE_AFTER_MS).toBe(60_000);
    expect(isRegistryRecordStale(record, heartbeat + 59_999)).toBe(false);
    expect(isRegistryRecordStale(record, heartbeat + 60_000)).toBe(true);
    expect(isRegistryRecordStale(record, heartbeat - 1)).toBe(false);
    expect(isRegistryRecordStale(record, Number.NaN)).toBe(false);
  });
});
