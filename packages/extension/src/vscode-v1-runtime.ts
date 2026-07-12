import {
  V1_ADDITIONAL_TOOL_NAMES,
  type V1AllExtensionToolInvocation,
} from '@vscode-mcp/protocol/tool-schemas-v1';
import type { V1IpcCallToolResult } from '@vscode-mcp/protocol/ipc-schemas-v1';

import type { CapabilityGrantController } from './capability-grant-controller.js';
import type { ExtensionToolRouter } from './extension-tool-router.js';
import { VsCodeV02ReadRuntime } from './vscode-v0.2-read-runtime.js';
import { VsCodeV1IdeToolService } from './vscode-v1-ide-tool-service.js';
import {
  VisualChangeController,
  type VisualChangeSummary,
} from './visual-change-controller.js';

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
  readonly #visualChanges = new VisualChangeController();

  public constructor(options: Options) {
    this.#reads = new VsCodeV02ReadRuntime({
      instanceId: options.instanceId,
      isWorkspaceEnabled: options.isWorkspaceEnabled,
    });
    this.#readRouter = this.#reads.withLegacyRouter(options.legacy);
    this.#ide = new VsCodeV1IdeToolService({
      grants: options.grants,
      isWorkspaceEnabled: options.isWorkspaceEnabled,
      visualChanges: this.#visualChanges,
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
    this.#visualChanges.dispose();
    this.#reads.destroy();
  }

  public handleCapabilityRevoked(capability: 'write' | 'execution'): void {
    this.#ide.handleCapabilityRevoked(capability);
    if (capability === 'write') this.#visualChanges.clearAll();
  }

  public reviewChanges(): Promise<void> {
    return this.#visualChanges.reviewChanges();
  }

  public nextChange(direction: 1 | -1): Promise<void> {
    return this.#visualChanges.nextChange(direction);
  }

  public clearChangeHighlights(): void {
    this.#visualChanges.clearAll();
  }

  public clearCurrentFileChangeHighlights(): void {
    this.#visualChanges.clearActiveFile();
  }

  public visualChangeSummary(): VisualChangeSummary {
    return this.#visualChanges.summary();
  }
}

function isAdditional(tool: V1AllExtensionToolInvocation['tool']): boolean {
  return V1_ADDITIONAL_TOOL_NAMES.some((name) => name === tool);
}
