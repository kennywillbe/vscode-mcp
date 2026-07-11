import { describe, expect, it } from 'vitest';

import { V1_IDE_TOOL_LIMITS } from './constants.js';
import { V1CallToolResponseMessageSchema } from './ipc-schemas-v1.js';
import {
  V1AdditionalToolInputSchemas,
  V1AllExtensionToolInvocationSchema,
  V1_ALL_EXTENSION_TOOL_NAMES,
} from './tool-schemas-v1.js';

describe('1.0 complete IDE tool schemas', () => {
  it('defines the canonical 38 extension tools without duplicates', () => {
    expect(V1_ALL_EXTENSION_TOOL_NAMES).toHaveLength(38);
    expect(new Set(V1_ALL_EXTENSION_TOOL_NAMES).size).toBe(38);
    expect(V1_ALL_EXTENSION_TOOL_NAMES).toContain('search_workspace_text');
    expect(V1_ALL_EXTENSION_TOOL_NAMES).toContain('rename_symbol');
    expect(V1_ALL_EXTENSION_TOOL_NAMES).toContain('start_debugging');
  });

  it('accepts a bounded multi-document edit and rejects unknown fields', () => {
    const invocation = {
      tool: 'apply_text_edits',
      arguments: {
        documents: [
          {
            document: {
              kind: 'workspacePath',
              workspaceFolderId: 'root',
              relativePath: 'src/index.ts',
            },
            expectedDocumentVersion: 3,
            edits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
                newText: 'const value = 1;\n',
              },
            ],
          },
        ],
      },
    };
    expect(V1AllExtensionToolInvocationSchema.safeParse(invocation).success).toBe(true);
    expect(
      V1AllExtensionToolInvocationSchema.safeParse({
        ...invocation,
        arguments: { ...invocation.arguments, overwrite: true },
      }).success,
    ).toBe(false);
  });

  it('enforces replacement and create-file byte limits', () => {
    const tooLarge = 'x'.repeat(V1_IDE_TOOL_LIMITS.createdFileBytes + 1);
    expect(
      V1AdditionalToolInputSchemas.create_workspace_file.safeParse({
        destination: { workspaceFolderId: 'root', relativePath: 'large.txt' },
        content: tooLarge,
      }).success,
    ).toBe(false);
    expect(
      V1AdditionalToolInputSchemas.apply_text_edits.safeParse({
        documents: [
          {
            document: {
              kind: 'workspacePath',
              workspaceFolderId: 'root',
              relativePath: 'large.txt',
            },
            expectedDocumentVersion: 1,
            edits: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
                newText: 'x'.repeat(V1_IDE_TOOL_LIMITS.replacementBytesPerEdit + 1),
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('enforces document and aggregate edit ceilings at the schema boundary', () => {
    const document = (index: number, editCount = 1) => ({
      document: {
        kind: 'workspacePath' as const,
        workspaceFolderId: 'root',
        relativePath: `file-${String(index)}.ts`,
      },
      expectedDocumentVersion: 1,
      edits: Array.from({ length: editCount }, (_, editIndex) => ({
        range: {
          start: { line: editIndex, character: 0 },
          end: { line: editIndex, character: 0 },
        },
        newText: 'x',
      })),
    });
    const maximumDocuments = Array.from(
      { length: V1_IDE_TOOL_LIMITS.documentsPerWrite },
      (_, index) => document(index),
    );
    expect(
      V1AdditionalToolInputSchemas.apply_text_edits.safeParse({
        documents: maximumDocuments,
      }).success,
    ).toBe(true);
    expect(
      V1AdditionalToolInputSchemas.apply_text_edits.safeParse({
        documents: [...maximumDocuments, document(maximumDocuments.length)],
      }).success,
    ).toBe(false);
    expect(
      V1AdditionalToolInputSchemas.apply_text_edits.safeParse({
        documents: [document(0, V1_IDE_TOOL_LIMITS.editsPerDocument + 1)],
      }).success,
    ).toBe(false);
    expect(
      V1AdditionalToolInputSchemas.apply_text_edits.safeParse({
        documents: Array.from({ length: 5 }, (_, index) =>
          document(index, V1_IDE_TOOL_LIMITS.editsPerDocument),
        ),
      }).success,
    ).toBe(false);
  });

  it('validates an additive tool response on the active IPC envelope', () => {
    expect(
      V1CallToolResponseMessageSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          outcome: 'success',
          tool: 'get_capability_status',
          observedAt: '2026-07-11T00:00:00.000Z',
          truncated: false,
          warnings: [],
          result: { read: true, write: false, execution: false },
        },
      }).success,
    ).toBe(true);
  });
});
