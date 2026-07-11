import { describe, expect, it } from 'vitest';

import {
  createCanonicalPathStrategy,
  resolveInstance,
  type AuthenticatedInstanceCandidate,
  type InstanceResolution,
  type PinnedInstanceUpperBound,
} from './instance-selection.js';

const INSTANCE_A = '00000000-0000-4000-8000-000000000001';
const INSTANCE_B = '00000000-0000-4000-8000-000000000002';
const INSTANCE_C = '00000000-0000-4000-8000-000000000003';

const POSIX_PATHS = createCanonicalPathStrategy({
  flavor: 'posix',
  caseSensitive: true,
});

const WINDOWS_PATHS = createCanonicalPathStrategy({
  flavor: 'win32',
  caseSensitive: false,
});

const UNBOUNDED: PinnedInstanceUpperBound = { kind: 'unbounded' };

describe('deterministic instance selection', () => {
  it('applies a pinned instance before cwd resolution', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/work/alpha']),
        candidate(INSTANCE_B, ['/work/beta']),
      ],
      upperBound: { kind: 'instance', instanceId: INSTANCE_B },
      canonicalCwd: '/work/alpha/src',
    });

    expectSelected(result, INSTANCE_B, 'explicit');
  });

  it('uses a per-call instance before cwd when the bridge is unbounded', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/work/alpha']),
        candidate(INSTANCE_B, ['/work/beta']),
      ],
      requestedInstanceId: INSTANCE_B,
      canonicalCwd: '/work/alpha/src',
    });

    expectSelected(result, INSTANCE_B, 'explicit');
  });

  it('selects the deepest root for a canonical pinned workspace', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/repo']),
        candidate(INSTANCE_B, ['/repo/packages']),
      ],
      upperBound: {
        kind: 'workspace',
        canonicalWorkspacePath: '/repo/packages/app',
      },
      canonicalCwd: '/unrelated',
    });

    expectSelected(result, INSTANCE_B, 'explicit');
  });

  it('selects the deepest workspace root containing cwd', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/repo']),
        candidate(INSTANCE_B, ['/repo/packages']),
        candidate(INSTANCE_C, ['/elsewhere']),
      ],
      canonicalCwd: '/repo/packages/app/src',
    });

    expectSelected(result, INSTANCE_B, 'cwd');
  });

  it('rejects the path-prefix trap using relative path semantics', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/work/project']),
        candidate(INSTANCE_B, ['/work/other']),
      ],
      canonicalCwd: '/work/project-copy/src',
    });

    expectFailure(result, 'INSTANCE_AMBIGUOUS', 'ambiguous', [INSTANCE_A, INSTANCE_B]);
  });

  it('keeps duplicate windows for one workspace ambiguous', () => {
    const result = resolve({
      candidates: [candidate(INSTANCE_B, ['/repo']), candidate(INSTANCE_A, ['/repo'])],
      upperBound: {
        kind: 'workspace',
        canonicalWorkspacePath: '/repo',
      },
      canonicalCwd: '/repo/src',
    });

    expectFailure(result, 'INSTANCE_AMBIGUOUS', 'ambiguous', [INSTANCE_A, INSTANCE_B]);
  });

  it('rejects a per-call instance that conflicts with a pinned instance', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/work/alpha']),
        candidate(INSTANCE_B, ['/work/beta']),
      ],
      upperBound: { kind: 'instance', instanceId: INSTANCE_A },
      requestedInstanceId: INSTANCE_B,
      canonicalCwd: '/work/beta',
    });

    expectFailure(result, 'INVALID_ARGUMENT', 'explicit', [INSTANCE_A]);
  });

  it('does not fail over when a pinned instance is disconnected', () => {
    const result = resolve({
      candidates: [candidate(INSTANCE_B, ['/work/beta'])],
      upperBound: { kind: 'instance', instanceId: INSTANCE_A },
      canonicalCwd: '/work/beta',
    });

    expectFailure(result, 'INSTANCE_NOT_FOUND', 'explicit', []);
  });

  it('rejects a per-call instance outside a pinned workspace', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/work/allowed']),
        candidate(INSTANCE_B, ['/work/outside']),
      ],
      upperBound: {
        kind: 'workspace',
        canonicalWorkspacePath: '/work/allowed',
      },
      requestedInstanceId: INSTANCE_B,
      canonicalCwd: '/work/outside',
    });

    expectFailure(result, 'INVALID_ARGUMENT', 'explicit', [INSTANCE_A]);
  });

  it('uses the sole eligible fallback only after cwd has no match', () => {
    const result = resolve({
      candidates: [candidate(INSTANCE_A, ['/workspace'])],
      canonicalCwd: '/unrelated',
    });

    expectSelected(result, INSTANCE_A, 'single');
  });

  it('returns none when there is no authenticated candidate', () => {
    const result = resolve({ candidates: [], canonicalCwd: '/workspace' });

    expectFailure(result, 'INSTANCE_NOT_FOUND', 'none', []);
  });

  it('supports case-insensitive Windows containment through an injected strategy', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['C:\\Work\\Project']),
        candidate(INSTANCE_B, ['C:\\Other']),
      ],
      canonicalCwd: 'c:\\work\\project\\src',
      pathStrategy: WINDOWS_PATHS,
    });

    expectSelected(result, INSTANCE_A, 'cwd');
  });

  it('keeps POSIX containment case-sensitive through an injected strategy', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/Work/Project']),
        candidate(INSTANCE_B, ['/other']),
      ],
      canonicalCwd: '/work/project/src',
    });

    expectFailure(result, 'INSTANCE_AMBIGUOUS', 'ambiguous', [INSTANCE_A, INSTANCE_B]);
  });

  it('uses caller-provided real paths for already canonicalized symlink inputs', () => {
    const result = resolve({
      candidates: [
        candidate(INSTANCE_A, ['/real/workspace']),
        candidate(INSTANCE_B, ['/other/workspace']),
      ],
      upperBound: {
        kind: 'workspace',
        canonicalWorkspacePath: '/real/workspace/src',
      },
      canonicalCwd: '/real/workspace/src',
    });

    expectSelected(result, INSTANCE_A, 'explicit');
  });
});

