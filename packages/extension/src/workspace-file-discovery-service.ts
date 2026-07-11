import {
  V02_READ_DEFAULT_EXCLUDE,
  V02_READ_TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import {
  InstanceIdSchema,
  WorkspaceRelativePathSchema,
} from '@vscode-mcp/protocol/schemas';
import {
  V02ListWorkspaceFilesArgumentsSchema,
  V02ListWorkspaceFilesSuccessSchema,
  type V02ListWorkspaceFilesSuccess,
  type V02ToolExecutionError,
  type V02WarningCode,
} from '@vscode-mcp/protocol/tool-schemas-v0.2';

import {
  authorizeWorkspaceDocument,
  type WorkspaceAuthorizationPathStrategy,
} from './workspace-authorizer.js';
import {
  hashWorkspaceDiscoverySortTuple,
  type WorkspaceDiscoveryCursorCodec,
  type WorkspaceDiscoveryCursorBinding,
} from './workspace-discovery-cursor.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

export interface WorkspaceFileDiscoveryCandidate {
  readonly uri: string;
}

export interface WorkspaceFileDiscoveryEntryStat {
  readonly kind: 'file' | 'symbolicLink' | 'other';
  readonly identity: string;
  readonly size: number;
  readonly modifiedTime: number;
}

export interface WorkspaceFileDiscoveryHost {
  findFiles(
    folderUri: string,
    include: string,
    exclude: string | null,
    maximumResults: number,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceFileDiscoveryCandidate[]>;
  lstat(path: string): Promise<WorkspaceFileDiscoveryEntryStat>;
  realpath(path: string): Promise<string>;
}

export type WorkspaceFileDiscoveryAccess =
  | { readonly eligible: true; readonly identity: WorkspaceIdentity }
  | { readonly eligible: false };

export interface WorkspaceFileDiscoveryServiceOptions {
  readonly instanceId: string;
  readonly cursorCodec: WorkspaceDiscoveryCursorCodec;
  readonly host: WorkspaceFileDiscoveryHost;
  readonly getWorkspaceAccess: () =>
    WorkspaceFileDiscoveryAccess | PromiseLike<WorkspaceFileDiscoveryAccess>;
  readonly pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly now?: () => Date;
}

type DiscoveryErrorCode = V02ToolExecutionError['code'];

export class WorkspaceFileDiscoveryError extends Error {
  public constructor(
    public readonly code: DiscoveryErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WorkspaceFileDiscoveryError';
  }
}

interface WarningValue {
  readonly code: V02WarningCode;
  readonly message: string;
  readonly omittedCount?: number;
}

interface DiscoveryCounts {
  external: number;
  unsupported: number;
  changed: number;
}

const WARNING_ORDER = [
  'RESULTS_TRUNCATED',
  'CONTENT_TRUNCATED',
  'EXTERNAL_LOCATIONS_OMITTED',
  'UNSUPPORTED_ITEMS_OMITTED',
  'PROVIDER_RETURNED_NO_RESULT',
  'RESOURCE_LIMIT_REACHED',
  'FILES_CHANGED_DURING_REQUEST',
] as const;

export class WorkspaceFileDiscoveryService {
  readonly #instanceId: string;
  readonly #cursorCodec: WorkspaceDiscoveryCursorCodec;
  readonly #host: WorkspaceFileDiscoveryHost;
  readonly #getWorkspaceAccess: WorkspaceFileDiscoveryServiceOptions['getWorkspaceAccess'];
  readonly #pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly #now: () => Date;

  public constructor(options: WorkspaceFileDiscoveryServiceOptions) {
    this.#instanceId = InstanceIdSchema.parse(options.instanceId);
    this.#cursorCodec = options.cursorCodec;
    this.#host = options.host;
    this.#getWorkspaceAccess = options.getWorkspaceAccess;
    this.#pathStrategy = options.pathStrategy;
    this.#now = options.now ?? (() => new Date());
  }

  public async listWorkspaceFiles(
    untrustedArguments: unknown,
    signal: AbortSignal,
  ): Promise<V02ListWorkspaceFilesSuccess> {
    const parsed = V02ListWorkspaceFilesArgumentsSchema.safeParse(untrustedArguments);
    if (!parsed.success) {
      throw failure('INVALID_ARGUMENT', 'The tool arguments are invalid.', false);
    }
    throwIfCancelled(signal);
    const access = await this.#getWorkspaceAccess();
    throwIfCancelled(signal);
    if (!access.eligible) {
      throw failure('WORKSPACE_UNTRUSTED', 'The workspace is not eligible.', false);
    }
    const folder = access.identity.folders.find(
      (candidate) => candidate.workspaceFolderId === parsed.data.workspaceFolderId,
    );
    if (folder === undefined) {
      throw failure(
        'WORKSPACE_FOLDER_NOT_FOUND',
        'The workspace folder could not be found.',
        false,
      );
    }

    const include = parsed.data.include ?? '**/*';
    const exclude = combineWorkspaceDiscoveryExclude(parsed.data.exclude);
    const binding: WorkspaceDiscoveryCursorBinding = {
      tool: 'list_workspace_files',
      instanceId: this.#instanceId,
      workspaceFingerprint: access.identity.fingerprint,
      workspaceFolderId: folder.workspaceFolderId,
      include,
      exclude,
      optionsHash: hashWorkspaceDiscoverySortTuple('list-workspace-files:v1'),
    };
    let offset = 0;
    if (parsed.data.cursor !== undefined) {
      const position = this.#cursorCodec.decode(parsed.data.cursor, binding);
      if (position === null) {
        throw failure('INVALID_CURSOR', 'The continuation cursor is invalid.', false);
      }
      offset = position.offset;
    }

    let rawCandidates: readonly WorkspaceFileDiscoveryCandidate[];
    try {
      rawCandidates = await this.#host.findFiles(
        folder.uri,
        include,
        exclude,
        V02_READ_TOOL_LIMITS.discoveryCandidates +
          V02_READ_TOOL_LIMITS.discoveryDetectionSlots,
        signal,
      );
    } catch (error) {
      throw normalizeHostFailure(error, signal);
    }
    throwIfCancelled(signal);

    const candidateLimitReached =
      rawCandidates.length > V02_READ_TOOL_LIMITS.discoveryCandidates;
    const candidates = rawCandidates.slice(0, V02_READ_TOOL_LIMITS.discoveryCandidates);
    const counts: DiscoveryCounts = { external: 0, unsupported: 0, changed: 0 };
    const canonicalKeys = new Set<string>();
    const relativePaths: string[] = [];

    for (const candidate of candidates) {
      throwIfCancelled(signal);
      const requestPath = this.localCandidatePath(candidate.uri);
      if (requestPath === null) {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }
      let before: WorkspaceFileDiscoveryEntryStat;
      try {
        before = await this.#host.lstat(requestPath);
      } catch {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }
      if (before.kind !== 'file') {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }

      const authorization = await authorizeWorkspaceDocument({
        workspaceIdentity: access.identity,
        reference: candidate.uri,
        realpath: (path) => this.#host.realpath(path),
        pathStrategy: this.#pathStrategy,
      });
      if (!authorization.ok) {
        counts.external = saturatingAdd(counts.external, 1);
        continue;
      }
      if (authorization.document.workspaceFolderId !== folder.workspaceFolderId) {
        counts.external = saturatingAdd(counts.external, 1);
        continue;
      }

      let after: WorkspaceFileDiscoveryEntryStat;
      try {
        after = await this.#host.lstat(requestPath);
      } catch {
        counts.changed = saturatingAdd(counts.changed, 1);
        continue;
      }
      if (!sameEntry(before, after)) {
        counts.changed = saturatingAdd(counts.changed, 1);
        continue;
      }

      const canonicalKey = comparableCanonicalPath(
        authorization.document.canonicalPath,
        this.#pathStrategy,
      );
      if (canonicalKeys.has(canonicalKey)) {
        continue;
      }
      if (
        !WorkspaceRelativePathSchema.safeParse(authorization.document.relativePath)
          .success
      ) {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }
      canonicalKeys.add(canonicalKey);
      relativePaths.push(authorization.document.relativePath);
    }

    relativePaths.sort(compareCodePoints);
    const start = Math.min(offset, relativePaths.length);
    const limit =
      parsed.data.limit ?? V02_READ_TOOL_LIMITS.listWorkspaceFiles.itemsDefault;
    const requestedCount = Math.min(limit, relativePaths.length - start);
    const baseWarnings = createWarnings(counts, candidateLimitReached, false);
    const baseTruncated = baseWarnings.length > 0;
    const initial = this.buildSuccess(
      folder.workspaceFolderId,
      binding,
      relativePaths,
      start,
      requestedCount,
      baseWarnings,
      baseTruncated,
    );
    if (initial !== null) {
      return initial;
    }

    const outputWarnings = createWarnings(counts, candidateLimitReached, true);
    let low = 1;
    let high = Math.max(1, requestedCount - 1);
    let accepted: V02ListWorkspaceFilesSuccess | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = this.buildSuccess(
        folder.workspaceFolderId,
        binding,
        relativePaths,
        start,
        middle,
        outputWarnings,
        true,
      );
      if (candidate === null) {
        high = middle - 1;
      } else {
        accepted = candidate;
        low = middle + 1;
      }
    }
    if (accepted === null) {
      throw failure(
        'INTERNAL_ERROR',
        'The bounded result could not be encoded.',
        false,
      );
    }
    return accepted;
  }

  private buildSuccess(
    workspaceFolderId: string,
    binding: WorkspaceDiscoveryCursorBinding,
    paths: readonly string[],
    start: number,
    count: number,
    warnings: readonly WarningValue[],
    truncated: boolean,
  ): V02ListWorkspaceFilesSuccess | null {
    const files = paths.slice(start, start + count);
    const nextOffset = start + files.length;
    const hasMore = nextOffset < paths.length;
    const lastPath = files.at(-1);
    const nextCursor =
      hasMore && lastPath !== undefined
        ? this.#cursorCodec.encode(binding, {
            offset: nextOffset,
            sortTupleHash: hashWorkspaceDiscoverySortTuple(lastPath),
          })
        : null;
    const parsed = V02ListWorkspaceFilesSuccessSchema.safeParse({
      contractVersion: '0.2.0',
      instanceId: this.#instanceId,
      observedAt: this.#now().toISOString(),
      truncated,
      warnings,
      result: { workspaceFolderId, files, hasMore, nextCursor },
    });
    return parsed.success ? parsed.data : null;
  }

  private localCandidatePath(uri: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== 'file:' ||
      (parsed.hostname.length > 0 && parsed.hostname !== 'localhost') ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    try {
      const path = this.#pathStrategy.fileUriToPath(parsed);
      return this.#pathStrategy.isAbsolute(path) && !path.includes('\0') ? path : null;
    } catch {
      return null;
    }
  }
}

