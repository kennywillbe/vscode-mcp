import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import {
  TOOL_CONTRACT_VERSION,
  V02_READ_DEFAULT_EXCLUDE,
  V02_READ_TOOL_LIMITS,
  V02_TOOL_CONTRACT_VERSION,
} from './constants.js';
import { ALL_TOOL_NAMES, EXTENSION_TOOL_NAMES } from './tool-schemas.js';
import {
  V02FailureSchema,
  V02ListWorkspaceFilesInputSchema,
  V02ListWorkspaceFilesResultSchema,
  V02ReadDocumentsInputSchema,
  V02ReadDocumentsResultSchema,
  V02ReadDocumentsSuccessSchema,
  V02ReadToolInvocationSchema,
  V02ReadToolNameSchema,
  V02SearchWorkspaceTextInputSchema,
  V02SearchWorkspaceTextResultSchema,
  V02WarningSchema,
  V02WarningsSchema,
  createV02SuccessSchema,
} from './tool-schemas-v0.2.js';

const instanceId = 'a12f0291-37e2-4ff6-b763-0abf3fe66714';
const workspaceFolderId = 'root';
const document = {
  kind: 'workspacePath' as const,
  workspaceFolderId,
  relativePath: 'src/index.ts',
};
const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

function successItem(text = 'content') {
  return {
    outcome: 'success' as const,
    document: {
      workspaceFolderId,
      relativePath: 'src/index.ts',
      languageId: 'typescript',
      documentVersion: 1,
      isDirty: false,
    },
    eol: 'LF' as const,
    totalLineCount: 1,
    returnedRange: range,
    text,
    hasMore: false,
    nextStartLine: null,
  };
}

function successEnvelope(result: unknown) {
  return {
    contractVersion: V02_TOOL_CONTRACT_VERSION,
    instanceId,
    observedAt: '2026-07-11T00:00:00.000Z',
    truncated: false,
    warnings: [],
    result,
  };
}

describe('v0.2 read contract isolation', () => {
  it('keeps the active runtime and v0.1 tool inventory unchanged', () => {
    expect(TOOL_CONTRACT_VERSION).toBe('1.0.0');
    expect(V02_TOOL_CONTRACT_VERSION).toBe('0.2.0');
    expect(ALL_TOOL_NAMES).toHaveLength(11);
    expect(EXTENSION_TOOL_NAMES).toHaveLength(10);
    expect(ALL_TOOL_NAMES).not.toContain('list_workspace_files');
  });

  it('contains exactly the three accepted read tool names', () => {
    expect(V02ReadToolNameSchema.options).toEqual([
      'list_workspace_files',
      'read_documents',
      'search_workspace_text',
    ]);
  });

  it('keeps the accepted generated-directory default canonical', () => {
    expect(Buffer.byteLength(V02_READ_DEFAULT_EXCLUDE, 'utf8')).toBeLessThan(
      V02_READ_TOOL_LIMITS.globBytes,
    );
    expect(V02_READ_DEFAULT_EXCLUDE).toContain('.next');
    expect(V02_READ_DEFAULT_EXCLUDE).toContain('.wrangler');
    expect(V02_READ_DEFAULT_EXCLUDE).toContain('.venv');
  });
});

