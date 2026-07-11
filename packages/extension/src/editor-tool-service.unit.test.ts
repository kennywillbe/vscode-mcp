import { Buffer } from 'node:buffer';

import { TOOL_LIMITS } from '@vscode-mcp/protocol/constants';
import { describe, expect, it } from 'vitest';

import type {
  EditorHostDocument,
  EditorHostFileStat,
  EditorHostIterable,
  EditorHostTab,
  EditorHostTabSource,
  EditorHostView,
  EditorToolHost,
} from './editor-tool-host.js';
import { EditorToolService } from './editor-tool-service.js';
import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

const FIXED_NOW = new Date('2026-07-10T08:00:00.000Z');
const POSIX_PATHS = createWorkspaceAuthorizationPathStrategy('posix');

describe('EditorToolService', () => {
  it('returns bounded dirty editor context and leaks no inaccessible metadata', async () => {
    const dirty = createDocument(
      'file:///workspace/packages/app/src/index.ts',
      'const value = 1;\n',
      { dirty: true, languageId: 'typescript', version: 7 },
    ).document;
    const outside = createDocument(
      'file:///outside/private-secret.ts',
      'secret',
    ).document;
    const unsupported = createDocument('untitled:private-label', 'scratch').document;
    const selections = Array.from({ length: 33 }, () => selection(0, 0, 0, 5));
    const active: EditorHostView = {
      document: dirty,
      selections,
      visibleRanges: [range(0, 0, 0, 16)],
    };
    const host = new FakeEditorHost();
    host.active = active;
    host.visible = [active, view(outside), view(unsupported)];
    host.documents = [dirty, outside, unsupported];
    host.tabItems = [tab(0, dirty), tab(0, outside), tab(1, null)];
    const service = createService(host);

    const response = await service.callTool(
      {
        tool: 'get_editor_context',
        arguments: { documentLimit: 1, tabLimit: 1 },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      observedAt: FIXED_NOW.toISOString(),
      truncated: true,
      warnings: [
        { code: 'RESULTS_TRUNCATED', omittedCount: 2 },
        { code: 'EXTERNAL_LOCATIONS_OMITTED', omittedCount: 3 },
        { code: 'UNSUPPORTED_ITEMS_OMITTED', omittedCount: 3 },
      ],
      payload: {
        tool: 'get_editor_context',
        result: {
          activeEditor: {
            document: {
              uri: dirty.uri,
              workspaceFolderId: 'app',
              relativePath: 'src/index.ts',
              languageId: 'typescript',
              documentVersion: 7,
              isDirty: true,
            },
            selections: { length: 32 },
          },
          visibleEditors: { length: 1 },
          openDocuments: { length: 1 },
          tabs: { length: 1 },
          omitted: { editors: 2, documents: 2, tabs: 2 },
        },
      },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('private-secret');
    expect(serialized).not.toContain('private-label');
    expect(serialized).not.toContain('/outside');
  });

  it('strictly rejects extra arguments before consulting workspace state', async () => {
    const host = new FakeEditorHost();
    let accessCalls = 0;
    const service = createService(host, {
      getAccess: () => {
        accessCalls += 1;
        return { eligible: true, identity: workspaceIdentity() };
      },
    });

    const response = await service.callTool(
      { tool: 'get_editor_context', arguments: { unexpected: true } },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      tool: 'get_editor_context',
      error: { code: 'INVALID_ARGUMENT', retryable: false },
    });
    expect(accessCalls).toBe(0);
  });

  it('consumes tabs lazily from an async host source and preserves adapter omissions', async () => {
    const document = createDocument('file:///workspace/lazy.ts', 'value').document;
    const host = new FakeEditorHost();
    host.active = {
      document,
      selections: [],
      visibleRanges: [],
      omittedSelections: 3,
      omittedVisibleRanges: 2,
    };
    let tabYields = 0;
    host.tabSource = (async function* (): AsyncIterable<EditorHostTab> {
      tabYields += 1;
      yield tab(0, document);
    })();

    const response = await createService(host).callTool(
      { tool: 'get_editor_context', arguments: {} },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      truncated: true,
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 5 }],
      payload: {
        tool: 'get_editor_context',
        result: { tabs: [{ document: { relativePath: 'lazy.ts' } }] },
      },
    });
    expect(tabYields).toBe(1);
  });

  it('reports collection entries omitted by the lazy production boundary', async () => {
    const host = new FakeEditorHost();
    host.omittedVisibleEditors = 2;
    host.omittedOpenDocuments = 3;
    host.omittedTabs = 4;

    const response = await createService(host).callTool(
      { tool: 'get_editor_context', arguments: {} },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      truncated: true,
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 9 }],
      payload: {
        tool: 'get_editor_context',
        result: { omitted: { editors: 2, documents: 3, tabs: 4 } },
      },
    });
  });

  it('applies editor defaults and rejects values above the contract hard limits', async () => {
    const host = new FakeEditorHost();
    host.documents = Array.from(
      { length: 101 },
      (_, index) =>
        createDocument(`file:///workspace/generated-${index}.ts`, '').document,
    );
    const service = createService(host);

    const defaultLimited = await service.callTool(
      { tool: 'get_editor_context', arguments: {} },
      new AbortController().signal,
    );
    expect(defaultLimited).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
      payload: {
        tool: 'get_editor_context',
        result: {
          openDocuments: { length: TOOL_LIMITS.editorContext.documentsDefault },
          omitted: { documents: 1 },
        },
      },
    });

    const aboveHardLimit = await service.callTool(
      {
        tool: 'get_editor_context',
        arguments: {
          documentLimit: TOOL_LIMITS.editorContext.documentsMax + 1,
          tabLimit: TOOL_LIMITS.editorContext.tabsMax + 1,
        },
      },
      new AbortController().signal,
    );
    expect(aboveHardLimit).toMatchObject({
      outcome: 'toolError',
      error: { code: 'INVALID_ARGUMENT' },
    });

    const aboveReadHardLimit = await service.callTool(
      {
        tool: 'read_document',
        arguments: {
          document: { kind: 'uri', uri: 'file:///workspace/file.ts' },
          lineCount: TOOL_LIMITS.readDocument.lineCountMax + 1,
        },
      },
      new AbortController().signal,
    );
    expect(aboveReadHardLimit).toMatchObject({
      outcome: 'toolError',
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('reads an unsaved live buffer without statting or reopening the file', async () => {
    const live = createDocument(
      'file:///workspace/src/index.ts',
      'disk-like\nunsaved😀\nlast',
      { dirty: true, languageId: 'typescript', version: 11 },
    ).document;
    const host = new FakeEditorHost();
    host.documents = [live];
    const service = createService(host);

    const response = await service.callTool(
      {
        tool: 'read_document',
        arguments: {
          document: { kind: 'uri', uri: live.uri },
          expectedDocumentVersion: 11,
          startLine: 1,
          lineCount: 1,
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      truncated: true,
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
      payload: {
        tool: 'read_document',
        result: {
          document: {
            documentVersion: 11,
            isDirty: true,
            workspaceFolderId: 'outer',
            relativePath: 'src/index.ts',
          },
          totalLineCount: 3,
          returnedRange: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 9 },
          },
          text: 'unsaved😀',
          hasMore: true,
          nextStartLine: 2,
        },
      },
    });
    expect(host.statCalls).toEqual([]);
    expect(host.openCalls).toEqual([]);
  });

  it('checks the 10 MiB closed-file limit before opening', async () => {
    const host = new FakeEditorHost();
    host.fileStat = {
      size: TOOL_LIMITS.readDocument.closedFileBytes + 1,
      isFile: true,
    };
    const service = createService(host);

    const response = await service.callTool(
      readInvocation('file:///workspace/large.ts'),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      tool: 'read_document',
      error: {
        code: 'DOCUMENT_TOO_LARGE',
        retryable: false,
        details: {
          maximumBytes: TOOL_LIMITS.readDocument.closedFileBytes,
          actualBytes: TOOL_LIMITS.readDocument.closedFileBytes + 1,
        },
      },
    });
    expect(host.statCalls).toEqual(['/workspace/large.ts']);
    expect(host.openCalls).toEqual([]);
  });

  it('opens a bounded closed file by canonical URI and reauthorizes the result', async () => {
    const host = new FakeEditorHost();
    host.fileStat = { size: 12, isFile: true };
    host.openedDocument = createDocument('file:///workspace/real.ts', 'first\nsecond', {
      version: 2,
    }).document;
    const service = createService(host, {
      realpath: async (path) =>
        path === '/workspace/link.ts' ? '/workspace/real.ts' : path,
    });

    const response = await service.callTool(
      readInvocation('file:///workspace/link.ts'),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      payload: {
        tool: 'read_document',
        result: {
          text: 'first\nsecond',
          document: {
            uri: 'file:///workspace/real.ts',
            relativePath: 'real.ts',
          },
        },
      },
    });
    expect(host.statCalls).toEqual(['/workspace/real.ts']);
    expect(host.openCalls).toEqual(['file:///workspace/real.ts']);
  });

  it('never splits a Unicode code point at the 256 KiB content ceiling', async () => {
    const asciiPrefix = 'a'.repeat(TOOL_LIMITS.readDocument.returnedTextBytes - 1);
    const live = createDocument('file:///workspace/huge.ts', `${asciiPrefix}😀tail`, {
      dirty: true,
    }).document;
    const host = new FakeEditorHost();
    host.documents = [live];
    const service = createService(host);

    const response = await service.callTool(
      readInvocation(live.uri),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      truncated: true,
      warnings: [{ code: 'CONTENT_TRUNCATED' }],
      payload: {
        tool: 'read_document',
        result: {
          text: asciiPrefix,
          hasMore: false,
          nextStartLine: null,
          returnedRange: {
            end: { line: 0, character: asciiPrefix.length },
          },
        },
      },
    });
    if (response.outcome === 'success' && response.payload.tool === 'read_document') {
      expect(Buffer.byteLength(response.payload.result.text, 'utf8')).toBe(
        TOOL_LIMITS.readDocument.returnedTextBytes - 1,
      );
      expect(response.payload.result.text.endsWith('\ud83d')).toBe(false);
    }
  });

  it('paginates on whole line boundaries with an exact half-open range', async () => {
    const live = createDocument(
      'file:///workspace/lines.txt',
      'alpha\nbeta\ngamma\ndelta',
    ).document;
    const host = new FakeEditorHost();
    host.documents = [live];
    const service = createService(host);

    const response = await service.callTool(
      {
        tool: 'read_document',
        arguments: {
          document: { kind: 'uri', uri: live.uri },
          startLine: 1,
          lineCount: 2,
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      payload: {
        tool: 'read_document',
        result: {
          text: 'beta\ngamma',
          returnedRange: {
            start: { line: 1, character: 0 },
            end: { line: 2, character: 5 },
          },
          hasMore: true,
          nextStartLine: 3,
        },
      },
    });
  });

  it('preserves CRLF text while keeping UTF-16 half-open positions', async () => {
    const live = createDocument(
      'file:///workspace/windows.txt',
      'first\r\n\ud83d\ude00second',
      { eol: 'CRLF' },
    ).document;
    const host = new FakeEditorHost();
    host.documents = [live];
    const service = createService(host);

    const response = await service.callTool(
      readInvocation(live.uri),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      payload: {
        tool: 'read_document',
        result: {
          eol: 'CRLF',
          text: 'first\r\n\ud83d\ude00second',
          returnedRange: {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 8 },
          },
        },
      },
    });
  });

  it('returns stable version and range failures without source or path details', async () => {
    const live = createDocument('file:///workspace/versioned.ts', 'one', {
      version: 4,
    }).document;
    const host = new FakeEditorHost();
    host.documents = [live];
    const service = createService(host);

    const versionFailure = await service.callTool(
      {
        tool: 'read_document',
        arguments: {
          document: { kind: 'uri', uri: live.uri },
          expectedDocumentVersion: 3,
        },
      },
      new AbortController().signal,
    );
    const rangeFailure = await service.callTool(
      {
        tool: 'read_document',
        arguments: {
          document: { kind: 'uri', uri: live.uri },
          startLine: 1,
        },
      },
      new AbortController().signal,
    );

    expect(versionFailure).toMatchObject({
      outcome: 'toolError',
      error: {
        code: 'DOCUMENT_VERSION_MISMATCH',
        details: { expectedDocumentVersion: 3, actualDocumentVersion: 4 },
      },
    });
    expect(rangeFailure).toMatchObject({
      outcome: 'toolError',
      error: {
        code: 'POSITION_OUT_OF_RANGE',
        details: { totalLineCount: 1 },
      },
    });
    expect(JSON.stringify([versionFailure, rangeFailure])).not.toContain(
      'versioned.ts',
    );
  });

  it('discards a read if the live document changes while lines are captured', async () => {
    const fixture = createDocument('file:///workspace/changing.ts', 'one\ntwo', {
      version: 5,
    });
    fixture.onLineText = () => {
      fixture.version = 6;
    };
    const host = new FakeEditorHost();
    host.documents = [fixture.document];
    const service = createService(host);

    const response = await service.callTool(
      readInvocation(fixture.document.uri),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_CHANGED_DURING_REQUEST', retryable: true },
    });
  });

  it('discards a read changed during the final workspace eligibility check', async () => {
    const live = createDocument('file:///workspace/changing-late.ts', 'one', {
      version: 5,
    });
    const host = new FakeEditorHost();
    host.documents = [live.document];
    let accessChecks = 0;
    const service = createService(host, {
      getAccess: () => {
        accessChecks += 1;
        if (accessChecks === 2) {
          live.version = 6;
        }
        return { eligible: true as const, identity: workspaceIdentity() };
      },
    });

    const response = await service.callTool(
      readInvocation(live.document.uri),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_CHANGED_DURING_REQUEST', retryable: true },
    });
    expect(accessChecks).toBe(2);
  });

  it('fails closed for symlink escapes before any stat or open', async () => {
    const host = new FakeEditorHost();
    const service = createService(host, {
      realpath: async (path) =>
        path === '/workspace/link/secret.ts' ? '/outside/secret.ts' : path,
    });

    const response = await service.callTool(
      readInvocation('file:///workspace/link/secret.ts'),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_OUTSIDE_WORKSPACE' },
    });
    expect(host.statCalls).toEqual([]);
    expect(host.openCalls).toEqual([]);
    expect(JSON.stringify(response)).not.toContain('secret.ts');
  });

  it('checks cancellation and revalidates workspace eligibility before success', async () => {
    const host = new FakeEditorHost();
    const cancelledService = createService(host);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await cancelledService.callTool(
      { tool: 'get_editor_context', arguments: {} },
      controller.signal,
    );
    expect(cancelled).toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED', retryable: true },
    });

    let calls = 0;
    const changingService = createService(host, {
      getAccess: () => {
        calls += 1;
        return calls === 1
          ? { eligible: true, identity: workspaceIdentity() }
          : { eligible: false };
      },
    });
    const changed = await changingService.callTool(
      { tool: 'get_editor_context', arguments: {} },
      new AbortController().signal,
    );
    expect(changed).toMatchObject({
      outcome: 'toolError',
      error: { code: 'WORKSPACE_UNTRUSTED' },
    });
    expect(calls).toBe(2);
  });

  it('retains a cancelled closed-file execution until its stat settles', async () => {
    const host = new FakeEditorHost();
    let resolveStat: ((value: EditorHostFileStat) => void) | undefined;
    host.statResult = new Promise<EditorHostFileStat>((resolve) => {
      resolveStat = resolve;
    });
    const controller = new AbortController();
    const call = createService(host).callTool(
      readInvocation('file:///workspace/pending.ts'),
      controller.signal,
    );
    await waitFor(() => host.statCalls.length === 1);

    let settled = false;
    void call.then(() => {
      settled = true;
    });
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    resolveStat?.({ size: 0, isFile: true });
    const response = await call;

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED', retryable: true },
    });
    expect(host.openCalls).toEqual([]);
  });
});

