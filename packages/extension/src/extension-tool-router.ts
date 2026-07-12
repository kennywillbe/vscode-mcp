import {
  IpcCallToolResultSchema,
  type IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas';
import {
  EXTENSION_TOOL_NAMES,
  type ExtensionToolName,
} from '@vscode-mcp/protocol/tool-schemas';

import { hardenIpcToolSuccess } from './output-hardening.js';

export interface ExtensionToolProvider {
  readonly names: readonly ExtensionToolName[];
  readonly callTool: (
    invocation: unknown,
    signal: AbortSignal,
  ) => Promise<IpcCallToolResult>;
}

export const IMPLEMENTED_EXTENSION_TOOL_NAMES = [...EXTENSION_TOOL_NAMES] as const;

/** Routes only the fixed protocol tool set to cohesive, independently tested providers. */
export class ExtensionToolRouter {
  readonly #providerByTool = new Map<ExtensionToolName, ExtensionToolProvider>();

  public constructor(providers: readonly ExtensionToolProvider[]) {
    for (const provider of providers) {
      for (const name of provider.names) {
        if (this.#providerByTool.has(name)) {
          throw new Error('An extension tool has more than one provider.');
        }
        this.#providerByTool.set(name, provider);
      }
    }

    if (
      IMPLEMENTED_EXTENSION_TOOL_NAMES.some(
        (name) => !this.#providerByTool.has(name),
      ) ||
      this.#providerByTool.size !== IMPLEMENTED_EXTENSION_TOOL_NAMES.length
    ) {
      throw new Error('The extension tool provider set is incomplete.');
    }
  }

  public readonly callTool = async (
    invocation: unknown,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> => {
    const tool = invocationTool(invocation);
    if (tool === null) {
      throw new Error('The extension tool invocation is not recognized.');
    }
    const provider = this.#providerByTool.get(tool);
    if (provider === undefined) {
      throw new Error('The extension tool provider is unavailable.');
    }

    const providerResult = IpcCallToolResultSchema.parse(
      await provider.callTool(invocation, signal),
    );
    const result =
      providerResult.outcome === 'success'
        ? hardenIpcToolSuccess(providerResult)
        : providerResult;
    const responseTool =
      result.outcome === 'success' ? result.payload.tool : result.tool;
    if (responseTool !== tool) {
      throw new Error('The extension tool provider returned a mismatched result.');
    }
    return result;
  };
}

function invocationTool(value: unknown): ExtensionToolName | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tool' in value) ||
    typeof value.tool !== 'string'
  ) {
    return null;
  }
  return EXTENSION_TOOL_NAMES.find((candidate) => candidate === value.tool) ?? null;
}