describe('v0.2 read inputs', () => {
  it('accepts strict minimal inputs and rejects unknown keys', () => {
    const inputs = [
      [V02ListWorkspaceFilesInputSchema, { instanceId, workspaceFolderId }],
      [
        V02ReadDocumentsInputSchema,
        { instanceId, workspaceFolderId, documents: [{ document }] },
      ],
      [
        V02SearchWorkspaceTextInputSchema,
        { instanceId, workspaceFolderId, query: 'needle' },
      ],
    ] as const;

    for (const [schema, input] of inputs) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, executeCommand: 'nope' }).success).toBe(
        false,
      );
    }
  });

  it('enforces glob byte, path, and three-state input shapes', () => {
    const atLimit = '😀'.repeat(V02_READ_TOOL_LIMITS.globBytes / 4);
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(V02_READ_TOOL_LIMITS.globBytes);
    expect(
      V02ListWorkspaceFilesInputSchema.safeParse({
        workspaceFolderId,
        include: atLimit,
        exclude: '**/generated/**',
      }).success,
    ).toBe(true);
    expect(
      V02ListWorkspaceFilesInputSchema.safeParse({
        workspaceFolderId,
        include: `${atLimit}a`,
      }).success,
    ).toBe(false);
    for (const include of ['', ' padded ', '/absolute/**', '../bad', 'a\\b']) {
      expect(
        V02ListWorkspaceFilesInputSchema.safeParse({ workspaceFolderId, include })
          .success,
      ).toBe(false);
    }
    expect(
      V02ListWorkspaceFilesInputSchema.safeParse({
        workspaceFolderId,
        exclude: null,
      }).success,
    ).toBe(true);
  });

  it('enforces cursor shape and size', () => {
    const base = { workspaceFolderId };
    expect(
      V02ListWorkspaceFilesInputSchema.safeParse({ ...base, cursor: 'abc.def' })
        .success,
    ).toBe(true);
    expect(
      V02ListWorkspaceFilesInputSchema.safeParse({ ...base, cursor: 'not a cursor' })
        .success,
    ).toBe(false);
    const oversized = `${'a'.repeat(V02_READ_TOOL_LIMITS.cursorCharacters)}.b`;
    expect(
      V02ListWorkspaceFilesInputSchema.safeParse({ ...base, cursor: oversized })
        .success,
    ).toBe(false);
  });

  it('enforces batch count and content-byte limit boundaries', () => {
    const item = { document };
    expect(
      V02ReadDocumentsInputSchema.safeParse({
        workspaceFolderId,
        documents: Array.from(
          { length: V02_READ_TOOL_LIMITS.readDocuments.itemsMax },
          () => item,
        ),
        contentByteLimit: V02_READ_TOOL_LIMITS.readDocuments.contentBytesMax,
      }).success,
    ).toBe(true);
    expect(
      V02ReadDocumentsInputSchema.safeParse({ workspaceFolderId, documents: [] })
        .success,
    ).toBe(false);
    expect(
      V02ReadDocumentsInputSchema.safeParse({
        workspaceFolderId,
        documents: Array.from(
          { length: V02_READ_TOOL_LIMITS.readDocuments.itemsMax + 1 },
          () => item,
        ),
      }).success,
    ).toBe(false);
  });

  it('enforces literal query scalar and NUL rules while preserving whitespace', () => {
    expect(
      V02SearchWorkspaceTextInputSchema.safeParse({
        workspaceFolderId,
        query: '.*[literal]$',
      }).success,
    ).toBe(true);
    expect(
      V02SearchWorkspaceTextInputSchema.safeParse({
        workspaceFolderId,
        query: '😀'.repeat(V02_READ_TOOL_LIMITS.searchWorkspaceText.queryScalarsMax),
      }).success,
    ).toBe(true);
    expect(
      V02SearchWorkspaceTextInputSchema.safeParse({
        workspaceFolderId,
        query: ' padded ',
      }).success,
    ).toBe(true);
    for (const query of [
      '',
      'contains\0nul',
      'a'.repeat(V02_READ_TOOL_LIMITS.searchWorkspaceText.queryScalarsMax + 1),
    ]) {
      expect(
        V02SearchWorkspaceTextInputSchema.safeParse({ workspaceFolderId, query })
          .success,
      ).toBe(false);
    }
  });

  it('keeps IPC invocations separate from MCP instance selection', () => {
    expect(
      V02ReadToolInvocationSchema.safeParse({
        tool: 'list_workspace_files',
        arguments: { workspaceFolderId },
      }).success,
    ).toBe(true);
    expect(
      V02ReadToolInvocationSchema.safeParse({
        tool: 'list_workspace_files',
        arguments: { instanceId, workspaceFolderId },
      }).success,
    ).toBe(false);
  });
});