class FakeEditorHost implements EditorToolHost {
  public active: EditorHostView | null = null;
  public visible: readonly EditorHostView[] = [];
  public documents: readonly EditorHostDocument[] = [];
  public tabItems: readonly EditorHostTab[] = [];
  public tabSource: Iterable<EditorHostTab> | AsyncIterable<EditorHostTab> | null =
    null;
  public omittedVisibleEditors = 0;
  public omittedOpenDocuments = 0;
  public omittedTabs = 0;
  public fileStat: EditorHostFileStat = { size: 0, isFile: true };
  public statResult: Promise<EditorHostFileStat> | null = null;
  public openedDocument: EditorHostDocument = createDocument(
    'file:///workspace/opened.ts',
    '',
  ).document;
  public readonly statCalls: string[] = [];
  public readonly openCalls: string[] = [];

  public activeEditor(): EditorHostView | null {
    return this.active;
  }

  public visibleEditors(): EditorHostIterable<EditorHostView> {
    return iterableWithOmissions(this.visible, this.omittedVisibleEditors);
  }

  public openDocuments(): EditorHostIterable<EditorHostDocument> {
    return iterableWithOmissions(this.documents, this.omittedOpenDocuments);
  }

  public tabs(): EditorHostTabSource {
    const source = this.tabSource ?? this.tabItems;
    const omittedCount = this.omittedTabs;
    return {
      omittedCount,
      async *[Symbol.asyncIterator](): AsyncIterator<EditorHostTab> {
        for await (const item of source) {
          yield item;
        }
      },
    };
  }

