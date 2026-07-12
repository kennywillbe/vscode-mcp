import { describe, expect, it } from 'vitest';

import { RegistryRecordSchema } from './registry-schemas.js';

const validRecord = {
  schemaVersion: 1,
  protocolVersion: 1,
  toolContractVersion: '1.0.0',
  instanceId: '00000000-0000-4000-8000-000000000000',
  extensionVersion: '0.0.0',
  pid: 42,
  publishedAt: '2026-07-10T00:00:00.000Z',
  heartbeatAt: '2026-07-10T00:00:05.000Z',
  endpoint: {
    kind: 'unix' as const,
    path: '/tmp/vscode-mcp/sockets/window-random.sock',
  },
  authToken: 'A'.repeat(43),
  displayName: 'fixture',
  workspaceFingerprint: 'a'.repeat(64),
  workspaceFileUri: null,
  workspaceFolders: [
    {
      workspaceFolderId: 'root',
      name: 'fixture',
      uri: 'file:///workspace',
      canonicalPath: '/workspace',
    },
  ],
};

describe('registry record schema', () => {
  it('accepts the strict v1 record', () => {
    expect(RegistryRecordSchema.parse(validRecord)).toEqual(validRecord);
  });

  it('parses a bounded future protocol version for explicit classification', () => {
    expect(
      RegistryRecordSchema.parse({ ...validRecord, protocolVersion: 2 })
        .protocolVersion,
    ).toBe(2);
  });

  it('requires an exact unpadded 256-bit base64url token', () => {
    for (const authToken of [
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      'A+/',
    ]) {
      expect(
        RegistryRecordSchema.safeParse({ ...validRecord, authToken }).success,
      ).toBe(false);
    }
  });

  it('keeps endpoint variants strict and local', () => {
    expect(
      RegistryRecordSchema.safeParse({
        ...validRecord,
        endpoint: {
          kind: 'windowsNamedPipe',
          path: '\\\\.\\pipe\\vscode-mcp-window-random',
        },
      }).success,
    ).toBe(true);

    expect(
      RegistryRecordSchema.safeParse({
        ...validRecord,
        endpoint: { kind: 'windowsNamedPipe', path: '\\\\server\\pipe\\vscode-mcp' },
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate workspace roots and unknown fields', () => {
    expect(
      RegistryRecordSchema.safeParse({
        ...validRecord,
        workspaceFolders: [
          validRecord.workspaceFolders[0],
          validRecord.workspaceFolders[0],
        ],
      }).success,
    ).toBe(false);
    expect(
      RegistryRecordSchema.safeParse({ ...validRecord, debugToken: 'secret' }).success,
    ).toBe(false);
  });
});
