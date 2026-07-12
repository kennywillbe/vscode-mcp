import {
  V02_EXTENSION_TOOL_NAMES,
  V02ExtensionToolInvocationSchema,
  V02IpcCallToolResultSchema,
  V02IpcReadCallToolResultSchema,
  type V02ExtensionToolName,
  type V02IpcCallToolResult,
  type V02IpcReadCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas-v0.2';
import type { IpcCallToolResult } from '@vscode-mcp/protocol/ipc-schemas';
import {
  V02ReadToolInvocationSchema,
  V02_READ_TOOL_NAMES,
  type V02ReadToolName,
  type V02ToolExecutionError,
} from '@vscode-mcp/protocol/tool-schemas-v0.2';

import {
  WorkspaceDocumentBatchError,
  type WorkspaceDocumentBatchService,
} from './workspace-document-batch-service.js';
import {
  WorkspaceFileDiscoveryError,
  type WorkspaceFileDiscoveryService,
} from './workspace-file-discovery-service.js';
import {
  WorkspaceTextSearchError,
  type WorkspaceTextSearchService,
} from './workspace-text-search-service.js';

export interface V02LegacyToolRouter {
  readonly callTool: (
    invocation: unknown,
    signal: AbortSignal,
  ) => Promise<IpcCallToolResult>;
}

export interface V02ReadToolRouterOptions {
  readonly listFiles: Pick<WorkspaceFileDiscoveryService, 'listWorkspaceFiles'>;
  readonly readDocuments: Pick<WorkspaceDocumentBatchService, 'readDocuments'>;
  readonly searchText: Pick<WorkspaceTextSearchService, 'searchWorkspaceText'>;
}

/** Routes only the three additive v0.2 tools; legacy v0.1 routing remains untouched. */
export class V02ReadToolRouter {
  public readonly names = V02_READ_TOOL_NAMES;

  public constructor(private readonly options: V02ReadToolRouterOptions) {}

  public async callTool(
    untrustedInvocation: unknown,
    signal: AbortSignal,
  ): Promise<V02IpcReadCallToolResult> {
    const recognized = readToolName(untrustedInvocation);
    const parsed = V02ReadToolInvocationSchema.safeParse(untrustedInvocation);
    if (!parsed.success) {
      if (recognized === null) {
        throw new Error('The v0.2 read tool invocation is not recognized.');
      }
      return toolError(recognized, {
        code: 'INVALID_ARGUMENT',
        message: 'The tool arguments are invalid.',
        retryable: false,
      });
    }

    try {
      switch (parsed.data.tool) {
        case 'list_workspace_files':
          return V02IpcReadCallToolResultSchema.parse({
            outcome: 'success',
            tool: parsed.data.tool,
            response: await this.options.listFiles.listWorkspaceFiles(
              parsed.data.arguments,
              signal,
            ),
          });
        case 'read_documents':
          return V02IpcReadCallToolResultSchema.parse({
            outcome: 'success',
            tool: parsed.data.tool,
            response: await this.options.readDocuments.readDocuments(
              parsed.data.arguments,
              signal,
            ),
          });
        case 'search_workspace_text':
          return V02IpcReadCallToolResultSchema.parse({
            outcome: 'success',
            tool: parsed.data.tool,
            response: await this.options.searchText.searchWorkspaceText(
              parsed.data.arguments,
              signal,
            ),
          });
      }
    } catch (error) {
      return toolError(parsed.data.tool, normalizeFailure(error, signal));
    }
  }
}

/** Additive 0.2 composition seam; it is not connected to the active listener. */
export class V02ExtensionToolRouter {
  public readonly names = V02_EXTENSION_TOOL_NAMES;

  public constructor(
    private readonly legacy: V02LegacyToolRouter,
    private readonly reads: V02ReadToolRouter,
  ) {}

  public async callTool(
    untrustedInvocation: unknown,
    signal: AbortSignal,
  ): Promise<V02IpcCallToolResult> {
    const recognized = v02ToolName(untrustedInvocation);
    const parsed = V02ExtensionToolInvocationSchema.safeParse(untrustedInvocation);
    if (!parsed.success) {
      if (recognized === null) {
        throw new Error('The v0.2 extension tool invocation is not recognized.');
      }
      const malformed = isV02ReadToolName(recognized)
        ? await this.reads.callTool(untrustedInvocation, signal)
        : await this.legacy.callTool(untrustedInvocation, signal);
      return V02IpcCallToolResultSchema.parse(malformed);
    }

    const result = isV02ReadToolName(parsed.data.tool)
      ? await this.reads.callTool(parsed.data, signal)
      : await this.legacy.callTool(parsed.data, signal);
    const validated = V02IpcCallToolResultSchema.parse(result);
    if (resultTool(validated) !== parsed.data.tool) {
      throw new Error('The v0.2 extension router returned a mismatched result.');
    }
    return validated;
  }
}

function normalizeFailure(error: unknown, signal: AbortSignal): V02ToolExecutionError {
  if (signal.aborted) {
    return {
      code: 'CANCELLED',
      message: 'The request was cancelled.',
      retryable: true,
    };
  }
  if (
    error instanceof WorkspaceFileDiscoveryError ||
    error instanceof WorkspaceDocumentBatchError ||
    error instanceof WorkspaceTextSearchError
  ) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'The v0.2 read tool failed internally.',
    retryable: false,
  };
}

function toolError(
  tool: V02ReadToolName,
  error: V02ToolExecutionError,
): V02IpcReadCallToolResult {
  return V02IpcReadCallToolResultSchema.parse({ outcome: 'toolError', tool, error });
}

function readToolName(value: unknown): V02ReadToolName | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tool' in value) ||
    typeof value.tool !== 'string'
  ) {
    return null;
  }
  return V02_READ_TOOL_NAMES.find((candidate) => candidate === value.tool) ?? null;
}

function v02ToolName(value: unknown): V02ExtensionToolName | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tool' in value) ||
    typeof value.tool !== 'string'
  ) {
    return null;
  }
  return V02_EXTENSION_TOOL_NAMES.find((candidate) => candidate === value.tool) ?? null;
}

function isV02ReadToolName(tool: V02ExtensionToolName): tool is V02ReadToolName {
  return V02_READ_TOOL_NAMES.some((candidate) => candidate === tool);
}

function resultTool(result: V02IpcCallToolResult): V02ExtensionToolName {
  if ('tool' in result) {
    return result.tool;
  }
  return result.payload.tool;
}