describe('v0.2 read results', () => {
  it('enforces canonical warnings and v0.2 failures', () => {
    expect(
      V02WarningsSchema.safeParse([
        { code: 'RESULTS_TRUNCATED', message: 'bounded' },
        { code: 'RESOURCE_LIMIT_REACHED', message: 'resource bounded' },
      ]).success,
    ).toBe(true);
    expect(
      V02WarningsSchema.safeParse([
        { code: 'RESOURCE_LIMIT_REACHED', message: 'resource bounded' },
        { code: 'RESULTS_TRUNCATED', message: 'bounded' },
      ]).success,
    ).toBe(false);
    expect(
      V02WarningSchema.safeParse({ code: 'SHELL_OUTPUT', message: 'nope' }).success,
    ).toBe(false);
    expect(
      V02FailureSchema.safeParse({
        contractVersion: V02_TOOL_CONTRACT_VERSION,
        error: { code: 'INVALID_CURSOR', message: 'Invalid cursor.', retryable: false },
      }).success,
    ).toBe(true);
  });

  it('enforces ordered unique file pages and cursor invariants', () => {
    expect(
      V02ListWorkspaceFilesResultSchema.safeParse({
        workspaceFolderId,
        files: ['a.ts', 'src/index.ts', '😀.ts'],
        hasMore: true,
        nextCursor: 'abc.def',
      }).success,
    ).toBe(true);
    for (const files of [
      ['src/index.ts', 'a.ts'],
      ['a.ts', 'a.ts'],
    ]) {
      expect(
        V02ListWorkspaceFilesResultSchema.safeParse({
          workspaceFolderId,
          files,
          hasMore: false,
          nextCursor: null,
        }).success,
      ).toBe(false);
    }
    expect(
      V02ListWorkspaceFilesResultSchema.safeParse({
        workspaceFolderId,
        files: [],
        hasMore: true,
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('enforces batch aggregate text and pagination invariants', () => {
    const half = 'a'.repeat(V02_READ_TOOL_LIMITS.readDocuments.contentBytesMax / 2);
    expect(
      V02ReadDocumentsResultSchema.safeParse({
        workspaceFolderId,
        items: [successItem(half), successItem(half)],
      }).success,
    ).toBe(true);
    expect(
      V02ReadDocumentsResultSchema.safeParse({
        workspaceFolderId,
        items: [successItem(half), successItem(`${half}a`)],
      }).success,
    ).toBe(false);
    expect(
      V02ReadDocumentsResultSchema.safeParse({
        workspaceFolderId,
        items: [{ ...successItem(), hasMore: true, nextStartLine: null }],
      }).success,
    ).toBe(false);
  });

  it('requires explicit top-level truncation for batch budget exhaustion', () => {
    const result = {
      workspaceFolderId,
      items: [
        {
          outcome: 'error' as const,
          error: {
            code: 'BATCH_BUDGET_EXHAUSTED' as const,
            message: 'Batch budget exhausted.',
            retryable: true,
          },
        },
      ],
    };
    expect(
      V02ReadDocumentsSuccessSchema.safeParse(successEnvelope(result)).success,
    ).toBe(false);
    expect(
      V02ReadDocumentsSuccessSchema.safeParse({
        ...successEnvelope(result),
        truncated: true,
        warnings: [
          { code: 'RESOURCE_LIMIT_REACHED', message: 'Batch budget exhausted.' },
        ],
      }).success,
    ).toBe(true);
  });

  it('enforces grouped search counts, ordering, state, and cursor invariants', () => {
    const searchResult = {
      workspaceFolderId,
      query: 'needle',
      documents: [
        {
          document: { workspaceFolderId, relativePath: 'src/index.ts' },
          state: { source: 'live' as const, documentVersion: 2, isDirty: true },
          matches: [{ range, context: null }],
        },
      ],
      returnedMatchCount: 1,
      hasMore: false,
      nextCursor: null,
    };
    expect(V02SearchWorkspaceTextResultSchema.safeParse(searchResult).success).toBe(
      true,
    );
    expect(
      V02SearchWorkspaceTextResultSchema.safeParse({
        ...searchResult,
        returnedMatchCount: 0,
      }).success,
    ).toBe(false);
    expect(
      V02SearchWorkspaceTextResultSchema.safeParse({
        ...searchResult,
        hasMore: true,
      }).success,
    ).toBe(false);
    expect(
      V02SearchWorkspaceTextResultSchema.safeParse({
        ...searchResult,
        documents: [
          {
            document: { workspaceFolderId, relativePath: 'src/index.ts' },
            state: {
              source: 'disk',
              sizeBytes: V02_READ_TOOL_LIMITS.searchWorkspaceText.closedFileBytes + 1,
              modifiedAt: '2026-07-11T00:00:00.000Z',
            },
            matches: [{ range, context: null }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('enforces aggregate search context bytes', () => {
    const contextText = 'a'.repeat(
      V02_READ_TOOL_LIMITS.searchWorkspaceText.contextSnippetBytes,
    );
    const match = {
      range,
      context: { range, text: contextText, highlightRange: range },
    };
    const result = (count: number) => ({
      workspaceFolderId,
      query: 'needle',
      documents: [
        {
          document: { workspaceFolderId, relativePath: 'src/index.ts' },
          state: { source: 'live' as const, documentVersion: 1, isDirty: false },
          matches: Array.from({ length: count }, (_, index) => ({
            ...match,
            range: {
              start: { line: index, character: 0 },
              end: { line: index, character: 1 },
            },
          })),
        },
      ],
      returnedMatchCount: count,
      hasMore: false,
      nextCursor: null,
    });
    const exact =
      V02_READ_TOOL_LIMITS.searchWorkspaceText.aggregateContextBytes /
      V02_READ_TOOL_LIMITS.searchWorkspaceText.contextSnippetBytes;
    expect(V02SearchWorkspaceTextResultSchema.safeParse(result(exact)).success).toBe(
      true,
    );
    expect(
      V02SearchWorkspaceTextResultSchema.safeParse(result(exact + 1)).success,
    ).toBe(false);
  });

  it('enforces the complete 448 KiB serialized success ceiling', () => {
    const schema = createV02SuccessSchema(z.object({ blob: z.string() }).strict());
    expect(
      schema.safeParse(
        successEnvelope({
          blob: 'a'.repeat(V02_READ_TOOL_LIMITS.serializedResultBytes),
        }),
      ).success,
    ).toBe(false);
  });
});
