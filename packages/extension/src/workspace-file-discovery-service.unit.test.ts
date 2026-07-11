import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import {
  V02_READ_DEFAULT_EXCLUDE,
  V02_READ_TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import { describe, expect, it } from 'vitest';

import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import {
  WorkspaceDiscoveryCursorCodec,
  hashWorkspaceDiscoverySortTuple,
  type WorkspaceDiscoveryCursorBinding,
} from './workspace-discovery-cursor.js';
import {
  WorkspaceFileDiscoveryError,
  WorkspaceFileDiscoveryService,
  combineWorkspaceDiscoveryExclude,
  type WorkspaceFileDiscoveryCandidate,
  type WorkspaceFileDiscoveryEntryStat,
  type WorkspaceFileDiscoveryHost,
} from './workspace-file-discovery-service.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

const INSTANCE_ID = 'a12f0291-37e2-4ff6-b763-0abf3fe66714';
const FIXED_NOW = new Date('2026-07-11T01:00:00.000Z');
const POSIX_PATHS = createWorkspaceAuthorizationPathStrategy('posix');

describe('WorkspaceDiscoveryCursorCodec', () => {
  const binding: WorkspaceDiscoveryCursorBinding = {
    tool: 'list_workspace_files',
    instanceId: INSTANCE_ID,
    workspaceFingerprint: 'a'.repeat(64),
    workspaceFolderId: 'root',
    include: '**/*',
    exclude: V02_READ_DEFAULT_EXCLUDE,
    optionsHash: hashWorkspaceDiscoverySortTuple('options'),
  };

  it('authenticates a path-free offset and tuple hash', () => {
    const codec = new WorkspaceDiscoveryCursorCodec(Buffer.alloc(32, 7));
    const cursor = codec.encode(binding, {
      offset: 2,
      sortTupleHash: hashWorkspaceDiscoverySortTuple('private/path.ts'),
    });
    const payload = JSON.parse(
      Buffer.from(cursor.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(cursor.length).toBeLessThan(V02_READ_TOOL_LIMITS.cursorCharacters);
    expect(JSON.stringify(payload)).not.toContain('private/path.ts');
    expect(codec.decode(cursor, binding)).toEqual({
      offset: 2,
      sortTupleHash: hashWorkspaceDiscoverySortTuple('private/path.ts'),
    });
    expect(codec.decode(`${cursor.slice(0, -1)}x`, binding)).toBeNull();
    expect(codec.decode(cursor, { ...binding, workspaceFolderId: 'other' })).toBeNull();
  });

  it('survives ordinary use but fails closed after listener-generation destruction', () => {
    const codec = new WorkspaceDiscoveryCursorCodec(randomBytes(32));
    const cursor = codec.encode(binding, {
      offset: 1,
      sortTupleHash: hashWorkspaceDiscoverySortTuple('a.ts'),
    });
    expect(codec.decode(cursor, binding)).not.toBeNull();
    codec.destroy();
    expect(codec.decode(cursor, binding)).toBeNull();
    expect(() =>
      codec.encode(binding, {
        offset: 1,
        sortTupleHash: hashWorkspaceDiscoverySortTuple('a.ts'),
      }),
    ).toThrow();
  });

  it('requires an exact 256-bit key and valid positive positions', () => {
    expect(() => new WorkspaceDiscoveryCursorCodec(Buffer.alloc(31))).toThrow();
    const codec = new WorkspaceDiscoveryCursorCodec(Buffer.alloc(32));
    expect(() =>
      codec.encode(binding, {
        offset: 0,
        sortTupleHash: hashWorkspaceDiscoverySortTuple('a.ts'),
      }),
    ).toThrow();
  });
});

describe('WorkspaceFileDiscoveryService', () => {
  it('uses deterministic default policy, ordering, and cursor pagination', async () => {
    const host = new FakeDiscoveryHost([
      candidate('/workspace/😀.ts'),
      candidate('/workspace/b.ts'),
      candidate('/workspace/a.ts'),
    ]);
    const service = createService(host);

    const first = await service.listWorkspaceFiles(
      { workspaceFolderId: 'root', limit: 2 },
      new AbortController().signal,
    );
    expect(host.lastFind).toEqual({
      folderUri: 'file:///workspace',
      include: '**/*',
      exclude: V02_READ_DEFAULT_EXCLUDE,
      maximumResults:
        V02_READ_TOOL_LIMITS.discoveryCandidates +
        V02_READ_TOOL_LIMITS.discoveryDetectionSlots,
    });
    expect(first).toMatchObject({
      contractVersion: '0.2.0',
      instanceId: INSTANCE_ID,
      observedAt: FIXED_NOW.toISOString(),
      truncated: false,
      warnings: [],
      result: { files: ['a.ts', 'b.ts'], hasMore: true },
    });
    expect(first.result.nextCursor).not.toBeNull();

    const second = await service.listWorkspaceFiles(
      {
        workspaceFolderId: 'root',
        limit: 2,
        cursor: first.result.nextCursor,
      },
      new AbortController().signal,
    );
    expect(second.result).toEqual({
      workspaceFolderId: 'root',
      files: ['😀.ts'],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('extends default excludes and reserves null for no exclusions', async () => {
    expect(combineWorkspaceDiscoveryExclude(undefined)).toBe(V02_READ_DEFAULT_EXCLUDE);
    expect(combineWorkspaceDiscoveryExclude('**/custom-{a,b}/**')).toBe(
      `{${V02_READ_DEFAULT_EXCLUDE},**/custom-{a,b}/**}`,
    );
    expect(combineWorkspaceDiscoveryExclude(null)).toBeNull();

    const host = new FakeDiscoveryHost([candidate('/workspace/a.ts')]);
    const service = createService(host);
    await service.listWorkspaceFiles(
      { workspaceFolderId: 'root', exclude: null },
      new AbortController().signal,
    );
    expect(host.lastFind?.exclude).toBeNull();
  });

  it('omits symlinks, unsupported entries, escapes, nested-root files, and races', async () => {
    const host = new FakeDiscoveryHost([
      candidate('/workspace/good.ts'),
      candidate('/workspace/link.ts'),
      candidate('/workspace/directory'),
      candidate('/workspace/escape.ts'),
      candidate('/workspace/packages/app/nested.ts'),
      candidate('/workspace/changed.ts'),
    ]);
    host.stats.set('/workspace/link.ts', [stat('symbolicLink')]);
    host.stats.set('/workspace/directory', [stat('other')]);
    host.realpaths.set('/workspace/escape.ts', '/outside/private-secret.ts');
    host.stats.set('/workspace/changed.ts', [
      stat('file', 'before'),
      stat('file', 'after'),
    ]);
    const service = createService(host, nestedIdentity());

    const result = await service.listWorkspaceFiles(
      { workspaceFolderId: 'root' },
      new AbortController().signal,
    );

    expect(result.result.files).toEqual(['good.ts']);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toEqual([
      {
        code: 'EXTERNAL_LOCATIONS_OMITTED',
        message: 'Entries outside the selected workspace authority were omitted.',
        omittedCount: 2,
      },
      {
        code: 'UNSUPPORTED_ITEMS_OMITTED',
        message: 'Unsupported entries were omitted.',
        omittedCount: 2,
      },
      {
        code: 'FILES_CHANGED_DURING_REQUEST',
        message: 'Entries changed during discovery and were omitted.',
        omittedCount: 1,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(JSON.stringify(result)).not.toContain('escape.ts');
    expect(JSON.stringify(result)).not.toContain('nested.ts');
  });

  it('deduplicates canonical candidates without exposing aliases', async () => {
    const host = new FakeDiscoveryHost([
      candidate('/workspace/a.ts'),
      candidate('/workspace/a.ts'),
    ]);
    const result = await createService(host).listWorkspaceFiles(
      { workspaceFolderId: 'root' },
      new AbortController().signal,
    );
    expect(result.result.files).toEqual(['a.ts']);
    expect(result.truncated).toBe(false);
  });

  it('detects cap-plus-one discovery without exposing the extra candidate', async () => {
    const repeated = candidate('/workspace/a.ts');
    const host = new FakeDiscoveryHost(
      Array.from(
        {
          length:
            V02_READ_TOOL_LIMITS.discoveryCandidates +
            V02_READ_TOOL_LIMITS.discoveryDetectionSlots,
        },
        () => repeated,
      ),
    );
    const result = await createService(host).listWorkspaceFiles(
      { workspaceFolderId: 'root' },
      new AbortController().signal,
    );
    expect(result.result.files).toEqual(['a.ts']);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContainEqual({
      code: 'RESOURCE_LIMIT_REACHED',
      message: 'The candidate discovery limit was reached.',
    });
  });

  it('reduces long-path pages before the 448 KiB serialized ceiling', async () => {
    const candidates = Array.from({ length: 500 }, (_, index) =>
      candidate(`/workspace/${String(index).padStart(4, '0')}-${'x'.repeat(1_000)}.ts`),
    );
    const result = await createService(
      new FakeDiscoveryHost(candidates),
    ).listWorkspaceFiles(
      { workspaceFolderId: 'root', limit: 500 },
      new AbortController().signal,
    );
    expect(result.result.files.length).toBeGreaterThan(0);
    expect(result.result.files.length).toBeLessThan(500);
    expect(result.result.hasMore).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.warnings[0]?.code).toBe('RESULTS_TRUNCATED');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      V02_READ_TOOL_LIMITS.serializedResultBytes,
    );
  });

  it('rejects invalid cursors, missing folders, ineligible workspaces, and cancellation', async () => {
    const host = new FakeDiscoveryHost([candidate('/workspace/a.ts')]);
    const service = createService(host);
    await expect(
      service.listWorkspaceFiles(
        { workspaceFolderId: 'root', cursor: 'abc.def' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(
      service.listWorkspaceFiles(
        { workspaceFolderId: 'missing' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FOLDER_NOT_FOUND' });

    const ineligible = createService(host, undefined, { eligible: false });
    await expect(
      ineligible.listWorkspaceFiles(
        { workspaceFolderId: 'root' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_UNTRUSTED' });

    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      service.listWorkspaceFiles({ workspaceFolderId: 'root' }, cancellation.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

class FakeDiscoveryHost implements WorkspaceFileDiscoveryHost {
  public readonly stats = new Map<string, WorkspaceFileDiscoveryEntryStat[]>();
  public readonly realpaths = new Map<string, string>();
  public lastFind:
    | {
        folderUri: string;
        include: string;
        exclude: string | null;
        maximumResults: number;
      }
    | undefined;

  public constructor(
    private readonly candidates: readonly WorkspaceFileDiscoveryCandidate[],
  ) {}

  public async findFiles(
    folderUri: string,
    include: string,
    exclude: string | null,
    maximumResults: number,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceFileDiscoveryCandidate[]> {
    this.lastFind = { folderUri, include, exclude, maximumResults };
    if (signal.aborted) {
      throw new WorkspaceFileDiscoveryError('CANCELLED', 'cancelled', true);
    }
    return await Promise.resolve(this.candidates.slice(0, maximumResults));
  }

  public async lstat(path: string): Promise<WorkspaceFileDiscoveryEntryStat> {
    const configured = this.stats.get(path);
    const value = configured?.length === 1 ? configured[0] : configured?.shift();
    return await Promise.resolve(value ?? stat('file', path));
  }

  public async realpath(path: string): Promise<string> {
    return await Promise.resolve(this.realpaths.get(path) ?? path);
  }
}

function createService(
  host: WorkspaceFileDiscoveryHost,
  identity = rootIdentity(),
  access:
    | { readonly eligible: true; readonly identity: WorkspaceIdentity }
    | { readonly eligible: false } = { eligible: true, identity },
): WorkspaceFileDiscoveryService {
  return new WorkspaceFileDiscoveryService({
    instanceId: INSTANCE_ID,
    cursorCodec: new WorkspaceDiscoveryCursorCodec(Buffer.alloc(32, 1)),
    host,
    getWorkspaceAccess: () => access,
    pathStrategy: POSIX_PATHS,
    now: () => FIXED_NOW,
  });
}

function candidate(path: string): WorkspaceFileDiscoveryCandidate {
  return { uri: `file://${path}` };
}

function stat(
  kind: WorkspaceFileDiscoveryEntryStat['kind'],
  identity = 'stable',
): WorkspaceFileDiscoveryEntryStat {
  return { kind, identity, size: 10, modifiedTime: 1 };
}

function rootIdentity(): WorkspaceIdentity {
  return {
    fingerprint: 'a'.repeat(64),
    displayName: 'workspace',
    workspaceFileUri: null,
    folders: [
      {
        workspaceFolderId: 'root',
        name: 'workspace',
        uri: 'file:///workspace',
        canonicalPath: '/workspace',
      },
    ],
  };
}

function nestedIdentity(): WorkspaceIdentity {
  return {
    ...rootIdentity(),
    folders: [
      ...rootIdentity().folders,
      {
        workspaceFolderId: 'app',
        name: 'app',
        uri: 'file:///workspace/packages/app',
        canonicalPath: '/workspace/packages/app',
      },
    ],
  };
}