interface ResolveOverrides {
  readonly candidates: readonly AuthenticatedInstanceCandidate[];
  readonly upperBound?: PinnedInstanceUpperBound;
  readonly requestedInstanceId?: string | null;
  readonly canonicalCwd?: string | null;
  readonly pathStrategy?: ReturnType<typeof createCanonicalPathStrategy>;
}

function resolve(overrides: ResolveOverrides): InstanceResolution {
  return resolveInstance({
    candidates: overrides.candidates,
    upperBound: overrides.upperBound ?? UNBOUNDED,
    requestedInstanceId: overrides.requestedInstanceId ?? null,
    canonicalCwd: overrides.canonicalCwd ?? null,
    pathStrategy: overrides.pathStrategy ?? POSIX_PATHS,
  });
}

function candidate(
  instanceId: string,
  canonicalWorkspaceRoots: readonly string[],
): AuthenticatedInstanceCandidate {
  return {
    safeDescriptor: {
      instanceId,
      displayName: `Window ${instanceId}`,
      trusted: true,
      publishedAt: '2026-07-10T00:00:00.000Z',
      workspaceFileUri: null,
      workspaceFolders: canonicalWorkspaceRoots.map((root, index) => ({
        workspaceFolderId: `folder-${String(index)}`,
        name: `Folder ${String(index)}`,
        uri: fileUri(root),
      })),
      protocolVersion: 1,
      toolContractVersion: '1.0.0',
    },
    canonicalWorkspaceRoots,
  };
}

function fileUri(canonicalPath: string): string {
  const slashPath = canonicalPath.replaceAll('\\', '/');
  return slashPath[0] === '/' ? `file://${slashPath}` : `file:///${slashPath}`;
}

function expectSelected(
  result: InstanceResolution,
  instanceId: string,
  method: 'explicit' | 'cwd' | 'single',
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected a selected instance, received ${result.errorCode}.`);
  }

  expect(result.candidate.safeDescriptor.instanceId).toBe(instanceId);
  expect(result.resolution).toEqual({
    selectedInstanceId: instanceId,
    method,
    candidateInstanceIds: [instanceId],
  });
}

function expectFailure(
  result: InstanceResolution,
  errorCode: 'INVALID_ARGUMENT' | 'INSTANCE_NOT_FOUND' | 'INSTANCE_AMBIGUOUS',
  method: 'explicit' | 'none' | 'ambiguous',
  candidateInstanceIds: readonly string[],
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(
      `Expected ${errorCode}, selected ${result.resolution.selectedInstanceId}.`,
    );
  }

  expect(result.errorCode).toBe(errorCode);
  expect(result.resolution).toEqual({
    selectedInstanceId: null,
    method,
    candidateInstanceIds,
  });
}