  public statFile(canonicalPath: string): Promise<EditorHostFileStat> {
    this.statCalls.push(canonicalPath);
    return this.statResult ?? Promise.resolve(this.fileStat);
  }

  public openTextDocument(uri: string): Promise<EditorHostDocument> {
    this.openCalls.push(uri);
    return Promise.resolve(this.openedDocument);
  }
}

function iterableWithOmissions<Value>(
  items: readonly Value[],
  omittedCount: number,
): EditorHostIterable<Value> {
  return {
    omittedCount,
    *[Symbol.iterator](): Iterator<Value> {
      yield* items;
    },
  };
}

interface MutableDocumentFixture {
  readonly document: EditorHostDocument;
  version: number;
  dirty: boolean;
  onLineText: (() => void) | undefined;
}

interface DocumentOptions {
  readonly version?: number;
  readonly dirty?: boolean;
  readonly languageId?: string;
  readonly eol?: 'LF' | 'CRLF';
}

function createDocument(
  uri: string,
  text: string,
  options: DocumentOptions = {},
): MutableDocumentFixture {
  const eol = options.eol ?? 'LF';
  const lines = text.split(eol === 'CRLF' ? '\r\n' : '\n');
  const fixture: MutableDocumentFixture = {
    version: options.version ?? 1,
    dirty: options.dirty ?? false,
    onLineText: undefined,
    document: {
      uri,
      languageId: options.languageId ?? 'plaintext',
      get version(): number {
        return fixture.version;
      },
      get isDirty(): boolean {
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

function view(document: EditorHostDocument): EditorHostView {
  return { document, selections: [], visibleRanges: [] };
}

function tab(groupIndex: number, document: EditorHostDocument | null): EditorHostTab {
  return {
    groupIndex,
    active: groupIndex === 0,
    pinned: true,
    preview: false,
    dirty: document?.isDirty ?? false,
    document,
  };
}

function selection(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    anchor: { line: startLine, character: startCharacter },
    active: { line: endLine, character: endCharacter },
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

interface ServiceOverrides {
  readonly getAccess?: () =>
    | { readonly eligible: true; readonly identity: WorkspaceIdentity }
    | { readonly eligible: false };
  readonly realpath?: (path: string) => Promise<string>;
}

function createService(
  host: EditorToolHost,
  overrides: ServiceOverrides = {},
): EditorToolService {
  return new EditorToolService({
    host,
    getWorkspaceAccess:
      overrides.getAccess ??
      (() => ({ eligible: true, identity: workspaceIdentity() })),
    realpath: overrides.realpath ?? ((path) => Promise.resolve(path)),
    pathStrategy: POSIX_PATHS,
    now: () => FIXED_NOW,
  });
}

function workspaceIdentity(): WorkspaceIdentity {
  return {
    fingerprint: 'a'.repeat(64),
    displayName: 'fixture',
    workspaceFileUri: null,
    folders: [
      {
        workspaceFolderId: 'outer',
        name: 'outer',
        uri: 'file:///workspace',
        canonicalPath: '/workspace',
      },
      {
        workspaceFolderId: 'app',
        name: 'app',
        uri: 'file:///workspace/packages/app',
        canonicalPath: '/workspace/packages/app',
      },
    ],
  };
}

function readInvocation(uri: string): object {
  return {
    tool: 'read_document',
    arguments: { document: { kind: 'uri', uri } },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 100;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('The expected operation was not observed.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
