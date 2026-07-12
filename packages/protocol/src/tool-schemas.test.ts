import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';
import type * as z from 'zod/v4';

import { TOOL_CONTRACT_VERSION, TOOL_LIMITS } from './constants.js';
import {
  AllToolNameSchema,
  ExtensionToolInvocationSchema,
  ExtensionToolNameSchema,
  ExtensionToolResultPayloadSchema,
  FindReferencesInputSchema,
  GetCallHierarchyResultSchema,
  GetCallHierarchyInputSchema,
  GetDefinitionInputSchema,
  GetDiagnosticsInputSchema,
  GetDiagnosticsResultSchema,
  GetDocumentSymbolsInputSchema,
  GetEditorContextInputSchema,
  GetHoverInputSchema,
  GetHoverResultSchema,
  GetSignatureHelpInputSchema,
  GetSignatureHelpResultSchema,
  ListInstancesInputSchema,
  ReadDocumentInputSchema,
  ReadDocumentResultSchema,
  SearchWorkspaceSymbolsInputSchema,
  SearchWorkspaceSymbolsResultSchema,
  WarningSchema,
  createSuccessSchema,
} from './tool-schemas.js';

const instanceId = 'a12f0291-37e2-4ff6-b763-0abf3fe66714';
const document = {
  kind: 'workspacePath' as const,
  workspaceFolderId: 'root',
  relativePath: 'src/index.ts',
};
const position = { line: 0, character: 0 };

const snapshot = {
  uri: 'file:///workspace/src/index.ts',
  workspaceFolderId: 'root',
  relativePath: 'src/index.ts',
  languageId: 'typescript',
  documentVersion: 1,
  isDirty: false,
};

describe('v0.1 tool names', () => {
  it('contains all eleven public tools but only ten extension tools', () => {
    expect(AllToolNameSchema.options).toHaveLength(11);
    expect(ExtensionToolNameSchema.options).toHaveLength(10);
    expect(AllToolNameSchema.parse('list_instances')).toBe('list_instances');
    expect(() => ExtensionToolNameSchema.parse('list_instances')).toThrow();
  });
});

describe('v0.1 tool inputs', () => {
  const validInputs: ReadonlyArray<readonly [z.ZodType, Record<string, unknown>]> = [
    [ListInstancesInputSchema, {}],
    [GetEditorContextInputSchema, { instanceId, documentLimit: 100, tabLimit: 100 }],
    [ReadDocumentInputSchema, { instanceId, document, startLine: 0, lineCount: 500 }],
    [GetDiagnosticsInputSchema, { instanceId, document, limit: 500 }],
    [GetHoverInputSchema, { instanceId, document, position }],
    [GetDefinitionInputSchema, { instanceId, document, position, kind: 'definition' }],
    [FindReferencesInputSchema, { instanceId, document, position, contextLines: 2 }],
    [GetDocumentSymbolsInputSchema, { instanceId, document, limit: 500 }],
    [SearchWorkspaceSymbolsInputSchema, { instanceId, query: 'Widget', limit: 100 }],
    [
      GetSignatureHelpInputSchema,
      { instanceId, document, position, triggerCharacter: '(' },
    ],
    [
      GetCallHierarchyInputSchema,
      { instanceId, document, position, direction: 'both' },
    ],
  ];

  it('accepts the documented minimal shapes for all eleven tools', () => {
    for (const [schema, value] of validInputs) {
      expect(schema.safeParse(value).success).toBe(true);
    }
  });

  it('rejects unknown keys for every tool input', () => {
    for (const [schema, value] of validInputs) {
      expect(
        schema.safeParse({ ...value, executeCommand: 'workbench.action.closeWindow' })
          .success,
      ).toBe(false);
    }
  });

  it('requires a document when a diagnostic version is supplied', () => {
    expect(
      GetDiagnosticsInputSchema.safeParse({ expectedDocumentVersion: 2 }).success,
    ).toBe(false);
  });

  it('enforces Unicode query and trigger-character rules', () => {
    expect(
      SearchWorkspaceSymbolsInputSchema.safeParse({ query: ' padded ' }).success,
    ).toBe(false);
    expect(
      SearchWorkspaceSymbolsInputSchema.safeParse({ query: '😀'.repeat(256) }).success,
    ).toBe(true);
    expect(
      SearchWorkspaceSymbolsInputSchema.safeParse({ query: 'a'.repeat(257) }).success,
    ).toBe(false);
    expect(
      GetSignatureHelpInputSchema.safeParse({
        document,
        position,
        triggerCharacter: 'ab',
      }).success,
    ).toBe(false);
  });
});

