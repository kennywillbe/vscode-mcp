import { Buffer } from 'node:buffer';

import { TOOL_LIMITS, V02_READ_TOOL_LIMITS } from '@vscode-mcp/protocol/constants';
import { V02ReadDocumentsSuccessSchema } from '@vscode-mcp/protocol/tool-schemas-v0.2';
import { describe, expect, it } from 'vitest';

import type {
  EditorHostDocument,
  EditorHostFileStat,
  EditorHostIterable,
  EditorHostTabSource,
  EditorHostView,
  EditorToolHost,
} from './editor-tool-host.js';
import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import { WorkspaceDocumentBatchService } from './workspace-document-batch-service.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

const INSTANCE_ID = 'a12f0291-37e2-4ff6-b763-0abf3fe66714';
const FIXED_NOW = new Date('2026-07-11T02:00:00.000Z');
const POSIX_PATHS = createWorkspaceAuthorizationPathStrategy('posix');

describe('WorkspaceDocumentBatchService', () => {
  it('preserves caller order, duplicates, ranges, and dirty live-buffer precedence', async () => {
    const host = new FakeBatchHost();
    const live = document('file:///workspace/a.ts', 'live one\nlive two\nlive three', {
      version: 7,
      dirty: true,
      languageId: 'typescript',
    });
    host.documents = [live.document];
    host.opened.set(
      'file:///workspace/b.ts',
      document('file:///workspace/b.ts', 'closed value').document,
    );
    const result = await createService(host).readDocuments(
      {
        workspaceFolderId: 'root',
        documents: [
          { document: workspacePath('a.ts'), startLine: 1, lineCount: 1 },
          { document: workspacePath('b.ts') },
          { document: workspacePath('a.ts'), startLine: 0, lineCount: 1 },
        ],
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      contractVersion: '0.2.0',
      instanceId: INSTANCE_ID,
      observedAt: FIXED_NOW.toISOString(),
      truncated: false,
      warnings: [],
      result: { workspaceFolderId: 'root' },
    });
    expect(result.result.items.map(itemText)).toEqual([
      'live two',
      'closed value',
      'live one',
    ]);
    expect(result.result.items[0]).toMatchObject({
      outcome: 'success',
      document: { documentVersion: 7, isDirty: true, relativePath: 'a.ts' },
      hasMore: true,
      nextStartLine: 2,
    });
    expect(host.openCalls).toEqual(['file:///workspace/b.ts']);
  });

  it('returns safe per-item errors without losing successful siblings or crossing roots', async () => {
    const host = new FakeBatchHost();
    host.documents = [
      document('file:///workspace/good.ts', 'good', { version: 3 }).document,
      document('file:///workspace/packages/app/nested.ts', 'nested').document,
    ];
    const result = await createService(host, nestedIdentity()).readDocuments(
      {
        workspaceFolderId: 'root',
        documents: [
          { document: workspacePath('good.ts'), expectedDocumentVersion: 3 },
          { document: workspacePath('missing.ts') },
          { document: workspacePath('good.ts'), expectedDocumentVersion: 2 },
          {
            document: {
              kind: 'workspacePath',
              workspaceFolderId: 'app',
              relativePath: 'nested.ts',
            },
          },
          { document: workspacePath('packages/app/nested.ts') },
        ],
      },
      new AbortController().signal,
    );

    expect(result.result.items).toHaveLength(5);
    expect(result.result.items.map(itemCode)).toEqual([
      'success',
      'DOCUMENT_NOT_FOUND',
      'DOCUMENT_VERSION_MISMATCH',
      'WORKSPACE_FOLDER_NOT_FOUND',
      'DOCUMENT_OUTSIDE_WORKSPACE',
    ]);
    expect(JSON.stringify(result)).not.toContain('/workspace');
    expect(host.openCalls).not.toContain('file:///workspace/packages/app/nested.ts');
  });

  it('marks the current and remaining items when the caller content budget is exhausted', async () => {
    const host = new FakeBatchHost();
    const reads: string[] = [];
    const first = document('file:///workspace/a.ts', '12345');
    const second = document('file:///workspace/b.ts', '67890');
    const third = document('file:///workspace/c.ts', 'tail');
    first.onLineText = () => reads.push('a.ts');
    second.onLineText = () => reads.push('b.ts');
    third.onLineText = () => reads.push('c.ts');
    host.documents = [first.document, second.document, third.document];
    const result = await createService(host).readDocuments(
      {
        workspaceFolderId: 'root',
        contentByteLimit: 6,
        documents: [
          { document: workspacePath('a.ts') },
          { document: workspacePath('b.ts') },
          { document: workspacePath('c.ts') },
        ],
      },
      new AbortController().signal,
    );

    expect(result.result.items.map(itemCode)).toEqual([
      'success',
      'BATCH_BUDGET_EXHAUSTED',
      'BATCH_BUDGET_EXHAUSTED',
    ]);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toEqual([
      {
        code: 'RESOURCE_LIMIT_REACHED',
        message: 'The batch response budget was reached.',
      },
    ]);
    expect(reads).toEqual(['a.ts', 'b.ts']);
  });

  it('reserves every tail error and stays below the serialized success ceiling', async () => {
    const host = new FakeBatchHost();
    const documents = Array.from(
      { length: V02_READ_TOOL_LIMITS.readDocuments.itemsMax },
      (_, index) => {
        const relativePath = `${String(index).padStart(2, '0')}-${'p'.repeat(3_900)}.ts`;
        const uri = `file:///workspace/${relativePath}`;
        host.documents.push(document(uri, 'x'.repeat(10_240)).document);
        return { document: workspacePath(relativePath) };
      },
    );
    const result = await createService(host).readDocuments(
      {
        workspaceFolderId: 'root',
        contentByteLimit: V02_READ_TOOL_LIMITS.readDocuments.contentBytesMax,
        documents,
      },
      new AbortController().signal,
    );

    expect(result.result.items).toHaveLength(documents.length);
    expect(result.result.items.some((item) => itemCode(item) === 'success')).toBe(true);
    expect(
      result.result.items.some((item) => itemCode(item) === 'BATCH_BUDGET_EXHAUSTED'),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      V02_READ_TOOL_LIMITS.serializedResultBytes,
    );
    expect(V02ReadDocumentsSuccessSchema.safeParse(result).success).toBe(true);
  });

  it('reports per-document byte truncation explicitly, including a final long line', async () => {
    const host = new FakeBatchHost();
    host.documents = [
      document(
        'file:///workspace/long.ts',
        '😀'.repeat(TOOL_LIMITS.readDocument.returnedTextBytes),
      ).document,
    ];
    const result = await createService(host).readDocuments(
      {
        workspaceFolderId: 'root',
        contentByteLimit: V02_READ_TOOL_LIMITS.readDocuments.contentBytesMax,
        documents: [{ document: workspacePath('long.ts') }],
      },
      new AbortController().signal,
    );

    expect(result.truncated).toBe(true);
    expect(result.warnings).toEqual([
      {
        code: 'CONTENT_TRUNCATED',
        message: 'Document content was truncated at the per-item byte limit.',
      },
    ]);
    expect(result.result.items[0]).toMatchObject({
      outcome: 'success',
      hasMore: false,
      nextStartLine: null,
    });
  });

  it('fails the entire request on cancellation and starts no later item', async () => {
    const controller = new AbortController();
    const host = new FakeBatchHost();
    const first = document('file:///workspace/a.ts', 'cancel');
    first.onLineText = () => controller.abort();
    let secondRead = false;
    const second = document('file:///workspace/b.ts', 'must not read');
    second.onLineText = () => {
      secondRead = true;
    };
    host.documents = [first.document, second.document];

    await expect(
      createService(host).readDocuments(
        {
          workspaceFolderId: 'root',
          documents: [
            { document: workspacePath('a.ts') },
            { document: workspacePath('b.ts') },
          ],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED', requestLevel: true });
    expect(secondRead).toBe(false);
  });

  it('fails the entire request when eligibility is lost during an item', async () => {
    const host = new FakeBatchHost();
    host.documents = [document('file:///workspace/a.ts', 'value').document];
    let checks = 0;
    const service = createService(host, rootIdentity(), () => {
      checks += 1;
      return checks < 4
        ? { eligible: true as const, identity: rootIdentity() }
        : { eligible: false as const };
    });

    await expect(
      service.readDocuments(
        {
          workspaceFolderId: 'root',
          documents: [{ document: workspacePath('a.ts') }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_UNTRUSTED', requestLevel: true });
  });

  it('rejects malformed top-level input and unknown folders before reading', async () => {
    const host = new FakeBatchHost();
    const service = createService(host);
    await expect(
      service.readDocuments(
        { workspaceFolderId: 'root', documents: [] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', requestLevel: true });
    await expect(
      service.readDocuments(
        {
          workspaceFolderId: 'unknown',
          documents: [{ document: workspacePath('a.ts') }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_FOLDER_NOT_FOUND',
      requestLevel: true,
    });
    expect(host.openCalls).toEqual([]);
  });
});

class FakeBatchHost implements EditorToolHost {
  public documents: EditorHostDocument[] = [];
  public readonly opened = new Map<string, EditorHostDocument>();
  public readonly openCalls: string[] = [];

  public activeEditor(): EditorHostView | null {
    return null;
  }

  public visibleEditors(): EditorHostIterable<EditorHostView> {
    return iterable([]);
  }

  public openDocuments(): EditorHostIterable<EditorHostDocument> {
    return iterable(this.documents);
  }

  public tabs(): EditorHostTabSource {
    return {
      async *[Symbol.asyncIterator]() {
        // Batch reads do not inspect tabs.
      },
    };
  }

  public statFile(canonicalPath: string): Promise<EditorHostFileStat> {
    return Promise.resolve({
      size: this.opened.get(`file://${canonicalPath}`)?.lineCount ?? 0,
      isFile: this.opened.has(`file://${canonicalPath}`),
    });
  }

  public openTextDocument(uri: string): Promise<EditorHostDocument> {
    this.openCalls.push(uri);
    const opened = this.opened.get(uri);
    return opened === undefined
      ? Promise.reject(new Error('missing'))
      : Promise.resolve(opened);
  }
}

interface MutableDocument {
  readonly document: EditorHostDocument;
  version: number;
  dirty: boolean;
  onLineText: (() => void) | undefined;
}

function document(
  uri: string,
  text: string,
  options: {
    readonly version?: number;
    readonly dirty?: boolean;
    readonly languageId?: string;
    readonly eol?: 'LF' | 'CRLF';
  } = {},
): MutableDocument {
  const eol = options.eol ?? 'LF';
  const lines = text.split(eol === 'CRLF' ? '\r\n' : '\n');
  const fixture: MutableDocument = {
    version: options.version ?? 1,
    dirty: options.dirty ?? false,
    onLineText: undefined,
    document: {
      uri,
      languageId: options.languageId ?? 'plaintext',
      get version() {
        return fixture.version;
      },
      get isDirty() {
        return fixture.dirty;
      },
      lineCount: lines.length,
      eol,
      lineText(line: number): string {
        fixture.onLineText?.();
        const value = lines[line];
        if (value === undefined) {
          throw new RangeError('Line out of range.');
        }
        return value;
      },
    },
  };
  return fixture;
}

function createService(
  host: FakeBatchHost,
  identity: WorkspaceIdentity = rootIdentity(),
  getAccess: () =>
    | { readonly eligible: true; readonly identity: WorkspaceIdentity }
    | { readonly eligible: false } = () => ({ eligible: true, identity }),
): WorkspaceDocumentBatchService {
  return new WorkspaceDocumentBatchService({
    instanceId: INSTANCE_ID,
    host,
    getWorkspaceAccess: getAccess,
    realpath: async (path) => {
      if (path.endsWith('/missing.ts')) {
        throw new Error('missing');
      }
      return path;
    },
    pathStrategy: POSIX_PATHS,
    now: () => FIXED_NOW,
  });
}

function workspacePath(relativePath: string) {
  return { kind: 'workspacePath' as const, workspaceFolderId: 'root', relativePath };
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

function iterable<Value>(values: readonly Value[]): EditorHostIterable<Value> {
  return {
    *[Symbol.iterator]() {
      yield* values;
    },
  };
}

function itemText(item: unknown): string | null {
  return isRecord(item) &&
    item['outcome'] === 'success' &&
    typeof item['text'] === 'string'
    ? item['text']
    : null;
}

function itemCode(item: unknown): string {
  if (!isRecord(item)) {
    return 'invalid';
  }
  if (item['outcome'] === 'success') {
    return 'success';
  }
  const error = item['error'];
  return isRecord(error) && typeof error['code'] === 'string'
    ? error['code']
    : 'invalid';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
