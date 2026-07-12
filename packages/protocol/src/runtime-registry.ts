import { randomBytes as cryptographicRandomBytes } from 'node:crypto';
import { constants as fileSystemConstants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { PROTOCOL_LIMITS } from './constants.js';
import { RegistryRecordSchema, type RegistryRecord } from './registry-schemas.js';
import { InstanceIdSchema } from './schemas.js';

const DIRECTORY_MODE = 0o700;
const REGISTRY_FILE_MODE = 0o600;
const PERMISSION_MASK = 0o7777;
const REGISTRY_FILE_SUFFIX = '.json';
const REGISTRY_DIRECTORY_NAME = 'instances';
const SOCKET_DIRECTORY_NAME = 'sockets';
const RUNTIME_DIRECTORY_NAME = 'vscode-mcp';
const TEMPORARY_FILE_PREFIX = '.registry-write-';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const REGISTRY_HEARTBEAT_INTERVAL_MS =
  PROTOCOL_LIMITS.registryHeartbeatIntervalMs;
export const REGISTRY_STALE_AFTER_MS = PROTOCOL_LIMITS.registryStaleAfterMs;
export const REGISTRY_RECORD_MAX_BYTES = PROTOCOL_LIMITS.registryRecordBytes;
export const REGISTRY_DISCOVERY_MAX_RECORDS = PROTOCOL_LIMITS.registryInstances;

export type SupportedPosixPlatform = 'darwin' | 'linux';

export interface RuntimeRegistryEnvironment {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  readonly xdgRuntimeDirectory: string | undefined;
  readonly temporaryDirectory: string;
}

export interface RuntimeRegistryPaths {
  readonly platform: SupportedPosixPlatform;
  readonly uid: number;
  readonly runtimeRoot: string;
  readonly instancesDirectory: string;
  readonly socketsDirectory: string;
}

export type RuntimeRegistryResolution =
  | {
      readonly status: 'ready';
      readonly paths: RuntimeRegistryPaths;
    }
  | {
      readonly status: 'unsupported';
      readonly reason: 'WINDOWS_ACL_NOT_IMPLEMENTED' | 'UNSUPPORTED_PLATFORM';
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'CURRENT_UID_UNAVAILABLE' | 'NO_SECURE_RUNTIME_DIRECTORY';
    };

export type RuntimeRegistryErrorCode =
  | 'INSECURE_RUNTIME_DIRECTORY'
  | 'INSECURE_REGISTRY_DIRECTORY'
  | 'INVALID_REGISTRY_RECORD'
  | 'REGISTRY_RECORD_TOO_LARGE'
  | 'REGISTRY_IO_FAILURE';

const ERROR_MESSAGES: Record<RuntimeRegistryErrorCode, string> = {
  INSECURE_RUNTIME_DIRECTORY: 'The runtime directory is not secure.',
  INSECURE_REGISTRY_DIRECTORY: 'The registry directory is not secure.',
  INVALID_REGISTRY_RECORD: 'The registry record is invalid.',
  REGISTRY_RECORD_TOO_LARGE: 'The registry record exceeds its byte limit.',
  REGISTRY_IO_FAILURE: 'The registry operation failed.',
};

/**
 * Deliberately carries no filesystem path, endpoint, token, or underlying error. Callers
 * may report the stable code and message without disclosing registry contents.
 */
export class RuntimeRegistryError extends Error {
  public readonly code: RuntimeRegistryErrorCode;

  public constructor(code: RuntimeRegistryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'RuntimeRegistryError';
    this.code = code;
  }
}

export interface RuntimeRegistryFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly mkdir: (path: string, mode: number) => Promise<void>;
  readonly open: (path: string, flags: number, mode?: number) => Promise<FileHandle>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
}

export interface RuntimeRegistryDependencies {
  readonly fileSystem: RuntimeRegistryFileSystem;
  readonly randomBytes: (size: number) => Uint8Array;
}