describe('success and bounded raw results', () => {
  it('builds a strict versioned success envelope', () => {
    const schema = createSuccessSchema(SearchWorkspaceSymbolsResultSchema);
    const value = {
      contractVersion: TOOL_CONTRACT_VERSION,
      instanceId,
      observedAt: '2026-07-10T12:00:00.000Z',
      truncated: false,
      warnings: [],
      result: { query: 'Widget', symbols: [] },
    };

    expect(schema.parse(value)).toEqual(value);
    expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
  });

  it('keeps warning codes closed and strict', () => {
    expect(
      WarningSchema.parse({
        code: 'RESULTS_TRUNCATED',
        message: 'Result was bounded.',
      }),
    ).toBeDefined();
    expect(
      WarningSchema.safeParse({ code: 'SHELL_OUTPUT', message: 'nope' }).success,
    ).toBe(false);
    expect(
      WarningSchema.safeParse({
        code: 'RESULTS_TRUNCATED',
        message: 'bounded',
        omittedCount: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    expect(
      WarningSchema.safeParse({
        code: 'RESULTS_TRUNCATED',
        message: 'bounded',
        omittedCount: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it('enforces the document chunk byte cap and pagination invariant', () => {
    const base = {
      document: snapshot,
      eol: 'LF' as const,
      totalLineCount: 1,
      returnedRange: { start: position, end: position },
      hasMore: false,
      nextStartLine: null,
    };

    const atLimit = 'a'.repeat(256 * 1024);
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(256 * 1024);
    expect(ReadDocumentResultSchema.safeParse({ ...base, text: atLimit }).success).toBe(
      true,
    );
    expect(
      ReadDocumentResultSchema.safeParse({ ...base, text: `${atLimit}a` }).success,
    ).toBe(false);
    expect(
      ReadDocumentResultSchema.safeParse({
        ...base,
        text: '',
        hasMore: true,
        nextStartLine: null,
      }).success,
    ).toBe(false);
  });

  it('enforces collection hard limits', () => {
    const symbol = {
      name: 'Widget',
      kind: 'Class',
      containerName: null,
      uri: snapshot.uri,
      range: { start: position, end: position },
    };

    expect(
      SearchWorkspaceSymbolsResultSchema.safeParse({
        query: 'Widget',
        symbols: Array.from({ length: 501 }, () => symbol),
      }).success,
    ).toBe(false);
  });

  it('enforces exact and cap-plus-one diagnostic document limits', () => {
    const documentResult = { document: snapshot, diagnostics: [] };
    const base = {
      coverage: 'open_documents' as const,
      freshness: {
        state: 'settled' as const,
        heuristic: true as const,
        quietPeriodMs: TOOL_LIMITS.diagnostics.quietPeriodMs,
        waitedMs: 0,
        lastChangeAt: null,
      },
    };

    expect(
      GetDiagnosticsResultSchema.safeParse({
        ...base,
        documents: Array.from(
          { length: TOOL_LIMITS.diagnostics.documentsMax },
          () => documentResult,
        ),
      }).success,
    ).toBe(true);
    expect(
      GetDiagnosticsResultSchema.safeParse({
        ...base,
        documents: Array.from(
          { length: TOOL_LIMITS.diagnostics.documentsMax + 1 },
          () => documentResult,
        ),
      }).success,
    ).toBe(false);
  });

  it('enforces per-item and request-wide diagnostic related-information limits', () => {
    const relatedInformation = {
      uri: snapshot.uri,
      range: { start: position, end: position },
      message: 'related',
    };
    const diagnostic = {
      range: { start: position, end: position },
      severity: 'warning' as const,
      message: 'diagnostic',
      source: null,
      code: null,
      tags: [],
      relatedInformation: Array.from(
        { length: TOOL_LIMITS.diagnostics.relatedInformationPerItemMax },
        () => relatedInformation,
      ),
    };
    const base = {
      coverage: 'requested_document' as const,
      freshness: {
        state: 'settled' as const,
        heuristic: true as const,
        quietPeriodMs: TOOL_LIMITS.diagnostics.quietPeriodMs,
        waitedMs: 0,
        lastChangeAt: null,
      },
    };

    expect(
      GetDiagnosticsResultSchema.safeParse({
        ...base,
        documents: [{ document: snapshot, diagnostics: [diagnostic] }],
      }).success,
    ).toBe(true);
    expect(
      GetDiagnosticsResultSchema.safeParse({
        ...base,
        documents: [
          {
            document: snapshot,
            diagnostics: [
              {
                ...diagnostic,
                relatedInformation: [
                  ...diagnostic.relatedInformation,
                  relatedInformation,
                ],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);

    const exactRequestDiagnostics = Array.from({ length: 63 }, (_, index) => ({
      ...diagnostic,
      relatedInformation: Array.from(
        {
          length:
            index === 62 ? 16 : TOOL_LIMITS.diagnostics.relatedInformationPerItemMax,
        },
        () => relatedInformation,
      ),
    }));
    expect(
      GetDiagnosticsResultSchema.safeParse({
        ...base,
        documents: [{ document: snapshot, diagnostics: exactRequestDiagnostics }],
      }).success,
    ).toBe(true);
    exactRequestDiagnostics[62]?.relatedInformation.push(relatedInformation);
    expect(
      GetDiagnosticsResultSchema.safeParse({
        ...base,
        documents: [{ document: snapshot, diagnostics: exactRequestDiagnostics }],
      }).success,
    ).toBe(false);
  });

  it('enforces per-entry and request-wide hover-content limits', () => {
    const content = { kind: 'plaintext' as const, value: 'hover' };
    const hover = {
      range: null,
      contents: Array.from(
        { length: TOOL_LIMITS.hover.contentsPerEntryMax },
        () => content,
      ),
    };
    const base = { document: snapshot };

    expect(GetHoverResultSchema.safeParse({ ...base, hovers: [hover] }).success).toBe(
      true,
    );
    expect(
      GetHoverResultSchema.safeParse({
        ...base,
        hovers: [{ ...hover, contents: [...hover.contents, content] }],
      }).success,
    ).toBe(false);
    const exactRequest = Array.from(
      {
        length:
          TOOL_LIMITS.hover.contentsPerRequestMax /
          TOOL_LIMITS.hover.contentsPerEntryMax,
      },
      () => hover,
    );
    expect(
      GetHoverResultSchema.safeParse({ ...base, hovers: exactRequest }).success,
    ).toBe(true);
    expect(
      GetHoverResultSchema.safeParse({
        ...base,
        hovers: [...exactRequest, { range: null, contents: [content] }],
      }).success,
    ).toBe(false);
  });

  it('enforces signature-parameter and call-site range nested limits', () => {
    const parameter = {
      label: null,
      labelRange: null,
      documentation: null,
    };
    const signature = {
      label: 'fn()',
      documentation: null,
      parameters: Array.from(
        { length: TOOL_LIMITS.signatureHelp.parametersPerSignatureMax },
        () => parameter,
      ),
    };
    expect(
      GetSignatureHelpResultSchema.safeParse({
        document: snapshot,
        activeSignature: null,
        activeParameter: null,
        signatures: [signature],
      }).success,
    ).toBe(true);
    expect(
      GetSignatureHelpResultSchema.safeParse({
        document: snapshot,
        activeSignature: null,
        activeParameter: null,
        signatures: [
          { ...signature, parameters: [...signature.parameters, parameter] },
        ],
      }).success,
    ).toBe(false);

    const callItem = {
      name: 'fn',
      detail: null,
      kind: 'Function',
      uri: snapshot.uri,
      range: { start: position, end: position },
      selectionRange: { start: position, end: position },
    };
    const call = {
      from: callItem,
      callSiteRanges: Array.from(
        { length: TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax },
        () => ({ start: position, end: position }),
      ),
    };
    const hierarchyBase = {
      document: snapshot,
      roots: [callItem],
      selectedRootIndex: 0,
      outgoing: null,
    };
    expect(
      GetCallHierarchyResultSchema.safeParse({
        ...hierarchyBase,
        incoming: [call],
      }).success,
    ).toBe(true);
    expect(
      GetCallHierarchyResultSchema.safeParse({
        ...hierarchyBase,
        incoming: [
          {
            ...call,
            callSiteRanges: [
              ...call.callSiteRanges,
              { start: position, end: position },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    const exactDirection = Array.from(
      {
        length:
          TOOL_LIMITS.callHierarchy.callSiteRangesPerDirectionMax /
          TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax,
      },
      () => call,
    );
    expect(
      GetCallHierarchyResultSchema.safeParse({
        ...hierarchyBase,
        incoming: exactDirection,
      }).success,
    ).toBe(true);
    expect(
      GetCallHierarchyResultSchema.safeParse({
        ...hierarchyBase,
        incoming: [
          ...exactDirection,
          { from: callItem, callSiteRanges: [{ start: position, end: position }] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('extension IPC payload unions', () => {
  it('accepts an extension invocation without an instance selector', () => {
    expect(
      ExtensionToolInvocationSchema.parse({
        tool: 'get_hover',
        arguments: { document, position },
      }),
    ).toBeDefined();
  });

  it('rejects list_instances and instance redirection', () => {
    expect(
      ExtensionToolInvocationSchema.safeParse({ tool: 'list_instances', arguments: {} })
        .success,
    ).toBe(false);
    expect(
      ExtensionToolInvocationSchema.safeParse({
        tool: 'get_hover',
        arguments: { instanceId, document, position },
      }).success,
    ).toBe(false);
  });

  it('ties each result payload to its discriminating tool', () => {
    expect(
      ExtensionToolResultPayloadSchema.safeParse({
        tool: 'search_workspace_symbols',
        result: { query: 'Widget', symbols: [] },
      }).success,
    ).toBe(true);
    expect(
      ExtensionToolResultPayloadSchema.safeParse({
        tool: 'read_document',
        result: { query: 'Widget', symbols: [] },
      }).success,
    ).toBe(false);
  });
});
