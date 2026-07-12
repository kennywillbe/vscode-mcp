import { Buffer } from 'node:buffer';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { PROTOCOL_LIMITS, TOOL_CONTRACT_VERSION } from '@vscode-mcp/protocol/constants';
import {
  V1IpcCallToolResultSchema,
  type V1IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas-v1';
import {
  FailureSchema,
  ToolExecutionErrorSchema,
  type ToolExecutionError,
} from '@vscode-mcp/protocol/schemas';
import {
  FindReferencesInputSchema,
  FindReferencesSuccessSchema,
  GetCallHierarchyInputSchema,
  GetCallHierarchySuccessSchema,
  GetDefinitionInputSchema,
  GetDefinitionSuccessSchema,
  GetDiagnosticsInputSchema,
  GetDiagnosticsSuccessSchema,
  GetDocumentSymbolsInputSchema,
  GetDocumentSymbolsSuccessSchema,
  GetEditorContextInputSchema,
  GetEditorContextSuccessSchema,
  GetHoverInputSchema,
  GetHoverSuccessSchema,
  GetSignatureHelpInputSchema,
  GetSignatureHelpSuccessSchema,
  ListInstancesInputSchema,
  ListInstancesResultSchema,
  ListInstancesSuccessSchema,
  ReadDocumentInputSchema,
  ReadDocumentSuccessSchema,
  SearchWorkspaceSymbolsInputSchema,
  SearchWorkspaceSymbolsSuccessSchema,
  type ListInstancesResult,
} from '@vscode-mcp/protocol/tool-schemas';
import {
  V02ListWorkspaceFilesInputSchema,
  V02ReadDocumentsInputSchema,
  V02SearchWorkspaceTextInputSchema,
} from '@vscode-mcp/protocol/tool-schemas-v0.2';
import {
  V1AdditionalToolInputSchemas,
  V1AllExtensionToolInvocationSchema,
  V1_ADDITIONAL_TOOL_NAMES,
  createV1AdditionalSuccessSchema,
  type V1AllExtensionToolInvocation,
  type V1AllExtensionToolName,
} from '@vscode-mcp/protocol/tool-schemas-v1';
import type * as z from 'zod/v4';

import { BoundedStdioServerTransport } from './bounded-stdio-transport.js';
import { SERVER_VERSION } from './version.js';

export type InstanceGatewayCallResult =
  | {
      readonly status: 'completed';
      readonly instanceId: string;
      readonly result: V1IpcCallToolResult;
    }
  | {
      readonly status: 'failed';
      readonly error: ToolExecutionError;
    };

export interface InstanceGateway {
  list(): Promise<ListInstancesResult>;
  call(
    invocation: V1AllExtensionToolInvocation,
    requestedInstanceId: string | null,
    signal: AbortSignal,
  ): Promise<InstanceGatewayCallResult>;
}

export class EmptyInstanceRegistry implements InstanceGateway {
  async list(): Promise<ListInstancesResult> {
    return {
      instances: [],
      resolution: {
        selectedInstanceId: null,
        method: 'none',
        candidateInstanceIds: [],
      },
    };
  }

  async call(): Promise<InstanceGatewayCallResult> {
    return {
      status: 'failed',
      error: toolError(
        'INSTANCE_NOT_FOUND',
        'No eligible VS Code instance is available.',
        true,
      ),
    };
  }
}

interface ExtensionToolDefinition {
  readonly name: V1AllExtensionToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
}

const LEGACY_EXTENSION_TOOL_DEFINITIONS = [
  {
    name: 'get_editor_context',
    title: 'Get VS Code editor context',
    description:
      'Returns accessible live editors, documents, selections, visible ranges, and tabs for the selected VS Code window.',
    inputSchema: GetEditorContextInputSchema,
    outputSchema: GetEditorContextSuccessSchema,
  },
  {
    name: 'read_document',
    title: 'Read a VS Code document',
    description:
      'Reads a bounded line range from an authorized live VS Code text document, including unsaved content.',
    inputSchema: ReadDocumentInputSchema,
    outputSchema: ReadDocumentSuccessSchema,
  },
  {
    name: 'get_diagnostics',
    title: 'Get VS Code diagnostics',
    description:
      'Returns bounded diagnostics for one authorized document or accessible open documents.',
    inputSchema: GetDiagnosticsInputSchema,
    outputSchema: GetDiagnosticsSuccessSchema,
  },
  {
    name: 'get_hover',
    title: 'Get VS Code hover information',
    description:
      'Returns bounded hover information from the selected VS Code language provider.',
    inputSchema: GetHoverInputSchema,
    outputSchema: GetHoverSuccessSchema,
  },
  {
    name: 'get_definition',
    title: 'Get VS Code definitions',
    description:
      'Returns authorized definition, declaration, type-definition, or implementation locations.',
    inputSchema: GetDefinitionInputSchema,
    outputSchema: GetDefinitionSuccessSchema,
  },
  {
    name: 'find_references',
    title: 'Find VS Code references',
    description:
      'Returns authorized reference locations and optional bounded context from VS Code.',
    inputSchema: FindReferencesInputSchema,
    outputSchema: FindReferencesSuccessSchema,
  },
  {
    name: 'get_document_symbols',
    title: 'Get VS Code document symbols',
    description: 'Returns a bounded, preorder symbol list for an authorized document.',
    inputSchema: GetDocumentSymbolsInputSchema,
    outputSchema: GetDocumentSymbolsSuccessSchema,
  },
  {
    name: 'search_workspace_symbols',
    title: 'Search VS Code workspace symbols',
    description:
      'Searches bounded, authorized workspace symbols in the selected VS Code window.',
    inputSchema: SearchWorkspaceSymbolsInputSchema,
    outputSchema: SearchWorkspaceSymbolsSuccessSchema,
  },
  {
    name: 'get_signature_help',
    title: 'Get VS Code signature help',
    description: 'Returns bounded signature help at an authorized document position.',
    inputSchema: GetSignatureHelpInputSchema,
    outputSchema: GetSignatureHelpSuccessSchema,
  },
  {
    name: 'get_call_hierarchy',
    title: 'Get VS Code call hierarchy',
    description:
      'Returns bounded incoming and outgoing call hierarchy information for an authorized symbol.',
    inputSchema: GetCallHierarchyInputSchema,
    outputSchema: GetCallHierarchySuccessSchema,
  },
] as const satisfies readonly ExtensionToolDefinition[];

const GENERIC_V1_SUCCESS_SCHEMA = createV1AdditionalSuccessSchema();

const ADDITIVE_EXTENSION_TOOL_DEFINITIONS: readonly ExtensionToolDefinition[] = [
  definition(
    'list_workspace_files',
    'List workspace files',
    'Lists bounded workspace-relative file paths using the VS Code workspace and the secure scanner.',
    V02ListWorkspaceFilesInputSchema,
  ),
  definition(
    'read_documents',
    'Read multiple documents',
    'Reads multiple authorized live or on-disk documents in one bounded request.',
    V02ReadDocumentsInputSchema,
  ),
  definition(
    'search_workspace_text',
    'Search workspace text',
    'Searches literal text across the selected workspace with dirty-buffer precedence and bounded pagination.',
    V02SearchWorkspaceTextInputSchema,
  ),
  ...V1_ADDITIONAL_TOOL_NAMES.map((name) =>
    definition(
      name,
      titleFor(name),
      descriptionFor(name),
      V1AdditionalToolInputSchemas[name],
    ),
  ),
];

const EXTENSION_TOOL_DEFINITIONS: readonly ExtensionToolDefinition[] = [
  ...LEGACY_EXTENSION_TOOL_DEFINITIONS,
  ...ADDITIVE_EXTENSION_TOOL_DEFINITIONS,
];

function definition(
  name: V1AllExtensionToolName,
  title: string,
  description: string,
  inputSchema: z.ZodType,
): ExtensionToolDefinition {
  return {
    name,
    title,
    description,
    inputSchema,
    outputSchema: GENERIC_V1_SUCCESS_SCHEMA,
  };
}

function titleFor(name: (typeof V1_ADDITIONAL_TOOL_NAMES)[number]): string {
  return name
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');
}

function descriptionFor(name: (typeof V1_ADDITIONAL_TOOL_NAMES)[number]): string {
  if (name === 'get_capability_status')
    return 'Returns current read, write, and configured-execution authorization state.';
  if (name.startsWith('get_'))
    return `Returns bounded, workspace-authorized VS Code ${name.slice(4).replaceAll('_', ' ')} data.`;
  if (name === 'list_tasks')
    return 'Lists configured VS Code tasks without exposing commands, arguments, or environment values.';
  if (name === 'run_task')
    return 'Runs a previously listed configured VS Code task under the execution grant.';
  if (name === 'start_debugging')
    return 'Starts a named launch configuration under the execution grant.';
  return `Performs the bounded VS Code ${name.replaceAll('_', ' ')} operation under its required session grant.`;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_ANNOTATIONS = {
  ...MUTATING_ANNOTATIONS,
  destructiveHint: true,
} as const;

export function createMcpServer(gateway: InstanceGateway): McpServer {
  const server = new McpServer({
    name: 'vscode-mcp',
    version: SERVER_VERSION,
  });

  server.registerTool(
    'list_instances',
    {
      title: 'List VS Code instances',
      description:
        'Lists authenticated, eligible local VS Code windows and deterministic selection metadata.',
      inputSchema: ListInstancesInputSchema,
      outputSchema: ListInstancesSuccessSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const result = ListInstancesResultSchema.parse(await gateway.list());
      return boundedListInstancesResponse(result, new Date().toISOString());
    },
  );

  for (const definition of EXTENSION_TOOL_DEFINITIONS) {
    registerExtensionTool(server, gateway, definition);
  }

  return server;
}

function annotationsFor(name: V1AllExtensionToolName) {
  if (name === 'delete_workspace_file' || name === 'revert_documents') {
    return DESTRUCTIVE_ANNOTATIONS;
  }
  if (
    name === 'apply_text_edits' ||
    name === 'create_workspace_file' ||
    name === 'move_workspace_file' ||
    name === 'save_documents' ||
    name === 'rename_symbol' ||
    name === 'format_document' ||
    name === 'apply_code_action' ||
    name === 'run_task' ||
    name === 'terminate_task' ||
    name === 'start_debugging' ||
    name === 'stop_debugging'
  ) {
    return MUTATING_ANNOTATIONS;
  }
  return READ_ONLY_ANNOTATIONS;
}

function registerExtensionTool(
  server: McpServer,
  gateway: InstanceGateway,
  definition: ExtensionToolDefinition,
): void {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: annotationsFor(definition.name),
    },
    async (input: unknown, extra): Promise<CallToolResult> => {
      const invocation = createInvocation(definition, input);
      const call = await gateway.call(
        invocation.invocation,
        invocation.requestedInstanceId,
        extra.signal,
      );

      if (call.status === 'failed') {
        return failureResult(call.error);
      }

      return completedCallResult(definition, invocation.invocation, call);
    },
  );
}

