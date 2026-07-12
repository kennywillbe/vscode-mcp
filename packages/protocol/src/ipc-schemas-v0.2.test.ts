import { V02_TOOL_CONTRACT_VERSION } from './constants.js';
import { HelloResultSchema, IpcCallToolResultSchema } from './ipc-schemas.js';
import {
  V02_EXTENSION_TOOL_NAMES,
  V02CallToolRequestMessageSchema,
  V02ExtensionToolInvocationSchema,
  V02HelloResultSchema,
  V02IpcCallToolResultSchema,
  V02IpcCapabilitiesSchema,
  V02IpcReadCallToolResultSchema,
} from './ipc-schemas-v0.2.js';
import { ExtensionToolInvocationSchema } from './tool-schemas.js';
import { describe, expect, it } from 'vitest';

const instanceId = 'a12f0291-37e2-4ff6-b763-0abf3fe66714';
const workspaceFolderId = 'root';
const observedAt = '2026-07-11T03:30:00.000Z';

describe('isolated v0.2 IPC schemas', () => {
  it('publishes the additive canonical thirteen-tool extension capability list', () => {
    expect(V02_EXTENSION_TOOL_NAMES).toHaveLength(13);
    expect(V02_EXTENSION_TOOL_NAMES.slice(-3)).toEqual([
      'list_workspace_files',
      'read_documents',
      'search_workspace_text',
    ]);
    expect(
      V02IpcCapabilitiesSchema.safeParse({
        extensionTools: V02_EXTENSION_TOOL_NAMES,
        cancellation: true,
      }).success,
    ).toBe(true);
    expect(
      V02IpcCapabilitiesSchema.safeParse({
        extensionTools: [...V02_EXTENSION_TOOL_NAMES].reverse(),
        cancellation: true,
      }).success,
    ).toBe(false);
  });

  it('accepts v0.1 invocations additively while current v0.1 rejects new tools', () => {
    const oldInvocation = {
      tool: 'read_document',
      arguments: {
        document: {
          kind: 'workspacePath',
          workspaceFolderId,
          relativePath: 'a.ts',
        },
      },
    };
    const newInvocation = {
      tool: 'list_workspace_files',
      arguments: { workspaceFolderId },
    };
    expect(V02ExtensionToolInvocationSchema.safeParse(oldInvocation).success).toBe(
      true,
    );
    expect(V02ExtensionToolInvocationSchema.safeParse(newInvocation).success).toBe(
      true,
    );
    expect(ExtensionToolInvocationSchema.safeParse(newInvocation).success).toBe(false);
    expect(
      V02CallToolRequestMessageSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        method: 'vscode-mcp/callTool',
        params: newInvocation,
      }).success,
    ).toBe(true);
  });

  it('keeps exact v0.2 hello results isolated from current v0.1', () => {
    const hello = {
      protocolVersion: 1,
      toolContractVersion: V02_TOOL_CONTRACT_VERSION,
      workspaceFingerprint: 'a'.repeat(64),
      instance: {
        instanceId,
        displayName: 'fixture',
        trusted: true,
        publishedAt: observedAt,
        workspaceFileUri: null,
        workspaceFolders: [
          {
            workspaceFolderId,
            name: 'root',
            uri: 'file:///workspace',
          },
        ],
        protocolVersion: 1,
        toolContractVersion: V02_TOOL_CONTRACT_VERSION,
      },
      capabilities: {
        extensionTools: V02_EXTENSION_TOOL_NAMES,
        cancellation: true,
      },
    };
    expect(V02HelloResultSchema.safeParse(hello).success).toBe(true);
    expect(HelloResultSchema.safeParse(hello).success).toBe(false);
  });

  it('wraps new successes with an exact tool discriminator and safe errors', () => {
    const response = {
      contractVersion: V02_TOOL_CONTRACT_VERSION,
      instanceId,
      observedAt,
      truncated: false,
      warnings: [],
      result: {
        workspaceFolderId,
        files: ['a.ts'],
        hasMore: false,
        nextCursor: null,
      },
    };
    const success = {
      outcome: 'success',
      tool: 'list_workspace_files',
      response,
    };
    expect(V02IpcReadCallToolResultSchema.safeParse(success).success).toBe(true);
    expect(V02IpcCallToolResultSchema.safeParse(success).success).toBe(true);
    expect(IpcCallToolResultSchema.safeParse(success).success).toBe(false);
    expect(
      V02IpcReadCallToolResultSchema.safeParse({
        ...success,
        tool: 'search_workspace_text',
      }).success,
    ).toBe(false);
    expect(
      V02IpcReadCallToolResultSchema.safeParse({
        outcome: 'toolError',
        tool: 'read_documents',
        error: {
          code: 'BATCH_BUDGET_EXHAUSTED',
          message: 'The batch budget was exhausted.',
          retryable: true,
        },
      }).success,
    ).toBe(true);
  });
});
