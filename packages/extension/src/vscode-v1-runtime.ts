import {
  V1_ADDITIONAL_TOOL_NAMES,
  type V1AllExtensionToolInvocation,
} from '@vscode-mcp/protocol/tool-schemas-v1';
import type { V1IpcCallToolResult } from '@vscode-mcp/protocol/ipc-schemas-v1';

import type { CapabilityGrantController } from './capability-grant-controller.js';
import type { ExtensionToolRouter } from './extension-tool-router.js';
import { VsCodeV02ReadRuntime } from './vscode-v0.2-read-runtime.js';
import { VsCodeV1IdeToolService } from './vscode-v1-ide-tool-service.js';

interface Options {
  readonly instanceId: string;
  readonly legacy: ExtensionToolRouter;
  readonly grants: CapabilityGrantController;
  readonly isWorkspaceEnabled: (fingerprint: string) => boolean | PromiseLike<boolean>;
}

/** Owns all additive 1.0 services for exactly one secure listener generation. */
export class VsCodeV1Runtime {
  readonly #reads: VsCodeV02ReadRuntime;
  readonly #readRouter;
  readonly #ide: VsCodeV1IdeToolService;

  public constructor(options: Options) {
    this.#reads = new VsCodeV02ReadRuntime({
      instanceId: options.instanceId,
      isWorkspaceEnabled: options.isWorkspaceEnabled,
    });
    this.#readRouter = this.#reads.withLegacyRouter(options.legacy);
    this.#ide = new VsCodeV1IdeToolService({
      grants: options.grants,
      isWorkspaceEnabled: options.isWorkspaceEnabled,
    });
  }

  public readonly callTool = async (
    invocation: V1AllExtensionToolInvocation,
    signal: AbortSignal,
  ): Promise<V1IpcCallToolResult> => {
    return isAdditional(invocation.tool)
      ? this.#ide.callTool(invocation, signal)
      : this.#readRouter.callTool(invocation, signal);
  };

  public dispose(): void {
    this.#ide.dispose();
    this.#reads.destroy();
  }

  public handleCapabilityRevoked(capability: 'write' | 'execution'): void {
    this.#ide.handleCapabilityRevoked(capability);
  }
}

function isAdditional(tool: V1AllExtensionToolInvocation['tool']): boolean {
  return V1_ADDITIONAL_TOOL_NAMES.some((name) => name === tool);
}