function createInvocation(
  definition: ExtensionToolDefinition,
  input: unknown,
): {
  readonly invocation: V1AllExtensionToolInvocation;
  readonly requestedInstanceId: string | null;
} {
  const validatedInput: unknown = definition.inputSchema.parse(input);
  if (!isRecord(validatedInput)) {
    throw new Error('The validated MCP tool input was not an object.');
  }
  assertSerializedToolArgumentsWithinLimit(validatedInput);

  const requestedInstanceIdValue = validatedInput.instanceId;
  if (
    requestedInstanceIdValue !== undefined &&
    typeof requestedInstanceIdValue !== 'string'
  ) {
    throw new Error('The validated MCP instance selector was not a string.');
  }

  const arguments_: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validatedInput)) {
    if (key !== 'instanceId') {
      arguments_[key] = value;
    }
  }

  return {
    invocation: V1AllExtensionToolInvocationSchema.parse({
      tool: definition.name,
      arguments: arguments_,
    }),
    requestedInstanceId: requestedInstanceIdValue ?? null,
  };
}

export function assertSerializedToolArgumentsWithinLimit(arguments_: unknown): void {
  if (serializedSize(arguments_) <= PROTOCOL_LIMITS.mcpToolArgumentsBytes) {
    return;
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    'Tool arguments exceed the serialized input limit.',
  );
}

