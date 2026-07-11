import { randomBytes } from 'node:crypto';

import {
  V02_READ_DEFAULT_EXCLUDE,
  V02_READ_TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import { describe, expect, it } from 'vitest';

import { BoundedReadScheduler } from './bounded-read-scheduler.js';
import type { EditorHostDocument, EditorHostIterable } from './editor-tool-host.js';
import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import { WorkspaceDiscoveryCursorCodec } from './workspace-discovery-cursor.js';
import type {
  WorkspaceFileDiscoveryCandidate,
  WorkspaceFileDiscoveryEntryStat,
} from './workspace-file-discovery-service.js';
import {
  WorkspaceTextSearchService,
  type WorkspaceTextSearchHost,
} from './workspace-text-search-service.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

const INSTANCE_ID = 'a12f0291-37e2-4ff6-b763-0abf3fe66714';
const NOW = new Date('2026-07-11T03:00:00.000Z');
const POSIX_PATHS = createWorkspaceAuthorizationPathStrategy('posix');

describe('WorkspaceTextSearchService', () => {
  it('sorts, groups, paginates, and resumes deterministic literal matches', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/b.ts', 'needle b');
    host.addFile('/workspace/a.ts', 'needle a1\nneedle a2');
    const service = createService(host);

    const first = await service.searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'needle', limit: 2 },
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
      observedAt: NOW.toISOString(),
      truncated: false,
      warnings: [],
      result: { returnedMatchCount: 2, hasMore: true },
    });
    expect(first.result.documents).toHaveLength(1);
    expect(first.result.documents[0]?.document.relativePath).toBe('a.ts');
    expect(first.result.nextCursor).not.toBeNull();

    const second = await service.searchWorkspaceText(
      {
        workspaceFolderId: 'root',
        query: 'needle',
        limit: 2,
        cursor: first.result.nextCursor,
      },
      new AbortController().signal,
    );
    expect(second.result).toMatchObject({ returnedMatchCount: 1, hasMore: false });
    expect(second.result.documents[0]?.document.relativePath).toBe('b.ts');
  });

  it('uses ECMAScript Unicode ignore-case, fixed whole-word rules, and UTF-16 ranges', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/unicode.txt', '😀 CAFÉ caféx\r\ncafé CAFÉ');
    const result = await createService(host).searchWorkspaceText(
      {
        workspaceFolderId: 'root',
        query: 'café',
        caseSensitive: false,
        wholeWord: true,
      },
      new AbortController().signal,
    );

    expect(result.result.returnedMatchCount).toBe(2);
    expect(result.result.documents[0]?.matches.map((match) => match.range)).toEqual([
      {
        start: { line: 0, character: 3 },
        end: { line: 0, character: 7 },
      },
      {
        start: { line: 1, character: 6 },
        end: { line: 1, character: 10 },
      },
    ]);
  });

  it('prefers an authorized dirty live document over stale disk bytes', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/live.ts', 'DISK_ONLY');
    host.documents = [liveDocument('file:///workspace/live.ts', 'LIVE_ONLY', 9, true)];

    const live = await createService(host).searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'LIVE_ONLY' },
      new AbortController().signal,
    );
    const stale = await createService(host).searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'DISK_ONLY' },
      new AbortController().signal,
    );

    expect(live.result.documents[0]?.state).toEqual({
      source: 'live',
      documentVersion: 9,
      isDirty: true,
    });
    expect(live.result.returnedMatchCount).toBe(1);
    expect(stale.result.returnedMatchCount).toBe(0);
    expect(host.readCalls).toEqual([]);
  });

  it('uses additive caller excludes and reserves null for no exclusions', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/a.ts', 'needle');
    const service = createService(host);
    await service.searchWorkspaceText(
      {
        workspaceFolderId: 'root',
        query: 'needle',
        exclude: '**/custom/**',
      },
      new AbortController().signal,
    );
    expect(host.lastFind?.exclude).toBe(`{${V02_READ_DEFAULT_EXCLUDE},**/custom/**}`);
    await service.searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'needle', exclude: null },
      new AbortController().signal,
    );
    expect(host.lastFind?.exclude).toBeNull();
  });

  it('detects cap-plus-one discovery without exposing the extra candidate', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/a.ts', 'needle');
    const repeated = host.candidates[0];
    expect(repeated).toBeDefined();
    host.candidates = Array.from(
      {
        length:
          V02_READ_TOOL_LIMITS.discoveryCandidates +
          V02_READ_TOOL_LIMITS.discoveryDetectionSlots,
      },
      () => repeated as WorkspaceFileDiscoveryCandidate,
    );
    const result = await createService(host).searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'needle' },
      new AbortController().signal,
    );

    expect(result.result.returnedMatchCount).toBe(1);
    expect(result.warnings).toContainEqual({
      code: 'RESOURCE_LIMIT_REACHED',
      message: 'A search resource limit was reached.',
    });
  });

  it('stops before a live document would cross the aggregate inspected-byte ceiling', async () => {
    const host = new FakeSearchHost();
    const twoMiB = 'x'.repeat(2 * 1024 * 1024);
    for (let index = 0; index < 33; index += 1) {
      const path = `/workspace/${String(index).padStart(2, '0')}.txt`;
      host.addFile(path, 'disk');
      host.documents.push(liveDocument(`file://${path}`, twoMiB, 1, true));
    }
    const result = await createService(host).searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'not-present' },
      new AbortController().signal,
    );

    expect(result.result.returnedMatchCount).toBe(0);
    expect(result.warnings).toContainEqual({
      code: 'RESOURCE_LIMIT_REACHED',
      message: 'A search resource limit was reached.',
    });
    expect(host.readCalls).toEqual([]);
  });

  it('omits symlinks, escapes, nested roots, binary, invalid UTF-8, and changed files', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/good.ts', 'NEEDLE');
    host.addFile('/workspace/link.ts', 'NEEDLE', stat('symbolicLink'));
    host.addFile('/workspace/escape.ts', 'NEEDLE');
    host.realpaths.set('/workspace/escape.ts', '/outside/private-canary.ts');
    host.addFile('/workspace/packages/app/nested.ts', 'NEEDLE');
    host.addBytes('/workspace/binary.bin', Uint8Array.from([78, 0, 69]));
    host.addBytes('/workspace/invalid.txt', Uint8Array.from([255, 254]));
    host.addBytes(
      '/workspace/oversized.txt',
      Buffer.from('NEEDLE'),
      stat(
        'file',
        'oversized',
        V02_READ_TOOL_LIMITS.searchWorkspaceText.closedFileBytes + 1,
      ),
    );
    host.addFile('/workspace/changed.ts', 'NEEDLE');
    host.stats.set('/workspace/changed.ts', [
      stat('file', 'same', 6),
      stat('file', 'same', 6),
      stat('file', 'changed', 6),
    ]);

    const result = await createService(host, nestedIdentity()).searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'NEEDLE' },
      new AbortController().signal,
    );

    expect(result.result.returnedMatchCount).toBe(1);
    expect(result.result.documents[0]?.document.relativePath).toBe('good.ts');
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'EXTERNAL_LOCATIONS_OMITTED',
      'UNSUPPORTED_ITEMS_OMITTED',
      'FILES_CHANGED_DURING_REQUEST',
    ]);
    expect(JSON.stringify(result)).not.toContain('private-canary');
    expect(JSON.stringify(result)).not.toContain('nested.ts');
  });

  it('drops optional context before locations and keeps the result schema-bounded', async () => {
    const host = new FakeSearchHost();
    host.addFile(
      '/workspace/context.txt',
      Array.from(
        { length: 1_000 },
        (_, index) => `${String(index).padStart(4, '0')} ${'x'.repeat(280)} NEEDLE`,
      ).join('\n'),
    );
    const result = await createService(host).searchWorkspaceText(
      {
        workspaceFolderId: 'root',
        query: 'NEEDLE',
        contextLines: 1,
        limit: 1_000,
      },
      new AbortController().signal,
    );

    expect(result.result.returnedMatchCount).toBe(1_000);
    expect(
      result.result.documents[0]?.matches.some((match) => match.context === null),
    ).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.warnings[0]?.code).toBe('CONTENT_TRUNCATED');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      V02_READ_TOOL_LIMITS.serializedResultBytes,
    );
  });

  it('withholds tail locations before the serialized ceiling and returns a usable cursor', async () => {
    const host = new FakeSearchHost();
    for (let index = 0; index < 300; index += 1) {
      host.addFile(
        `/workspace/${String(index).padStart(3, '0')}-${'p'.repeat(1_800)}.ts`,
        'needle',
      );
    }
    const result = await createService(host).searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'needle', limit: 500 },
      new AbortController().signal,
    );

    expect(result.result.returnedMatchCount).toBeGreaterThan(0);
    expect(result.result.returnedMatchCount).toBeLessThan(300);
    expect(result.result.hasMore).toBe(true);
    expect(result.result.nextCursor).not.toBeNull();
    expect(result.warnings[0]?.code).toBe('RESULTS_TRUNCATED');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      V02_READ_TOOL_LIMITS.serializedResultBytes,
    );
  });

  it('rejects tampered and cross-query cursors before discovery', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/a.ts', 'needle needle');
    const service = createService(host);
    const first = await service.searchWorkspaceText(
      { workspaceFolderId: 'root', query: 'needle', limit: 1 },
      new AbortController().signal,
    );
    const cursor = first.result.nextCursor;
    expect(cursor).not.toBeNull();
    const calls = host.findCalls;

    for (const [query, value] of [
      ['needle', `${cursor?.slice(0, -1)}x`],
      ['other', cursor],
    ] as const) {
      await expect(
        service.searchWorkspaceText(
          { workspaceFolderId: 'root', query, cursor: value },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
    expect(host.findCalls).toBe(calls);
  });

  it('cancels queued or active reads without returning late content', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/a.ts', 'needle');
    const controller = new AbortController();
    host.onRead = async (signal) => {
      controller.abort();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
        if (signal.aborted) {
          reject(new Error('aborted'));
        }
      });
    };
    await expect(
      createService(host).searchWorkspaceText(
        { workspaceFolderId: 'root', query: 'needle' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('fails closed when the discovery deadline expires before a result exists', async () => {
    const host = new FakeSearchHost();
    host.addFile('/workspace/a.ts', 'needle');
    const service = createService(host, rootIdentity(), {
      setTimer(callback) {
        callback();
        return 1;
      },
      clearTimer() {},
    });
    await expect(
      service.searchWorkspaceText(
        { workspaceFolderId: 'root', query: 'needle' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('shares the closed-read scheduler ceiling across concurrent callers', async () => {
    const scheduler = new BoundedReadScheduler(2);
    let active = 0;
    let peak = 0;
    const operation = () =>
      scheduler.run(new AbortController().signal, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });
    await Promise.all(Array.from({ length: 8 }, operation));
    expect(peak).toBe(2);
  });
});

class FakeSearchHost implements WorkspaceTextSearchHost {
  public candidates: WorkspaceFileDiscoveryCandidate[] = [];
  public documents: EditorHostDocument[] = [];
  public readonly stats = new Map<string, WorkspaceFileDiscoveryEntryStat[]>();
  public readonly statCalls = new Map<string, number>();
  public readonly realpaths = new Map<string, string>();
  public readonly files = new Map<string, Uint8Array>();
  public readonly readCalls: string[] = [];
  public findCalls = 0;
  public lastFind:
    | {
        folderUri: string;
        include: string;
        exclude: string | null;
        maximumResults: number;
      }
    | undefined;
  public onRead: ((signal: AbortSignal) => Promise<void>) | undefined;

  public addFile(
    path: string,
    text: string,
    entryStat: WorkspaceFileDiscoveryEntryStat = stat(
      'file',
      path,
      Buffer.byteLength(text, 'utf8'),
    ),
  ): void {
    this.addBytes(path, Buffer.from(text, 'utf8'), entryStat);
  }

  public addBytes(
    path: string,
    bytes: Uint8Array,
    entryStat: WorkspaceFileDiscoveryEntryStat = stat('file', path, bytes.byteLength),
  ): void {
    this.candidates.push({ uri: `file://${path}` });
    this.files.set(path, bytes);
    this.stats.set(path, [entryStat]);
  }

  public findFiles(
    folderUri: string,
    include: string,
    exclude: string | null,
    maximumResults: number,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceFileDiscoveryCandidate[]> {
    this.findCalls += 1;
    this.lastFind = { folderUri, include, exclude, maximumResults };
    return signal.aborted
      ? Promise.reject(new Error('aborted'))
      : Promise.resolve(this.candidates.slice(0, maximumResults));
  }

  public lstat(path: string): Promise<WorkspaceFileDiscoveryEntryStat> {
    const values = this.stats.get(path);
    const call = this.statCalls.get(path) ?? 0;
    this.statCalls.set(path, call + 1);
    const value = values?.[Math.min(call, values.length - 1)];
    return value === undefined
      ? Promise.reject(new Error('missing'))
      : Promise.resolve(value);
  }

  public realpath(path: string): Promise<string> {
    return Promise.resolve(this.realpaths.get(path) ?? path);
  }

  public async readFile(path: string, signal: AbortSignal) {
    this.readCalls.push(path);
    await this.onRead?.(signal);
    const bytes = this.files.get(path);
    if (bytes === undefined) {
      throw new Error('missing');
    }
    const before = await this.lstat(path);
    const after = await this.lstat(path);
    return { bytes, before, after };
  }

  public openDocuments(): EditorHostIterable<EditorHostDocument> {
    return {
      [Symbol.iterator]: () => this.documents[Symbol.iterator](),
    };
  }
}

function createService(
  host: FakeSearchHost,
  identity: WorkspaceIdentity = rootIdentity(),
  timers: {
    readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
  } = {},
): WorkspaceTextSearchService {
  return new WorkspaceTextSearchService({
    instanceId: INSTANCE_ID,
    cursorCodec: new WorkspaceDiscoveryCursorCodec(randomBytes(32)),
    host,
    scheduler: new BoundedReadScheduler(2),
    getWorkspaceAccess: () => ({ eligible: true, identity }),
    pathStrategy: POSIX_PATHS,
    now: () => NOW,
    ...(timers.setTimer === undefined ? {} : { setTimer: timers.setTimer }),
    ...(timers.clearTimer === undefined ? {} : { clearTimer: timers.clearTimer }),
  });
}

function stat(
  kind: WorkspaceFileDiscoveryEntryStat['kind'] = 'file',
  identity = 'entry',
  size = 6,
  modifiedTime = NOW.getTime(),
): WorkspaceFileDiscoveryEntryStat {
  return { kind, identity, size, modifiedTime };
}

function liveDocument(
  uri: string,
  text: string,
  version: number,
  isDirty: boolean,
): EditorHostDocument {
  const lines = text.split('\n');
  return {
    uri,
    languageId: 'typescript',
    version,
    isDirty,
    lineCount: lines.length,
    eol: 'LF',
    lineText(line) {
      const value = lines[line];
      if (value === undefined) {
        throw new RangeError('line');
      }
      return value;
    },
  };
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
