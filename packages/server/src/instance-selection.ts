import { posix, win32 } from 'node:path';

import type { ErrorCode, InstanceDescriptor } from '@vscode-mcp/protocol';

export interface AuthenticatedInstanceCandidate {
  /** Safe metadata returned by a matching authenticated hello response. */
  readonly safeDescriptor: InstanceDescriptor;
  /**
   * Absolute real paths corresponding to the authenticated workspace folders.
   * Discovery owns realpath resolution; this pure selector performs no filesystem I/O.
   */
  readonly canonicalWorkspaceRoots: readonly string[];
}

export type PinnedInstanceUpperBound =
  | { readonly kind: 'unbounded' }
  | { readonly kind: 'instance'; readonly instanceId: string }
  | { readonly kind: 'workspace'; readonly canonicalWorkspacePath: string };

export type PathFlavor = 'posix' | 'win32';

export interface CanonicalPathStrategyOptions {
  readonly flavor: PathFlavor;
  readonly caseSensitive: boolean;
}

export interface CanonicalPathStrategy {
  readonly flavor: PathFlavor;
  readonly caseSensitive: boolean;
  readonly separator: string;
  relative(from: string, to: string): string;
  isAbsolute(value: string): boolean;
}

export function createCanonicalPathStrategy(
  options: CanonicalPathStrategyOptions,
): CanonicalPathStrategy {
  const pathImplementation = options.flavor === 'posix' ? posix : win32;

  const comparablePath = (value: string): string => {
    const normalized = pathImplementation.normalize(value);
    return options.caseSensitive ? normalized : normalized.toLowerCase();
  };

  return {
    flavor: options.flavor,
    caseSensitive: options.caseSensitive,
    separator: pathImplementation.sep,
    relative(from: string, to: string): string {
      return pathImplementation.relative(comparablePath(from), comparablePath(to));
    },
    isAbsolute(value: string): boolean {
      return pathImplementation.isAbsolute(value);
    },
  };
}

export type InstanceResolutionMethod =
  'explicit' | 'cwd' | 'single' | 'none' | 'ambiguous';

export type InstanceSelectionErrorCode = Extract<
  ErrorCode,
  'INVALID_ARGUMENT' | 'INSTANCE_NOT_FOUND' | 'INSTANCE_AMBIGUOUS'
>;

export interface SuccessfulInstanceResolution {
  readonly ok: true;
  readonly candidate: AuthenticatedInstanceCandidate;
  readonly resolution: {
    readonly selectedInstanceId: string;
    readonly method: 'explicit' | 'cwd' | 'single';
    readonly candidateInstanceIds: readonly string[];
  };
}

export interface FailedInstanceResolution {
  readonly ok: false;
  readonly errorCode: InstanceSelectionErrorCode;
  readonly resolution: {
    readonly selectedInstanceId: null;
    readonly method: InstanceResolutionMethod;
    readonly candidateInstanceIds: readonly string[];
  };
}

export type InstanceResolution =
  SuccessfulInstanceResolution | FailedInstanceResolution;

export interface ResolveInstanceInput {
  readonly candidates: readonly AuthenticatedInstanceCandidate[];
  readonly upperBound: PinnedInstanceUpperBound;
  /** Public per-call selector after schema validation, or null when omitted. */
  readonly requestedInstanceId: string | null;
  /** Absolute real path of the bridge cwd, or null when it is unavailable. */
  readonly canonicalCwd: string | null;
  readonly pathStrategy: CanonicalPathStrategy;
}

/**
 * Resolves one authenticated instance without filesystem access or mutable state.
 * Every path supplied here must already be absolute and realpath-canonicalized.
 */
export function resolveInstance(input: ResolveInstanceInput): InstanceResolution {
  const candidates = sortCandidates(input.candidates);

  if (input.upperBound.kind === 'instance') {
    const allowed = candidatesWithId(candidates, input.upperBound.instanceId);

    if (
      input.requestedInstanceId !== null &&
      input.requestedInstanceId !== input.upperBound.instanceId
    ) {
      return failure('INVALID_ARGUMENT', 'explicit', allowed);
    }

    return resolveExplicit(allowed);
  }

  if (input.upperBound.kind === 'workspace') {
    const allowed = deepestContainingCandidates(
      candidates,
      input.upperBound.canonicalWorkspacePath,
      input.pathStrategy,
    );

    if (input.requestedInstanceId === null) {
      return resolveExplicit(allowed);
    }

    const requestedAnywhere = candidatesWithId(candidates, input.requestedInstanceId);
    const requestedWithinBound = candidatesWithId(allowed, input.requestedInstanceId);

    if (requestedAnywhere.length > 0 && requestedWithinBound.length === 0) {
      return failure('INVALID_ARGUMENT', 'explicit', allowed);
    }

    return resolveExplicit(requestedWithinBound);
  }

  if (input.requestedInstanceId !== null) {
    return resolveExplicit(candidatesWithId(candidates, input.requestedInstanceId));
  }

  if (input.canonicalCwd !== null) {
    const cwdMatches = deepestContainingCandidates(
      candidates,
      input.canonicalCwd,
      input.pathStrategy,
    );

    if (cwdMatches.length === 1) {
      const candidate = cwdMatches[0];
      if (candidate !== undefined) {
        return success(candidate, 'cwd', cwdMatches);
      }
    }

    if (cwdMatches.length > 1) {
      return failure('INSTANCE_AMBIGUOUS', 'ambiguous', cwdMatches);
    }
  }

  if (candidates.length === 0) {
    return failure('INSTANCE_NOT_FOUND', 'none', candidates);
  }

  if (candidates.length > 1) {
    return failure('INSTANCE_AMBIGUOUS', 'ambiguous', candidates);
  }

  const soleCandidate = candidates[0];
  if (soleCandidate === undefined) {
    return failure('INSTANCE_NOT_FOUND', 'none', candidates);
  }

  return success(soleCandidate, 'single', candidates);
}