function completedCallResult(
  definition: ExtensionToolDefinition,
  invocation: V1AllExtensionToolInvocation,
  call: Extract<InstanceGatewayCallResult, { readonly status: 'completed' }>,
): CallToolResult {
  const parsedResult = V1IpcCallToolResultSchema.safeParse(call.result);
  if (!parsedResult.success) {
    return internalFailure('The VS Code instance returned an invalid tool response.');
  }

  if (parsedResult.data.outcome === 'toolError') {
    if (parsedResult.data.tool !== invocation.tool) {
      return internalFailure(
        'The VS Code instance returned a mismatched tool response.',
      );
    }
    return failureResult(parsedResult.data.error);
  }

  const responseTool =
    'payload' in parsedResult.data
      ? parsedResult.data.payload.tool
      : parsedResult.data.tool;
  if (responseTool !== invocation.tool) {
    return internalFailure('The VS Code instance returned a mismatched tool response.');
  }

  const body =
    'payload' in parsedResult.data
      ? {
          observedAt: parsedResult.data.observedAt,
          truncated: parsedResult.data.truncated,
          warnings: parsedResult.data.warnings,
          result: parsedResult.data.payload.result,
        }
      : 'response' in parsedResult.data
        ? parsedResult.data.response
        : parsedResult.data;

  const success = {
    contractVersion: TOOL_CONTRACT_VERSION,
    instanceId: call.instanceId,
    observedAt: body.observedAt,
    truncated: body.truncated,
    warnings: body.warnings,
    result: body.result,
  };
  const validatedSuccess = definition.outputSchema.safeParse(success);
  if (!validatedSuccess.success || !isRecord(validatedSuccess.data)) {
    return internalFailure('The VS Code instance returned an invalid tool payload.');
  }

  const response: CallToolResult = {
    structuredContent: validatedSuccess.data,
    content: [{ type: 'text', text: `${definition.name} completed.` }],
  };
  if (serializedSize(response) > PROTOCOL_LIMITS.mcpResultBytes) {
    return internalFailure('The tool result exceeded the bridge output limit.');
  }

  return response;
}