export function combineWorkspaceDiscoveryExclude(
  custom: string | null | undefined,
): string | null {
  if (custom === null) {
    return null;
  }
  return custom === undefined
    ? V02_READ_DEFAULT_EXCLUDE
    : `{${V02_READ_DEFAULT_EXCLUDE},${custom}}`;
}

function sameEntry(
  left: WorkspaceFileDiscoveryEntryStat,
  right: WorkspaceFileDiscoveryEntryStat,
): boolean {
  return (
    left.kind === 'file' &&
    right.kind === 'file' &&
    left.identity === right.identity &&
    left.size === right.size &&
    left.modifiedTime === right.modifiedTime
  );
}

function comparableCanonicalPath(
  path: string,
  strategy: WorkspaceAuthorizationPathStrategy,
): string {
  const normalized = strategy.normalize(path);
  return strategy.caseSensitive ? normalized : normalized.toLowerCase();
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function createWarnings(
  counts: DiscoveryCounts,
  candidateLimitReached: boolean,
  resultLimitReached: boolean,
): WarningValue[] {
  const warnings: WarningValue[] = [];
  if (resultLimitReached) {
    warnings.push({
      code: 'RESULTS_TRUNCATED',
      message: 'The serialized result limit was reached.',
    });
  }
  if (counts.external > 0) {
    warnings.push({
      code: 'EXTERNAL_LOCATIONS_OMITTED',
      message: 'Entries outside the selected workspace authority were omitted.',
      omittedCount: counts.external,
    });
  }
  if (counts.unsupported > 0) {
    warnings.push({
      code: 'UNSUPPORTED_ITEMS_OMITTED',
      message: 'Unsupported entries were omitted.',
      omittedCount: counts.unsupported,
    });
  }
  if (candidateLimitReached) {
    warnings.push({
      code: 'RESOURCE_LIMIT_REACHED',
      message: 'The candidate discovery limit was reached.',
    });
  }
  if (counts.changed > 0) {
    warnings.push({
      code: 'FILES_CHANGED_DURING_REQUEST',
      message: 'Entries changed during discovery and were omitted.',
      omittedCount: counts.changed,
    });
  }
  warnings.sort(
    (left, right) =>
      WARNING_ORDER.indexOf(left.code) - WARNING_ORDER.indexOf(right.code),
  );
  return warnings;
}

function normalizeHostFailure(
  error: unknown,
  signal: AbortSignal,
): WorkspaceFileDiscoveryError {
  if (signal.aborted) {
    return failure('CANCELLED', 'The request was cancelled.', true);
  }
  return error instanceof WorkspaceFileDiscoveryError
    ? error
    : failure('INTERNAL_ERROR', 'Workspace discovery failed.', false);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw failure('CANCELLED', 'The request was cancelled.', true);
  }
}

function failure(
  code: DiscoveryErrorCode,
  message: string,
  retryable: boolean,
): WorkspaceFileDiscoveryError {
  return new WorkspaceFileDiscoveryError(code, message, retryable);
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
