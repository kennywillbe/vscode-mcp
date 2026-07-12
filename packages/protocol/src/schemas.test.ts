import { describe, expect, it } from 'vitest';

import {
  DocumentRefSchema,
  ErrorCodeSchema,
  FailureSchema,
  FileUriSchema,
  InstanceDescriptorSchema,
  PositionSchema,
} from './schemas.js';

describe('shared protocol schemas', () => {
  it('accepts a zero-based position', () => {
    expect(PositionSchema.parse({ line: 0, character: 0 })).toEqual({
      line: 0,
      character: 0,
    });
  });

  it('rejects workspace traversal', () => {
    for (const relativePath of [
      '../secret.txt',
      'src/../secret.txt',
      'C:/secret.txt',
      'C:secret.txt',
      './secret.txt',
      'src//secret.txt',
      'src\\secret.txt',
      'secret.txt\0ignored',
    ]) {
      expect(() =>
        DocumentRefSchema.parse({
          kind: 'workspacePath',
          workspaceFolderId: 'root',
          relativePath,
        }),
      ).toThrow();
    }
  });

  it('distinguishes file URIs from other URL schemes', () => {
    expect(FileUriSchema.parse('file:///workspace/index.ts')).toBe(
      'file:///workspace/index.ts',
    );
    expect(() => FileUriSchema.parse('https://example.com/index.ts')).toThrow();
  });

  it('accepts only safe authenticated instance metadata', () => {
    const instance = {
      instanceId: '00000000-0000-4000-8000-000000000000',
      displayName: 'fixture',
      trusted: true,
      publishedAt: '2026-07-10T00:00:00.000Z',
      workspaceFileUri: null,
      workspaceFolders: [
        {
          workspaceFolderId: 'root',
          name: 'fixture',
          uri: 'file:///workspace',
        },
      ],
      protocolVersion: 1,
      toolContractVersion: '1.0.0',
    };

    expect(InstanceDescriptorSchema.parse(instance)).toEqual(instance);
    expect(() =>
      InstanceDescriptorSchema.parse({ ...instance, trusted: false }),
    ).toThrow();
  });

  it('keeps runtime errors on the documented stable list', () => {
    expect(ErrorCodeSchema.parse('DOCUMENT_VERSION_MISMATCH')).toBe(
      'DOCUMENT_VERSION_MISMATCH',
    );
    expect(() => ErrorCodeSchema.parse('ARBITRARY_COMMAND_FAILED')).toThrow();
  });

  it('keeps failure details shallow and bounded', () => {
    expect(
      FailureSchema.parse({
        contractVersion: '1.0.0',
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'The supplied version is invalid.',
          retryable: false,
          details: { expected: 1, actual: 2 },
        },
      }).error.details,
    ).toEqual({ expected: 1, actual: 2 });

    expect(() =>
      FailureSchema.parse({
        contractVersion: '1.0.0',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Nested data is not allowed.',
          retryable: false,
          details: { nested: { secret: true } },
        },
      }),
    ).toThrow();
  });
});