function boundedListInstancesResponse(
  source: ListInstancesResult,
  observedAt: string,
): CallToolResult {
  const result = ListInstancesResultSchema.parse(source);
  let omittedCount = 0;
  let response = listInstancesResponse(result, observedAt, omittedCount);
  if (serializedSize(response) <= PROTOCOL_LIMITS.mcpResultBytes) {
    return response;
  }

  const workspaceFileUris = result.instances.map(
    (instance) => instance.workspaceFileUri,
  );
  const workspaceFileUriCount = workspaceFileUris.reduce(
    (count, uri) => count + (uri === null ? 0 : 1),
    0,
  );
  ({ omittedCount, response } = retainLargestListPrefix(
    result,
    observedAt,
    omittedCount,
    workspaceFileUriCount,
    (kept) => {
      let seen = 0;
      for (const [index, instance] of result.instances.entries()) {
        const uri = workspaceFileUris[index] ?? null;
        if (uri === null) {
          instance.workspaceFileUri = null;
          continue;
        }
        instance.workspaceFileUri = seen < kept ? uri : null;
        seen += 1;
      }
    },
  ));
  if (serializedSize(response) <= PROTOCOL_LIMITS.mcpResultBytes) {
    return response;
  }

  const folderGroups = result.instances.map((instance) => [
    ...instance.workspaceFolders,
  ]);
  const extraFolderCount = folderGroups.reduce(
    (count, folders) => count + Math.max(0, folders.length - 1),
    0,
  );
  ({ omittedCount, response } = retainLargestListPrefix(
    result,
    observedAt,
    omittedCount,
    extraFolderCount,
    (kept) => {
      let remaining = kept;
      for (const [index, instance] of result.instances.entries()) {
        const folders = folderGroups[index] ?? [];
        const extraCount = Math.min(remaining, Math.max(0, folders.length - 1));
        instance.workspaceFolders = folders.slice(0, 1 + extraCount);
        remaining -= extraCount;
      }
    },
  ));
  if (serializedSize(response) <= PROTOCOL_LIMITS.mcpResultBytes) {
    return response;
  }

  const instances = [...result.instances];
  ({ omittedCount, response } = retainLargestListPrefix(
    result,
    observedAt,
    omittedCount,
    instances.length,
    (kept) => {
      result.instances = instances.slice(0, kept);
    },
  ));
  if (serializedSize(response) <= PROTOCOL_LIMITS.mcpResultBytes) {
    return response;
  }

  const candidateInstanceIds = [...result.resolution.candidateInstanceIds];
  ({ response } = retainLargestListPrefix(
    result,
    observedAt,
    omittedCount,
    candidateInstanceIds.length,
    (kept) => {
      result.resolution.candidateInstanceIds = candidateInstanceIds.slice(0, kept);
    },
  ));

  return serializedSize(response) <= PROTOCOL_LIMITS.mcpResultBytes
    ? response
    : internalFailure('The tool result exceeded the bridge output limit.');
}