const nodeFileSystem: RuntimeRegistryFileSystem = {
  async lstat(path) {
    return lstat(path);
  },
  async mkdir(path, mode) {
    await mkdir(path, { mode });
  },
  async open(path, flags, mode) {
    if (mode === undefined) {
      return open(path, flags);
    }
    return open(path, flags, mode);
  },
  async readdir(path) {
    return readdir(path);
  },
  async rename(source, destination) {
    await rename(source, destination);
  },
  async unlink(path) {
    await unlink(path);
  },
};

export const NODE_RUNTIME_REGISTRY_DEPENDENCIES: RuntimeRegistryDependencies =
  Object.freeze({
    fileSystem: nodeFileSystem,
    randomBytes(size: number) {
      return cryptographicRandomBytes(size);
    },
  });

export function getDefaultRuntimeRegistryEnvironment(): RuntimeRegistryEnvironment {
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    xdgRuntimeDirectory: process.env.XDG_RUNTIME_DIR,
    temporaryDirectory: tmpdir(),
  };
}

function isSupportedPosixPlatform(
  platform: NodeJS.Platform,
): platform is SupportedPosixPlatform {
  return platform === 'darwin' || platform === 'linux';
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function hasExactMode(stats: Stats, mode: number): boolean {
  return (stats.mode & PERMISSION_MASK) === mode;
}

function isSecureDirectoryStats(stats: Stats, uid: number): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isDirectory() &&
    stats.uid === uid &&
    hasExactMode(stats, DIRECTORY_MODE)
  );
}

function isSecureRegistryFileStats(stats: Stats, uid: number): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isFile() &&
    stats.uid === uid &&
    hasExactMode(stats, REGISTRY_FILE_MODE)
  );
}

