import { Buffer } from 'node:buffer';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PROTOCOL_LIMITS } from '@vscode-mcp/protocol/constants';
import type { IpcCallToolResult } from '@vscode-mcp/protocol/ipc-schemas';
import {
  ListInstancesResultSchema,
  ListInstancesSuccessSchema,
  type GetEditorContextResult,
  type ListInstancesResult,
} from '@vscode-mcp/protocol/tool-schemas';
import {
  V1_ALL_EXTENSION_TOOL_NAMES,
  type V1AllExtensionToolInvocation,
} from '@vscode-mcp/protocol/tool-schemas-v1';
import { describe, expect, it, vi } from 'vitest';

import {
  createMcpServer,
  EmptyInstanceRegistry,
  serverInstructions,
  type InstanceGateway,
  type InstanceGatewayCallResult,
} from './sdk-adapter.js';

const INSTANCE_ID = '00000000-0000-4000-8000-000000000001';
const OBSERVED_AT = '2026-07-10T00:00:00.000Z';

interface CapturedCall {
  readonly invocation: V1AllExtensionToolInvocation;
  readonly requestedInstanceId: string | null;
  readonly signal: AbortSignal;
}

class TestGateway implements InstanceGateway {
  readonly calls: CapturedCall[] = [];
  readonly #handler: InstanceGateway['call'];

  public constructor(handler: InstanceGateway['call']) {
    this.#handler = handler;
  }

  async list(): Promise<ListInstancesResult> {
    return emptyInstances();
  }

  async call(
    invocation: V1AllExtensionToolInvocation,
    requestedInstanceId: string | null,
    signal: AbortSignal,
  ): Promise<InstanceGatewayCallResult> {
    this.calls.push({ invocation, requestedInstanceId, signal });
    return this.#handler(invocation, requestedInstanceId, signal);
  }
}