function retainLargestListPrefix(
  result: ListInstancesResult,
  observedAt: string,
  baselineOmittedCount: number,
  total: number,
  applyPrefix: (kept: number) => void,
): { readonly omittedCount: number; readonly response: CallToolResult } {
  if (total === 0) {
    return {
      omittedCount: baselineOmittedCount,
      response: listInstancesResponse(result, observedAt, baselineOmittedCount),
    };
  }

  let lower = 0;
  let upper = total;
  let best = 0;
  while (lower <= upper) {
    const candidate = lower + Math.floor((upper - lower) / 2);
    applyPrefix(candidate);
    const candidateOmittedCount = safeCountSum(baselineOmittedCount, total - candidate);
    const candidateResponse = listInstancesResponse(
      result,
      observedAt,
      candidateOmittedCount,
    );
    if (serializedSize(candidateResponse) <= PROTOCOL_LIMITS.mcpResultBytes) {
      best = candidate;
      lower = candidate + 1;
    } else {
      upper = candidate - 1;
    }
  }

  applyPrefix(best);
  const omittedCount = safeCountSum(baselineOmittedCount, total - best);
  return {
    omittedCount,
    response: listInstancesResponse(result, observedAt, omittedCount),
  };
}

function listInstancesResponse(
  result: ListInstancesResult,
  observedAt: string,
  omittedCount: number,
): CallToolResult {
  const truncated = omittedCount > 0;
  const success = ListInstancesSuccessSchema.parse({
    contractVersion: TOOL_CONTRACT_VERSION,
    instanceId: null,
    observedAt,
    truncated,
    warnings: truncated
      ? [
          {
            code: 'RESULTS_TRUNCATED',
            message:
              'Some instance metadata was omitted to enforce the serialized output limit.',
            omittedCount,
          },
        ]
      : [],
    result,
  });

  return {
    structuredContent: success,
    content: [
      {
        type: 'text',
        text: `${result.instances.length} authenticated VS Code instance(s).`,
      },
    ],
  };
}

function safeCountSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function failureResult(error: ToolExecutionError): CallToolResult {
  const validatedError = ToolExecutionErrorSchema.parse(error);
  const failure = FailureSchema.parse({
    contractVersion: TOOL_CONTRACT_VERSION,
    error: validatedError,
  });

  return {
    isError: true,
    structuredContent: failure,
    content: [{ type: 'text', text: JSON.stringify(failure) }],
  };
}

function internalFailure(message: string): CallToolResult {
  return failureResult(toolError('INTERNAL_ERROR', message, false));
}

function toolError(
  code: ToolExecutionError['code'],
  message: string,
  retryable: boolean,
): ToolExecutionError {
  return ToolExecutionErrorSchema.parse({ code, message, retryable });
}

function serializedSize(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Buffer.byteLength(serialized, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new BoundedStdioServerTransport();
  await server.connect(transport);
}

export function serverInstructions(): string {
  return [
    `Tool contract: ${TOOL_CONTRACT_VERSION}.`,
    'Only authenticated, eligible local VS Code instances are listed or invoked.',
    'All tool positions use zero-based UTF-16 line and character offsets.',
  ].join(' ');
}
