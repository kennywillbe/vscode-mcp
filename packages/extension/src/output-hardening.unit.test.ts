import { Buffer } from 'node:buffer';

import {
  PROTOCOL_LIMITS,
  SCHEMA_LIMITS,
  TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import {
  IpcCallToolResultSchema,
  IpcToolSuccessSchema,
  type IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas';
import type {
  ExtensionToolResultPayload,
  GetDiagnosticsResult,
} from '@vscode-mcp/protocol/tool-schemas';
import { describe, expect, it } from 'vitest';

import {
  EXTENSION_SUCCESS_BUDGET_BYTES,
  hardenIpcToolSuccess,
} from './output-hardening.js';

const OBSERVED_AT = '2026-07-10T00:00:00.000Z';

describe('serialized extension output hardening', () => {
  it('keeps a conservative budget below the public MCP result ceiling', () => {
    expect(EXTENSION_SUCCESS_BUDGET_BYTES).toBeLessThan(PROTOCOL_LIMITS.mcpResultBytes);
  });

  it('supports all ten strict extension result variants without changing small results', () => {
    for (const payload of minimalPayloads()) {
      const input = success(payload);
      const hardened = hardenIpcToolSuccess(input);

      expect(hardened).toEqual(input);
      expect(IpcCallToolResultSchema.safeParse(hardened).success).toBe(true);
      expect(hardened.outcome).toBe('success');
      if (hardened.outcome === 'success') {
        expect(hardened.payload.tool).toBe(payload.tool);
      }
    }
  });

  it('drops reference contexts before locations and merges the canonical warning', () => {
    const references = Array.from({ length: 180 }, (_, index) => ({
      uri: `file:///workspace/reference-${index}.ts`,
      range: range(index, 0, index, 1),
      context: {
        range: range(index, 0, index, 1),
        text: 'x'.repeat(4_096),
        highlightRange: range(index, 0, index, 1),
        documentVersion: 1,
        isDirty: false,
      },
    }));
    const input = success(
      {
        tool: 'find_references',
        result: { document: document(), references },
      },
      {
        truncated: true,
        warnings: [
          {
            code: 'RESULTS_TRUNCATED',
            message: 'Earlier provider limit.',
            omittedCount: 2,
          },
          {
            code: 'CONTENT_TRUNCATED',
            message: 'Earlier content limit.',
          },
        ],
      },
    );

    const hardened = hardenIpcToolSuccess(input);

    expect(hardened.outcome).toBe('success');
    if (hardened.outcome !== 'success') {
      return;
    }
    expect(hardened.payload.tool).toBe('find_references');
    if (hardened.payload.tool !== 'find_references') {
      return;
    }
    expect(hardened.payload.result.references).toHaveLength(references.length);
    expect(
      hardened.payload.result.references.every(
        (reference) => reference.context === null,
      ),
    ).toBe(true);
    expect(hardened.warnings.map((warning) => warning.code)).toEqual([
      'RESULTS_TRUNCATED',
      'CONTENT_TRUNCATED',
    ]);
    expect(hardened.warnings[0]).toMatchObject({ omittedCount: 182 });
    expect(hardened.truncated).toBe(true);
    expect(serializedBytes(hardened)).toBeLessThanOrEqual(
      EXTENSION_SUCCESS_BUDGET_BYTES,
    );
  });

  it('drops diagnostic related information before tail diagnostics', () => {
    const diagnostics = Array.from({ length: 40 }, (_, index) => ({
      range: range(index, 0, index, 1),
      severity: 'warning' as const,
      message: `diagnostic-${index}`,
      source: null,
      code: null,
      tags: [],
      relatedInformation: [
        {
          uri: `file:///workspace/related-${index}.ts`,
          range: range(index, 0, index, 1),
          message: 'r'.repeat(16_384),
        },
      ],
    }));
    const input = success({
      tool: 'get_diagnostics',
      result: diagnosticsResult(diagnostics),
    });

    const hardened = hardenIpcToolSuccess(input);

    expect(hardened.outcome).toBe('success');
    if (hardened.outcome !== 'success' || hardened.payload.tool !== 'get_diagnostics') {
      return;
    }
    expect(hardened.payload.result.documents[0]?.diagnostics).toHaveLength(40);
    expect(
      hardened.payload.result.documents[0]?.diagnostics.every(
        (diagnostic) => diagnostic.relatedInformation.length === 0,
      ),
    ).toBe(true);
    expect(hardened.warnings[0]).toMatchObject({
      code: 'RESULTS_TRUNCATED',
      omittedCount: 40,
    });
  });

  it('drops call-site ranges before tail calls', () => {
    const heavyCaller = {
      ...callItem('caller'),
      name: 'n'.repeat(SCHEMA_LIMITS.displayNameCharacters),
      detail: 'd'.repeat(SCHEMA_LIMITS.detailTextCharacters),
      kind: 'k'.repeat(SCHEMA_LIMITS.symbolKindCharacters),
      uri: `file:///workspace/${'u'.repeat(16_000)}`,
    };
    const incoming = Array.from({ length: 20 }, (_, callIndex) => ({
      from: heavyCaller,
      callSiteRanges: Array.from({ length: 50 }, (_, rangeIndex) =>
        range(callIndex, rangeIndex, callIndex, rangeIndex + 1),
      ),
    }));
    const input = success({
      tool: 'get_call_hierarchy',
      result: {
        document: document(),
        roots: [callItem('root')],
        selectedRootIndex: 0,
        incoming,
        outgoing: [],
      },
    });

    const hardened = hardenIpcToolSuccess(input);

    expect(hardened.outcome).toBe('success');
    if (
      hardened.outcome !== 'success' ||
      hardened.payload.tool !== 'get_call_hierarchy'
    ) {
      return;
    }
    expect(hardened.payload.result.incoming?.length).toBeLessThan(incoming.length);
    expect(
      hardened.payload.result.incoming?.every(
        (call) => call.callSiteRanges.length === 0,
      ),
    ).toBe(true);
    expect(hardened.warnings[0]?.code).toBe('RESULTS_TRUNCATED');
    expect(hardened.warnings[0]?.omittedCount).toBeGreaterThanOrEqual(
      TOOL_LIMITS.callHierarchy.callSiteRangesPerDirectionMax,
    );
  });

  it('removes deterministic collection tails for editors, locations, and symbols', () => {
    const editorInput = success({
      tool: 'get_editor_context',
      result: {
        activeEditor: null,
        visibleEditors: [],
        openDocuments: Array.from({ length: 100 }, (_, index) =>
          document(`${index}-${'d'.repeat(3_900)}`),
        ),
        tabs: [],
        omitted: { editors: 0, documents: 0, tabs: 0 },
      },
    });
    const definitionInput = success({
      tool: 'get_definition',
      result: {
        document: document(),
        kind: 'definition',
        locations: Array.from({ length: 100 }, (_, index) => ({
          uri: longFileUri(index),
          targetRange: range(index, 0, index, 1),
          targetSelectionRange: range(index, 0, index, 1),
          originSelectionRange: null,
        })),
      },
    });
    const documentSymbolsInput = success({
      tool: 'get_document_symbols',
      result: {
        document: document(),
        providerShape: 'flat',
        providerReportedNestedSymbols: false,
        symbols: Array.from({ length: 100 }, (_, index) => ({
          id: `s${index}`,
          parentId: null,
          name: `symbol-${index}`,
          detail: 'd'.repeat(8_000),
          kind: 'function',
          range: range(index, 0, index, 1),
          selectionRange: range(index, 0, index, 1),
          deprecated: false,
          containerName: null,
        })),
      },
    });
    const workspaceSymbolsInput = success({
      tool: 'search_workspace_symbols',
      result: {
        query: 'symbol',
        symbols: Array.from({ length: 100 }, (_, index) => ({
          name: `symbol-${index}`,
          kind: 'function',
          containerName: null,
          uri: longFileUri(index),
          range: range(index, 0, index, 1),
        })),
      },
    });

    const editor = hardenIpcToolSuccess(editorInput);
    const definition = hardenIpcToolSuccess(definitionInput);
    const documentSymbols = hardenIpcToolSuccess(documentSymbolsInput);
    const workspaceSymbols = hardenIpcToolSuccess(workspaceSymbolsInput);

    expect(editor.outcome).toBe('success');
    if (editor.outcome === 'success' && editor.payload.tool === 'get_editor_context') {
      expect(editor.payload.result.openDocuments.length).toBeLessThan(100);
      expect(editor.payload.result.omitted.documents).toBe(
        100 - editor.payload.result.openDocuments.length,
      );
    }
    expect(definition.outcome).toBe('success');
    if (
      definition.outcome === 'success' &&
      definition.payload.tool === 'get_definition'
    ) {
      expect(definition.payload.result.locations.length).toBeLessThan(100);
    }
    expect(documentSymbols.outcome).toBe('success');
    if (
      documentSymbols.outcome === 'success' &&
      documentSymbols.payload.tool === 'get_document_symbols'
    ) {
      expect(documentSymbols.payload.result.symbols.length).toBeLessThan(100);
    }
    expect(workspaceSymbols.outcome).toBe('success');
    if (
      workspaceSymbols.outcome === 'success' &&
      workspaceSymbols.payload.tool === 'search_workspace_symbols'
    ) {
      expect(workspaceSymbols.payload.result.symbols.length).toBeLessThan(100);
    }
    for (const result of [editor, definition, documentSymbols, workspaceSymbols]) {
      expect(IpcCallToolResultSchema.safeParse(result).success).toBe(true);
      expect(serializedBytes(result)).toBeLessThanOrEqual(
        EXTENSION_SUCCESS_BUDGET_BYTES,
      );
    }
  });

  it('accepts the schema-maximum hover structure when combined text is small', () => {
    const hovers = Array.from({ length: TOOL_LIMITS.hover.entriesMax }, (_, index) => ({
      range: null,
      contents: Array.from(
        {
          length: index < 16 ? 13 : 12,
        },
        () => ({
          kind: 'plaintext' as const,
          value: '',
        }),
      ),
    }));
    const input = success({
      tool: 'get_hover',
      result: {
        document: document(),
        hovers,
      },
    });

    const hardened = hardenIpcToolSuccess(input);

    expect(hardened.outcome).toBe('success');
    expect(hardened).toEqual(input);
    expect(serializedBytes(hardened)).toBeLessThanOrEqual(
      EXTENSION_SUCCESS_BUDGET_BYTES,
    );
  });

  it('accepts an exact 512 KiB success and truncates the same shape at plus one byte', () => {
    const exact = diagnosticsSizedTo(PROTOCOL_LIMITS.mcpResultBytes);
    const plusOne = diagnosticsSizedTo(PROTOCOL_LIMITS.mcpResultBytes + 1);

    expect(serializedBytes(exact)).toBe(PROTOCOL_LIMITS.mcpResultBytes);
    expect(serializedBytes(plusOne)).toBe(PROTOCOL_LIMITS.mcpResultBytes + 1);

    const exactResult = hardenIpcToolSuccess(exact, PROTOCOL_LIMITS.mcpResultBytes);
    const reducedResult = hardenIpcToolSuccess(plusOne, PROTOCOL_LIMITS.mcpResultBytes);

    expect(exactResult).toEqual(exact);
    expect(reducedResult.outcome).toBe('success');
    if (reducedResult.outcome === 'success') {
      expect(reducedResult.truncated).toBe(true);
      expect(reducedResult.warnings[0]?.code).toBe('RESULTS_TRUNCATED');
    }
    expect(serializedBytes(reducedResult)).toBeLessThanOrEqual(
      PROTOCOL_LIMITS.mcpResultBytes,
    );
  });

  it('returns a bounded, correctly tagged INTERNAL_ERROR only when no valid minimum fits', () => {
    const input = success({
      tool: 'read_document',
      result: {
        document: document(),
        eol: 'LF',
        totalLineCount: 1,
        returnedRange: range(0, 0, 0, 1),
        text: 'x',
        hasMore: false,
        nextStartLine: null,
      },
    });

    const hardened = hardenIpcToolSuccess(input, 1);

    expect(hardened).toMatchObject({
      outcome: 'toolError',
      tool: 'read_document',
      error: { code: 'INTERNAL_ERROR', retryable: false },
    });
    expect(IpcCallToolResultSchema.safeParse(hardened).success).toBe(true);
  });
});

function minimalPayloads(): ExtensionToolResultPayload[] {
  return [
    {
      tool: 'get_editor_context',
      result: {
        activeEditor: null,
        visibleEditors: [],
        openDocuments: [],
        tabs: [],
        omitted: { editors: 0, documents: 0, tabs: 0 },
      },
    },
    {
      tool: 'read_document',
      result: {
        document: document(),
        eol: 'LF',
        totalLineCount: 1,
        returnedRange: range(0, 0, 0, 0),
        text: '',
        hasMore: false,
        nextStartLine: null,
      },
    },
    { tool: 'get_diagnostics', result: diagnosticsResult([]) },
    { tool: 'get_hover', result: { document: document(), hovers: [] } },
    {
      tool: 'get_definition',
      result: { document: document(), kind: 'definition', locations: [] },
    },
    {
      tool: 'find_references',
      result: { document: document(), references: [] },
    },
    {
      tool: 'get_document_symbols',
      result: {
        document: document(),
        providerShape: 'flat',
        providerReportedNestedSymbols: false,
        symbols: [],
      },
    },
    {
      tool: 'search_workspace_symbols',
      result: { query: 'symbol', symbols: [] },
    },
    {
      tool: 'get_signature_help',
      result: {
        document: document(),
        activeSignature: null,
        activeParameter: null,
        signatures: [],
      },
    },
    {
      tool: 'get_call_hierarchy',
      result: {
        document: document(),
        roots: [],
        selectedRootIndex: 0,
        incoming: null,
        outgoing: null,
      },
    },
  ];
}

function success(
  payload: ExtensionToolResultPayload,
  metadata: {
    readonly truncated?: boolean;
    readonly warnings?: Extract<IpcCallToolResult, { outcome: 'success' }>['warnings'];
  } = {},
): Extract<IpcCallToolResult, { outcome: 'success' }> {
  return IpcToolSuccessSchema.parse({
    outcome: 'success',
    observedAt: OBSERVED_AT,
    truncated: metadata.truncated ?? false,
    warnings: metadata.warnings ?? [],
    payload,
  });
}

function diagnosticsResult(
  diagnostics: GetDiagnosticsResult['documents'][number]['diagnostics'],
): GetDiagnosticsResult {
  return {
    coverage: 'requested_document',
    freshness: {
      state: 'settled',
      heuristic: true,
      quietPeriodMs: 300,
      waitedMs: 300,
      lastChangeAt: OBSERVED_AT,
    },
    documents: [{ document: document(), diagnostics }],
  };
}

function diagnosticsSizedTo(
  targetBytes: number,
): Extract<IpcCallToolResult, { outcome: 'success' }> {
  const diagnostics = Array.from({ length: 32 }, (_, index) => ({
    range: range(index, 0, index, 1),
    severity: 'warning' as const,
    message: '',
    source: null,
    code: null,
    tags: [],
    relatedInformation: [],
  }));
  let value = success({
    tool: 'get_diagnostics',
    result: diagnosticsResult(diagnostics),
  });
  let remaining = targetBytes - serializedBytes(value);
  if (remaining < 0) {
    throw new Error('The target is smaller than the diagnostic envelope.');
  }

  for (const diagnostic of diagnostics) {
    const added = Math.min(16_384, remaining);
    diagnostic.message = 'm'.repeat(added);
    remaining -= added;
  }
  if (remaining !== 0) {
    throw new Error('The requested diagnostic payload size cannot be constructed.');
  }
  value = success({
    tool: 'get_diagnostics',
    result: diagnosticsResult(diagnostics),
  });
  return value;
}

function document(relativePath = 'file.ts') {
  return {
    uri: `file:///workspace/${relativePath}`,
    workspaceFolderId: 'root',
    relativePath,
    languageId: 'typescript',
    documentVersion: 1,
    isDirty: false,
  };
}

function longFileUri(index: number): string {
  return `file:///workspace/${index}-${'u'.repeat(8_000)}`;
}

function callItem(name: string) {
  return {
    name,
    detail: null,
    kind: 'function',
    uri: `file:///workspace/${name}.ts`,
    range: range(0, 0, 0, 1),
    selectionRange: range(0, 0, 0, 1),
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

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('The test value could not be serialized.');
  }
  return Buffer.byteLength(serialized, 'utf8');
}
