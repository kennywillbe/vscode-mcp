import { describe, expect, it } from 'vitest';

import { createInstanceCredentials } from './credentials.js';
import { evaluateHello, registryMatchesHello } from './handshake.js';
import type { RegistryRecord } from './registry-schemas.js';

function fixture() {
  const credentials = createInstanceCredentials();
  const instance = {
    instanceId: credentials.instanceId,
    displayName: 'fixture',
    trusted: true as const,
    publishedAt: '2026-07-10T00:00:00.000Z',
    workspaceFileUri: null,
    workspaceFolders: [
      {
        workspaceFolderId: 'root',
        name: 'fixture',
        uri: 'file:///workspace',
      },
    ],
    protocolVersion: 1 as const,
    toolContractVersion: '1.0.0' as const,
  };
  const expectation = {
    instance,
    workspaceFingerprint: 'a'.repeat(64),
    authToken: credentials.authToken,
    capabilities: { extensionTools: [], cancellation: true as const },
  };
  const params = {
    protocolVersion: 1,
    toolContractVersion: '1.0.0',
    instanceId: credentials.instanceId,
    authToken: credentials.authToken,
    client: { name: 'vscode-mcp-bridge', version: '0.0.0' },
  };
  const record: RegistryRecord = {
    schemaVersion: 1,
    protocolVersion: 1,
    toolContractVersion: '1.0.0',
    instanceId: credentials.instanceId,
    extensionVersion: '0.0.0',
    pid: 42,
    publishedAt: instance.publishedAt,
    heartbeatAt: '2026-07-10T00:00:05.000Z',
    endpoint: { kind: 'unix', path: '/tmp/vscode-mcp/window.sock' },
    authToken: credentials.authToken,
    displayName: instance.displayName,
    workspaceFingerprint: expectation.workspaceFingerprint,
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

  return { expectation, params, record };
}

describe('IPC hello handshake', () => {
  it('authenticates before returning the current contract', () => {
    const { expectation, params } = fixture();
    const decision = evaluateHello(params, expectation);

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.result.instance.instanceId).toBe(params.instanceId);
      expect(decision.result.workspaceFingerprint).toBe('a'.repeat(64));
    }
  });

  it('uses the same generic result for malformed, token, and instance failures', () => {
    const { expectation, params } = fixture();
    const failures = [
      evaluateHello({ ...params, authToken: 'invalid' }, expectation),
      evaluateHello({ ...params, authToken: 'B'.repeat(43) }, expectation),
      evaluateHello(
        { ...params, instanceId: '00000000-0000-4000-8000-000000000000' },
        expectation,
      ),
    ];

    expect(failures).toEqual([
      {
        ok: false,
        failure: { kind: 'authentication', message: 'Authentication failed' },
      },
      {
        ok: false,
        failure: { kind: 'authentication', message: 'Authentication failed' },
      },
      {
        ok: false,
        failure: { kind: 'authentication', message: 'Authentication failed' },
      },
    ]);
  });

  it('reports version detail only after valid authentication', () => {
    const { expectation, params } = fixture();
    const decision = evaluateHello({ ...params, protocolVersion: 2 }, expectation);

    expect(decision).toEqual({
      ok: false,
      failure: {
        kind: 'protocol',
        message: 'Protocol version mismatch',
        code: 'PROTOCOL_VERSION_MISMATCH',
        details: { received: 2, supported: 1 },
      },
    });
  });

  it('rejects registry metadata that disagrees with authenticated hello data', () => {
    const { expectation, params, record } = fixture();
    const decision = evaluateHello(params, expectation);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }

    expect(registryMatchesHello(record, decision.result)).toBe(true);
    expect(
      registryMatchesHello(
        { ...record, workspaceFingerprint: 'b'.repeat(64) },
        decision.result,
      ),
    ).toBe(false);
  });
});