describe('MCP SDK adapter', () => {
  it('starts with no discoverable instances', async () => {
    await expect(new EmptyInstanceRegistry().list()).resolves.toEqual(emptyInstances());
  });

  it('normalizes additive IDE results to the public 1.0 success envelope', async () => {
    const gateway = new TestGateway(async () => ({
      status: 'completed',
      instanceId: INSTANCE_ID,
      result: {
        outcome: 'success',
        tool: 'get_capability_status',
        observedAt: OBSERVED_AT,
        truncated: false,
        warnings: [],
        result: { read: true, write: false, execution: false },
      },
    }));
    const { client, close } = await connected(gateway);
    try {
      const response = await client.callTool({
        name: 'get_capability_status',
        arguments: { instanceId: INSTANCE_ID },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        contractVersion: '1.0.0',
        instanceId: INSTANCE_ID,
        result: { read: true, write: false, execution: false },
      });
    } finally {
      await close();
    }
  });

  it('exposes the exact canonical 1.0 inventory with least-privilege annotations', async () => {
    const { client, close } = await connected(new EmptyInstanceRegistry());
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'list_instances',
        ...V1_ALL_EXTENSION_TOOL_NAMES,
      ]);
      for (const tool of tools.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations?.openWorldHint).toBe(false);
        if (tool.name === 'delete_workspace_file' || tool.name === 'revert_documents') {
          expect(tool.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
          });
        }
      }
      const textSearch = tools.tools.find(
        (tool) => tool.name === 'search_workspace_text',
      );
      expect(textSearch?.inputSchema).toMatchObject({
        properties: {
          query: {
            description: expect.stringContaining(
              'Leading and trailing whitespace are significant',
            ),
          },
          contextLines: {
            maximum: 2,
            description: expect.stringContaining('maximum 2'),
          },
        },
      });

      const response = await client.callTool({
        name: 'list_instances',
        arguments: {},
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        contractVersion: '1.0.0',
        instanceId: null,
        result: {
          instances: [],
          resolution: { method: 'none' },
        },
      });
    } finally {
      await close();
    }
  });

  it('accepts an exact 512 KiB list_instances envelope and reduces plus one byte', async () => {
    const exact = listResultSizedTo(PROTOCOL_LIMITS.mcpResultBytes);
    const plusOne = listResultSizedTo(PROTOCOL_LIMITS.mcpResultBytes + 1);

    const exactConnection = await connected(gatewayListing(exact));
    try {
      const response = await exactConnection.client.callTool({
        name: 'list_instances',
        arguments: {},
      });
      expect(serializedBytes(response)).toBe(PROTOCOL_LIMITS.mcpResultBytes);
      expect(response.structuredContent).toMatchObject({
        truncated: false,
        warnings: [],
      });
    } finally {
      await exactConnection.close();
    }

    const oversizedConnection = await connected(gatewayListing(plusOne));
    try {
      const response = await oversizedConnection.client.callTool({
        name: 'list_instances',
        arguments: {},
      });
      expect(response.isError).not.toBe(true);
      expect(serializedBytes(response)).toBeLessThanOrEqual(
        PROTOCOL_LIMITS.mcpResultBytes,
      );
      expect(response.structuredContent).toMatchObject({
        truncated: true,
        warnings: [
          {
            code: 'RESULTS_TRUNCATED',
            omittedCount: expect.any(Number),
          },
        ],
      });
      const structured = response.structuredContent;
      expect(structured).toBeDefined();
      if (structured !== undefined) {
        const parsed = ListInstancesSuccessSchema.parse(structured);
        expect(parsed.result.instances[0]?.workspaceFolders.length).toBeLessThan(
          plusOne.instances[0]?.workspaceFolders.length ?? 0,
        );
      }
    } finally {
      await oversizedConnection.close();
    }
  });

  it('omits deterministic tail instances instead of failing an oversized list', async () => {
    const instances = Array.from({ length: 64 }, (_, index) =>
      listedInstance(index, [
        {
          workspaceFolderId: `root-${index}`,
          name: `workspace-${index}`,
          uri: `file:///workspace/${index}-${'x'.repeat(9_000)}`,
        },
      ]),
    );
    const result: ListInstancesResult = {
      instances,
      resolution: {
        selectedInstanceId: null,
        method: 'ambiguous',
        candidateInstanceIds: instances.map((instance) => instance.instanceId),
      },
    };
    const { client, close } = await connected(gatewayListing(result));
    try {
      const response = await client.callTool({
        name: 'list_instances',
        arguments: {},
      });

      expect(response.isError).not.toBe(true);
      expect(serializedBytes(response)).toBeLessThanOrEqual(
        PROTOCOL_LIMITS.mcpResultBytes,
      );
      const structured = ListInstancesSuccessSchema.parse(response.structuredContent);
      expect(structured.truncated).toBe(true);
      expect(structured.warnings[0]?.code).toBe('RESULTS_TRUNCATED');
      expect(structured.result.instances.length).toBeLessThan(instances.length);
      expect(
        structured.result.instances.map((instance) => instance.instanceId),
      ).toEqual(
        instances
          .slice(0, structured.result.instances.length)
          .map((instance) => instance.instanceId),
      );
    } finally {
      await close();
    }
  });

  it('drops optional workspace-file metadata before workspace-folder tails', async () => {
    const result = listResultSizedTo(PROTOCOL_LIMITS.mcpResultBytes - 256);
    const instance = result.instances[0];
    if (instance === undefined) {
      throw new Error('The boundary fixture must contain one instance.');
    }
    const originalFolderCount = instance.workspaceFolders.length;
    instance.workspaceFileUri = `file:///${'w'.repeat(16_000)}`;
    expect(serializedBytes(publicListResponse(result))).toBeGreaterThan(
      PROTOCOL_LIMITS.mcpResultBytes,
    );

    const { client, close } = await connected(gatewayListing(result));
    try {
      const response = await client.callTool({
        name: 'list_instances',
        arguments: {},
      });

      const structured = ListInstancesSuccessSchema.parse(response.structuredContent);
      expect(structured.truncated).toBe(true);
      expect(structured.warnings[0]).toMatchObject({
        code: 'RESULTS_TRUNCATED',
        omittedCount: 1,
      });
      expect(structured.result.instances[0]?.workspaceFileUri).toBeNull();
      expect(structured.result.instances[0]?.workspaceFolders).toHaveLength(
        originalFolderCount,
      );
      expect(serializedBytes(response)).toBeLessThanOrEqual(
        PROTOCOL_LIMITS.mcpResultBytes,
      );
    } finally {
      await close();
    }
  });

  it('strips instanceId before IPC and wraps a validated success', async () => {
    const gateway = new TestGateway(async () => ({
      status: 'completed',
      instanceId: INSTANCE_ID,
      result: editorContextSuccess(),
    }));
    const { client, close } = await connected(gateway);
    try {
      const response = await client.callTool({
        name: 'get_editor_context',
        arguments: { instanceId: INSTANCE_ID, documentLimit: 7 },
      });

      expect(gateway.calls).toHaveLength(1);
      expect(gateway.calls[0]).toMatchObject({
        requestedInstanceId: INSTANCE_ID,
        invocation: {
          tool: 'get_editor_context',
          arguments: { documentLimit: 7 },
        },
      });
      expect(gateway.calls[0]?.invocation.arguments).not.toHaveProperty('instanceId');
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toEqual({
        contractVersion: '1.0.0',
        instanceId: INSTANCE_ID,
        observedAt: OBSERVED_AT,
        truncated: false,
        warnings: [],
        result: emptyEditorContext(),
      });
      expect(response.content).toEqual([
        { type: 'text', text: 'get_editor_context completed.' },
      ]);
    } finally {
      await close();
    }
  });

  it('preserves a strict extension tool failure in the public Failure envelope', async () => {
    const gateway = new TestGateway(async () => ({
      status: 'completed',
      instanceId: INSTANCE_ID,
      result: {
        outcome: 'toolError',
        tool: 'get_editor_context',
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'No editor provider is available.',
          retryable: false,
        },
      },
    }));
    const { client, close } = await connected(gateway);
    try {
      const response = await client.callTool({
        name: 'get_editor_context',
        arguments: {},
      });

      expect(response.isError).toBe(true);
      expect(response.structuredContent).toEqual({
        contractVersion: '1.0.0',
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'No editor provider is available.',
          retryable: false,
        },
      });
      expect(response).toMatchObject({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('PROVIDER_UNAVAILABLE'),
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it('preserves a safe replacement instance hint in the public Failure envelope', async () => {
    const replacementInstanceId = '00000000-0000-4000-8000-000000000002';
    const gateway = new TestGateway(async () => ({
      status: 'failed',
      error: {
        code: 'INSTANCE_NOT_FOUND',
        message: 'No eligible VS Code instance matches this request.',
        retryable: true,
        details: { replacementInstanceId },
      },
    }));
    const { client, close } = await connected(gateway);
    try {
      const response = await client.callTool({
        name: 'get_editor_context',
        arguments: { instanceId: INSTANCE_ID },
      });

      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({
        error: {
          code: 'INSTANCE_NOT_FOUND',
          details: { replacementInstanceId },
        },
      });
    } finally {
      await close();
    }
  });

  it('fails closed when an IPC response is tagged for another tool', async () => {
    const gateway = new TestGateway(async () => ({
      status: 'completed',
      instanceId: INSTANCE_ID,
      result: {
        outcome: 'toolError',
        tool: 'get_hover',
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'No hover provider is available.',
          retryable: false,
        },
      },
    }));
    const { client, close } = await connected(gateway);
    try {
      const response = await client.callTool({
        name: 'get_editor_context',
        arguments: {},
      });

      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The VS Code instance returned a mismatched tool response.',
        },
      });
    } finally {
      await close();
    }
  });

  it('propagates MCP cancellation through the gateway AbortSignal', async () => {
    let propagatedSignal: AbortSignal | undefined;
    const gateway = new TestGateway(
      async (_invocation, _requestedInstanceId, signal) =>
        new Promise<InstanceGatewayCallResult>((resolve) => {
          propagatedSignal = signal;
          const cancelled = (): void => {
            resolve({
              status: 'failed',
              error: {
                code: 'CANCELLED',
                message: 'The tool request was cancelled.',
                retryable: true,
              },
            });
          };
          if (signal.aborted) {
            cancelled();
          } else {
            signal.addEventListener('abort', cancelled, { once: true });
          }
        }),
    );
    const { client, close } = await connected(gateway);
    const controller = new AbortController();
    try {
      const response = client.callTool(
        { name: 'get_editor_context', arguments: {} },
        undefined,
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(propagatedSignal).toBeDefined());
      controller.abort();

      await expect(response).rejects.toThrow();
      await vi.waitFor(() => expect(propagatedSignal?.aborted).toBe(true));
    } finally {
      await close();
    }
  });

  it('fails closed when the complete serialized MCP success exceeds 512 KiB', async () => {
    const oversizedDocuments = Array.from({ length: 80 }, (_, index) => {
      const relativePath = `${index}-${'a'.repeat(3_990)}`;
      return {
        uri: `file:///workspace/${relativePath}`,
        workspaceFolderId: 'root',
        relativePath,
        languageId: 'plaintext',
        documentVersion: 1,
        isDirty: false,
      };
    });
    const gateway = new TestGateway(async () => ({
      status: 'completed',
      instanceId: INSTANCE_ID,
      result: editorContextSuccess({
        ...emptyEditorContext(),
        openDocuments: oversizedDocuments,
      }),
    }));
    const { client, close } = await connected(gateway);
    try {
      const response = await client.callTool({
        name: 'get_editor_context',
        arguments: {},
      });

      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({
        contractVersion: '1.0.0',
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The tool result exceeded the bridge output limit.',
          retryable: false,
        },
      });
    } finally {
      await close();
    }
  });

  it('documents the contract position convention', () => {
    expect(serverInstructions()).toContain('zero-based UTF-16');
  });
});