function resolveExplicit(
  candidates: readonly AuthenticatedInstanceCandidate[],
): InstanceResolution {
  if (candidates.length === 0) {
    return failure('INSTANCE_NOT_FOUND', 'explicit', candidates);
  }

  if (candidates.length > 1) {
    return failure('INSTANCE_AMBIGUOUS', 'ambiguous', candidates);
  }

  const candidate = candidates[0];
  if (candidate === undefined) {
    return failure('INSTANCE_NOT_FOUND', 'explicit', candidates);
  }

  return success(candidate, 'explicit', candidates);
}

function deepestContainingCandidates(
  candidates: readonly AuthenticatedInstanceCandidate[],
  canonicalTarget: string,
  pathStrategy: CanonicalPathStrategy,
): readonly AuthenticatedInstanceCandidate[] {
  let shortestDistance: number | null = null;
  const matches: AuthenticatedInstanceCandidate[] = [];

  for (const candidate of candidates) {
    const distance = shortestContainingRootDistance(
      candidate.canonicalWorkspaceRoots,
      canonicalTarget,
      pathStrategy,
    );
    if (distance === null) {
      continue;
    }

    if (shortestDistance === null || distance < shortestDistance) {
      shortestDistance = distance;
      matches.length = 0;
      matches.push(candidate);
      continue;
    }

    if (distance === shortestDistance) {
      matches.push(candidate);
    }
  }

  return matches;
}

function shortestContainingRootDistance(
  roots: readonly string[],
  canonicalTarget: string,
  pathStrategy: CanonicalPathStrategy,
): number | null {
  let shortestDistance: number | null = null;

  for (const root of roots) {
    const distance = containmentDistance(root, canonicalTarget, pathStrategy);
    if (
      distance !== null &&
      (shortestDistance === null || distance < shortestDistance)
    ) {
      shortestDistance = distance;
    }
  }

  return shortestDistance;
}

function containmentDistance(
  canonicalRoot: string,
  canonicalTarget: string,
  pathStrategy: CanonicalPathStrategy,
): number | null {
  if (
    !pathStrategy.isAbsolute(canonicalRoot) ||
    !pathStrategy.isAbsolute(canonicalTarget)
  ) {
    return null;
  }

  const relativePath = pathStrategy.relative(canonicalRoot, canonicalTarget);
  if (relativePath.length === 0) {
    return 0;
  }

  if (pathStrategy.isAbsolute(relativePath)) {
    return null;
  }

  const segments = relativePath
    .split(pathStrategy.separator)
    .filter((segment) => segment.length > 0 && segment !== '.');

  if (segments[0] === '..') {
    return null;
  }

  return segments.length;
}

function candidatesWithId(
  candidates: readonly AuthenticatedInstanceCandidate[],
  instanceId: string,
): readonly AuthenticatedInstanceCandidate[] {
  return candidates.filter(
    (candidate) => candidate.safeDescriptor.instanceId === instanceId,
  );
}

function sortCandidates(
  candidates: readonly AuthenticatedInstanceCandidate[],
): readonly AuthenticatedInstanceCandidate[] {
  return [...candidates].sort((left, right) =>
    compareStrings(left.safeDescriptor.instanceId, right.safeDescriptor.instanceId),
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function candidateIds(
  candidates: readonly AuthenticatedInstanceCandidate[],
): readonly string[] {
  return candidates.map((candidate) => candidate.safeDescriptor.instanceId);
}

function success(
  candidate: AuthenticatedInstanceCandidate,
  method: 'explicit' | 'cwd' | 'single',
  candidates: readonly AuthenticatedInstanceCandidate[],
): SuccessfulInstanceResolution {
  return {
    ok: true,
    candidate,
    resolution: {
      selectedInstanceId: candidate.safeDescriptor.instanceId,
      method,
      candidateInstanceIds: candidateIds(candidates),
    },
  };
}

function failure(
  errorCode: InstanceSelectionErrorCode,
  method: InstanceResolutionMethod,
  candidates: readonly AuthenticatedInstanceCandidate[],
): FailedInstanceResolution {
  return {
    ok: false,
    errorCode,
    resolution: {
      selectedInstanceId: null,
      method,
      candidateInstanceIds: candidateIds(candidates),
    },
  };
}