async function isSecureExistingDirectory(
  path: string,
  uid: number,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<boolean> {
  try {
    return isSecureDirectoryStats(await fileSystem.lstat(path), uid);
  } catch {
    return false;
  }
}

async function isExistingNonSymlinkDirectory(
  path: string,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<boolean> {
  try {
    const stats = await fileSystem.lstat(path);
    return !stats.isSymbolicLink() && stats.isDirectory();
  } catch {
    return false;
  }
}

async function ensureSecureDirectory(
  path: string,
  uid: number,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<void> {
  try {
    await fileSystem.mkdir(path, DIRECTORY_MODE);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw new RuntimeRegistryError('INSECURE_RUNTIME_DIRECTORY');
    }
  }

  if (!(await isSecureExistingDirectory(path, uid, fileSystem))) {
    throw new RuntimeRegistryError('INSECURE_RUNTIME_DIRECTORY');
  }
}

async function prepareRuntimeCandidate(
  platform: SupportedPosixPlatform,
  uid: number,
  runtimeRoot: string,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<RuntimeRegistryPaths | null> {
  try {
    await ensureSecureDirectory(runtimeRoot, uid, fileSystem);

    const instancesDirectory = join(runtimeRoot, REGISTRY_DIRECTORY_NAME);
    const socketsDirectory = join(runtimeRoot, SOCKET_DIRECTORY_NAME);
    await ensureSecureDirectory(instancesDirectory, uid, fileSystem);
    await ensureSecureDirectory(socketsDirectory, uid, fileSystem);

    return {
      platform,
      uid,
      runtimeRoot,
      instancesDirectory,
      socketsDirectory,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves and prepares only the accepted POSIX runtime layout. Windows remains
 * explicitly unsupported here until an implementation can create and verify the
 * required registry and named-pipe ACLs; it never falls back to POSIX semantics.
 */
export async function resolveRuntimeRegistryPaths(
  environment: RuntimeRegistryEnvironment = getDefaultRuntimeRegistryEnvironment(),
  dependencies: RuntimeRegistryDependencies = NODE_RUNTIME_REGISTRY_DEPENDENCIES,
): Promise<RuntimeRegistryResolution> {
  if (environment.platform === 'win32') {
    return {
      status: 'unsupported',
      reason: 'WINDOWS_ACL_NOT_IMPLEMENTED',
    };
  }

  if (!isSupportedPosixPlatform(environment.platform)) {
    return { status: 'unsupported', reason: 'UNSUPPORTED_PLATFORM' };
  }

  if (
    environment.uid === undefined ||
    !Number.isSafeInteger(environment.uid) ||
    environment.uid < 0
  ) {
    return { status: 'unavailable', reason: 'CURRENT_UID_UNAVAILABLE' };
  }

  const { fileSystem } = dependencies;
  const xdgRuntimeDirectory = environment.xdgRuntimeDirectory;

  if (
    xdgRuntimeDirectory !== undefined &&
    isAbsolute(xdgRuntimeDirectory) &&
    (await isSecureExistingDirectory(xdgRuntimeDirectory, environment.uid, fileSystem))
  ) {
    const xdgPaths = await prepareRuntimeCandidate(
      environment.platform,
      environment.uid,
      join(xdgRuntimeDirectory, RUNTIME_DIRECTORY_NAME),
      fileSystem,
    );
    if (xdgPaths !== null) {
      return { status: 'ready', paths: xdgPaths };
    }
  }

  if (
    isAbsolute(environment.temporaryDirectory) &&
    (await isExistingNonSymlinkDirectory(environment.temporaryDirectory, fileSystem))
  ) {
    const temporaryPaths = await prepareRuntimeCandidate(
      environment.platform,
      environment.uid,
      join(
        environment.temporaryDirectory,
        `${RUNTIME_DIRECTORY_NAME}-${environment.uid}`,
      ),
      fileSystem,
    );
    if (temporaryPaths !== null) {
      return { status: 'ready', paths: temporaryPaths };
    }
  }

  return {
    status: 'unavailable',
    reason: 'NO_SECURE_RUNTIME_DIRECTORY',
  };
}

async function assertSecureRegistryDirectory(
  paths: RuntimeRegistryPaths,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<void> {
  if (
    !(await isSecureExistingDirectory(paths.instancesDirectory, paths.uid, fileSystem))
  ) {
    throw new RuntimeRegistryError('INSECURE_REGISTRY_DIRECTORY');
  }
}

function isRecordValidForPaths(
  record: RegistryRecord,
  paths: RuntimeRegistryPaths,
): boolean {
  if (
    record.endpoint.kind !== 'unix' ||
    !isAbsolute(record.endpoint.path) ||
    dirname(record.endpoint.path) !== paths.socketsDirectory
  ) {
    return false;
  }

  return record.workspaceFolders.every((folder) => isAbsolute(folder.canonicalPath));
}

function registryFileName(instanceId: string): string {
  return `${instanceId}${REGISTRY_FILE_SUFFIX}`;
}

function parseRegistryFileName(fileName: string): string | null {
  if (!fileName.endsWith(REGISTRY_FILE_SUFFIX)) {
    return null;
  }

  const instanceId = fileName.slice(0, -REGISTRY_FILE_SUFFIX.length);
  const parsed = InstanceIdSchema.safeParse(instanceId);
  return parsed.success ? parsed.data : null;
}

function randomTemporaryFileName(dependencies: RuntimeRegistryDependencies): string {
  const entropy = dependencies.randomBytes(PROTOCOL_LIMITS.endpointEntropyBytes);
  if (entropy.byteLength !== PROTOCOL_LIMITS.endpointEntropyBytes) {
    throw new RuntimeRegistryError('REGISTRY_IO_FAILURE');
  }

  return `${TEMPORARY_FILE_PREFIX}${Buffer.from(entropy).toString('base64url')}`;
}

async function assertSafeExistingTargetOrAbsent(
  path: string,
  uid: number,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<void> {
  try {
    const stats = await fileSystem.lstat(path);
    if (!isSecureRegistryFileStats(stats, uid)) {
      throw new RuntimeRegistryError('INSECURE_REGISTRY_DIRECTORY');
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }
    if (error instanceof RuntimeRegistryError) {
      throw error;
    }
    throw new RuntimeRegistryError('REGISTRY_IO_FAILURE');
  }
}

async function safelyClose(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // Best effort only; callers already fail closed on the primary operation.
  }
}

async function safelyUnlink(
  path: string,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<void> {
  try {
    await fileSystem.unlink(path);
  } catch {
    // A failed cleanup must not expose the sensitive path through an underlying error.
  }
}

async function syncDirectoryBestEffort(
  path: string,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fileSystem.open(
      path,
      fileSystemConstants.O_RDONLY |
        fileSystemConstants.O_DIRECTORY |
        fileSystemConstants.O_NOFOLLOW,
    );
    await handle.sync();
  } catch {
    // Directory fsync is not supported consistently across accepted POSIX platforms.
  } finally {
    await safelyClose(handle);
  }
}

/**
 * Strictly validates, bounds, flushes, and atomically replaces one registry record.
 * Existing unsafe targets are never repaired or replaced.
 */
export async function writeRegistryRecord(
  paths: RuntimeRegistryPaths,
  input: unknown,
  dependencies: RuntimeRegistryDependencies = NODE_RUNTIME_REGISTRY_DEPENDENCIES,
): Promise<RegistryRecord> {
  let temporaryPath: string | undefined;
  let temporaryHandle: FileHandle | undefined;

  try {
    await assertSecureRegistryDirectory(paths, dependencies.fileSystem);

    const parsed = RegistryRecordSchema.safeParse(input);
    if (!parsed.success || !isRecordValidForPaths(parsed.data, paths)) {
      throw new RuntimeRegistryError('INVALID_REGISTRY_RECORD');
    }

    const serialized = JSON.stringify(parsed.data);
    if (serialized === undefined) {
      throw new RuntimeRegistryError('INVALID_REGISTRY_RECORD');
    }
    const bytes = Buffer.from(serialized, 'utf8');
    if (bytes.byteLength > REGISTRY_RECORD_MAX_BYTES) {
      throw new RuntimeRegistryError('REGISTRY_RECORD_TOO_LARGE');
    }

    const destination = join(
      paths.instancesDirectory,
      registryFileName(parsed.data.instanceId),
    );
    await assertSafeExistingTargetOrAbsent(
      destination,
      paths.uid,
      dependencies.fileSystem,
    );

    temporaryPath = join(
      paths.instancesDirectory,
      randomTemporaryFileName(dependencies),
    );
    temporaryHandle = await dependencies.fileSystem.open(
      temporaryPath,
      fileSystemConstants.O_WRONLY |
        fileSystemConstants.O_CREAT |
        fileSystemConstants.O_EXCL |
        fileSystemConstants.O_NOFOLLOW,
      REGISTRY_FILE_MODE,
    );

    const temporaryStats = await temporaryHandle.stat();
    if (!isSecureRegistryFileStats(temporaryStats, paths.uid)) {
      throw new RuntimeRegistryError('INSECURE_REGISTRY_DIRECTORY');
    }

    await temporaryHandle.writeFile(bytes);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await dependencies.fileSystem.rename(temporaryPath, destination);
    temporaryPath = undefined;

    const publishedStats = await dependencies.fileSystem.lstat(destination);
    if (!isSecureRegistryFileStats(publishedStats, paths.uid)) {
      throw new RuntimeRegistryError('INSECURE_REGISTRY_DIRECTORY');
    }

    await syncDirectoryBestEffort(paths.instancesDirectory, dependencies.fileSystem);
    return parsed.data;
  } catch (error) {
    await safelyClose(temporaryHandle);
    if (temporaryPath !== undefined) {
      await safelyUnlink(temporaryPath, dependencies.fileSystem);
    }

    if (error instanceof RuntimeRegistryError) {
      throw error;
    }
    throw new RuntimeRegistryError('REGISTRY_IO_FAILURE');
  }
}

async function readBoundedBytes(handle: FileHandle): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(REGISTRY_RECORD_MAX_BYTES + 1);
  let totalBytesRead = 0;

  while (totalBytesRead < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      totalBytesRead,
      buffer.byteLength - totalBytesRead,
      totalBytesRead,
    );
    if (result.bytesRead === 0) {
      break;
    }
    totalBytesRead += result.bytesRead;
  }

  if (totalBytesRead > REGISTRY_RECORD_MAX_BYTES) {
    return null;
  }
  return Buffer.from(buffer.subarray(0, totalBytesRead));
}

async function readSecureRegistryBytes(
  path: string,
  uid: number,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<Buffer | null> {
  let handle: FileHandle | undefined;

  try {
    const pathStats = await fileSystem.lstat(path);
    if (
      !isSecureRegistryFileStats(pathStats, uid) ||
      !Number.isSafeInteger(pathStats.size) ||
      pathStats.size < 0 ||
      pathStats.size > REGISTRY_RECORD_MAX_BYTES
    ) {
      return null;
    }

    handle = await fileSystem.open(
      path,
      fileSystemConstants.O_RDONLY |
        fileSystemConstants.O_NOFOLLOW |
        fileSystemConstants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (
      !isSecureRegistryFileStats(before, uid) ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > REGISTRY_RECORD_MAX_BYTES
    ) {
      return null;
    }

    const bytes = await readBoundedBytes(handle);
    if (bytes === null) {
      return null;
    }

    const after = await handle.stat();
    if (
      !isSecureRegistryFileStats(after, uid) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.size !== bytes.byteLength
    ) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    await safelyClose(handle);
  }
}

export interface RegistryRecordSnapshot {
  readonly fileName: string;
  readonly instanceId: string;
  readonly record: RegistryRecord;
}

// Byte snapshots remain opaque so callers cannot forge compare-delete evidence with a
// traversal filename or attacker-chosen serialized bytes.
const serializedSnapshotBytes = new WeakMap<RegistryRecordSnapshot, Buffer>();

function createRegistryRecordSnapshot(
  fileName: string,
  record: RegistryRecord,
  serializedBytes: Buffer,
): RegistryRecordSnapshot {
  const snapshot: RegistryRecordSnapshot = Object.freeze({
    fileName,
    instanceId: record.instanceId,
    record,
  });
  serializedSnapshotBytes.set(snapshot, Buffer.from(serializedBytes));
  return snapshot;
}

function snapshotsHaveIdenticalBytes(
  left: RegistryRecordSnapshot,
  right: RegistryRecordSnapshot,
): boolean {
  const leftBytes = serializedSnapshotBytes.get(left);
  const rightBytes = serializedSnapshotBytes.get(right);
  return (
    leftBytes !== undefined && rightBytes !== undefined && leftBytes.equals(rightBytes)
  );
}

async function parseRegistrySnapshot(
  paths: RuntimeRegistryPaths,
  fileName: string,
  expectedInstanceId: string,
  fileSystem: RuntimeRegistryFileSystem,
): Promise<RegistryRecordSnapshot | null> {
  const bytes = await readSecureRegistryBytes(
    join(paths.instancesDirectory, fileName),
    paths.uid,
    fileSystem,
  );
  if (
    bytes === null ||
    (bytes.byteLength >= UTF8_BOM.byteLength &&
      bytes.subarray(0, UTF8_BOM.byteLength).equals(UTF8_BOM))
  ) {
    return null;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const input: unknown = JSON.parse(text);
    const parsed = RegistryRecordSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.instanceId !== expectedInstanceId ||
      !isRecordValidForPaths(parsed.data, paths)
    ) {
      return null;
    }

    return createRegistryRecordSnapshot(fileName, parsed.data, bytes);
  } catch {
    return null;
  }
}

/** Reads one UUID-named record with O_NOFOLLOW and bounded, strict validation. */
export async function readRegistryRecordSnapshot(
  paths: RuntimeRegistryPaths,
  instanceId: string,
  dependencies: RuntimeRegistryDependencies = NODE_RUNTIME_REGISTRY_DEPENDENCIES,
): Promise<RegistryRecordSnapshot | null> {
  const parsedInstanceId = InstanceIdSchema.safeParse(instanceId);
  if (!parsedInstanceId.success) {
    return null;
  }

  try {
    await assertSecureRegistryDirectory(paths, dependencies.fileSystem);
  } catch {
    return null;
  }

  const fileName = registryFileName(parsedInstanceId.data);
  return parseRegistrySnapshot(
    paths,
    fileName,
    parsedInstanceId.data,
    dependencies.fileSystem,
  );
}

export type RegistryDiscoveryResult =
  | {
      readonly status: 'ready';
      readonly records: readonly RegistryRecordSnapshot[];
    }
  | {
      readonly status: 'capacityExceeded';
      readonly records: readonly RegistryRecordSnapshot[];
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'INSECURE_REGISTRY_DIRECTORY';
      readonly records: readonly RegistryRecordSnapshot[];
    };

/**
 * Discovers at most 64 validated records in deterministic instance-ID order. Finding a
 * 65th valid record fails closed instead of returning a partial winner.
 */
export async function discoverRegistryRecords(
  paths: RuntimeRegistryPaths,
  dependencies: RuntimeRegistryDependencies = NODE_RUNTIME_REGISTRY_DEPENDENCIES,
): Promise<RegistryDiscoveryResult> {
  try {
    await assertSecureRegistryDirectory(paths, dependencies.fileSystem);
  } catch {
    return {
      status: 'unavailable',
      reason: 'INSECURE_REGISTRY_DIRECTORY',
      records: [],
    };
  }

  let fileNames: string[];
  try {
    fileNames = await dependencies.fileSystem.readdir(paths.instancesDirectory);
  } catch {
    return {
      status: 'unavailable',
      reason: 'INSECURE_REGISTRY_DIRECTORY',
      records: [],
    };
  }

  const candidates = fileNames
    .map((fileName) => ({
      fileName,
      instanceId: parseRegistryFileName(fileName),
    }))
    .filter(
      (
        candidate,
      ): candidate is { readonly fileName: string; readonly instanceId: string } =>
        candidate.instanceId !== null,
    )
    .sort((left, right) => compareCodeUnits(left.instanceId, right.instanceId));

  const records: RegistryRecordSnapshot[] = [];
  for (const candidate of candidates) {
    const record = await parseRegistrySnapshot(
      paths,
      candidate.fileName,
      candidate.instanceId,
      dependencies.fileSystem,
    );
    if (record === null) {
      continue;
    }

    records.push(record);
    if (records.length > REGISTRY_DISCOVERY_MAX_RECORDS) {
      return { status: 'capacityExceeded', records: [] };
    }
  }

  return { status: 'ready', records };
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Pure heartbeat-age classification. Reachability remains a separate authenticated
 * three-second probe owned by the server; age alone never authorizes deletion.
 */
export function isRegistryRecordStale(
  record: Pick<RegistryRecord, 'heartbeatAt'>,
  nowMilliseconds: number,
): boolean {
  if (!Number.isFinite(nowMilliseconds)) {
    return false;
  }

  const heartbeatMilliseconds = Date.parse(record.heartbeatAt);
  return (
    Number.isFinite(heartbeatMilliseconds) &&
    nowMilliseconds >= heartbeatMilliseconds &&
    nowMilliseconds - heartbeatMilliseconds >= REGISTRY_STALE_AFTER_MS
  );
}

export type CompareAndDeleteResult =
  'deleted' | 'changed' | 'missingOrInvalid' | 'unavailable';

/**
 * Re-reads and byte-compares a record before unlinking only the registry entry. It does
 * not probe an endpoint and never unlinks a socket. Stale cleanup MUST call this only
 * after the separate authenticated probe has failed; extension shutdown may use it for
 * its own previously captured record.
 */
export async function compareAndDeleteUnchangedRegistryRecord(
  paths: RuntimeRegistryPaths,
  original: RegistryRecordSnapshot,
  dependencies: RuntimeRegistryDependencies = NODE_RUNTIME_REGISTRY_DEPENDENCIES,
): Promise<CompareAndDeleteResult> {
  if (
    original.fileName !== registryFileName(original.instanceId) ||
    !serializedSnapshotBytes.has(original)
  ) {
    return 'unavailable';
  }

  try {
    await assertSecureRegistryDirectory(paths, dependencies.fileSystem);
  } catch {
    return 'unavailable';
  }

  const current = await parseRegistrySnapshot(
    paths,
    original.fileName,
    original.instanceId,
    dependencies.fileSystem,
  );
  if (current === null) {
    return 'missingOrInvalid';
  }
  if (!snapshotsHaveIdenticalBytes(original, current)) {
    return 'changed';
  }

  try {
    await dependencies.fileSystem.unlink(
      join(paths.instancesDirectory, original.fileName),
    );
    await syncDirectoryBestEffort(paths.instancesDirectory, dependencies.fileSystem);
    return 'deleted';
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? 'missingOrInvalid' : 'unavailable';
  }
}