function editorContextSuccess(
  result: ReturnType<typeof emptyEditorContext> = emptyEditorContext(),
): IpcCallToolResult {
  return {
    outcome: 'success',
    observedAt: OBSERVED_AT,
    truncated: false,
    warnings: [],
    payload: { tool: 'get_editor_context', result },
  };
}

function emptyEditorContext(): GetEditorContextResult {
  return {
    activeEditor: null,
    visibleEditors: [],
    openDocuments: [],
    tabs: [],
    omitted: { editors: 0, documents: 0, tabs: 0 },
  };
}

function emptyInstances(): ListInstancesResult {
  return {
    instances: [],
    resolution: {
      selectedInstanceId: null,
      method: 'none',
      candidateInstanceIds: [],
    },
  };
}

function gatewayListing(result: ListInstancesResult): InstanceGateway {
  return {
    async list(): Promise<ListInstancesResult> {
      return result;
    },
    async call(): Promise<InstanceGatewayCallResult> {
      return {
        status: 'failed',
        error: {
          code: 'INSTANCE_NOT_FOUND',
          message: 'No instance call was expected.',
          retryable: false,
        },
      };
    },
  };
}

function listResultSizedTo(targetBytes: number): ListInstancesResult {
  const folders = Array.from({ length: 64 }, (_, index) => ({
    workspaceFolderId: `root-${index}`,
    name: `workspace-${index}`,
    uri: `file:///workspace/${index}/`,
  }));
  const result: ListInstancesResult = {
    instances: [listedInstance(0, folders)],
    resolution: {
      selectedInstanceId: INSTANCE_ID,
      method: 'single',
      candidateInstanceIds: [INSTANCE_ID],
    },
  };
  let remaining = targetBytes - serializedBytes(publicListResponse(result));
  if (remaining < 0) {
    throw new Error('The target is smaller than the list_instances envelope.');
  }

  for (const folder of folders) {
    const capacity = 16_384 - folder.uri.length;
    const added = Math.min(capacity, remaining);
    folder.uri += 'x'.repeat(added);
    remaining -= added;
  }
  if (remaining !== 0) {
    throw new Error('The requested list_instances payload size cannot be constructed.');
  }
  expect(serializedBytes(publicListResponse(result))).toBe(targetBytes);
  return ListInstancesResultSchema.parse(result);
}

function listedInstance(
  index: number,
  workspaceFolders: ListInstancesResult['instances'][number]['workspaceFolders'],
): ListInstancesResult['instances'][number] {
  const instanceId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  return {
    instanceId,
    displayName: `VS Code ${index}`,
    trusted: true,
    publishedAt: OBSERVED_AT,
    workspaceFileUri: null,
    workspaceFolders,
    protocolVersion: 1,
    toolContractVersion: '1.0.0',
  };
}

function publicListResponse(result: ListInstancesResult): CallToolResult {
  return {
    structuredContent: {
      contractVersion: '1.0.0',
      instanceId: null,
      observedAt: OBSERVED_AT,
      truncated: false,
      warnings: [],
      result,
    },
    content: [
      {
        type: 'text',
        text: `${result.instances.length} authenticated VS Code instance(s).`,
      },
    ],
  };
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('The test value could not be serialized.');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

async function connected(gateway: InstanceGateway): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
}> {
  const server = createMcpServer(gateway);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
  };
}
