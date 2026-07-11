import { randomBytes } from 'node:crypto';

import { InstanceIdSchema } from '@vscode-mcp/protocol/schemas';

import {
  V02ExtensionToolRouter,
  V02ReadToolRouter,
  type V02LegacyToolRouter,
} from './v0.2-read-tool-router.js';
import {
  createVsCodeWorkspaceDocumentBatchService,
  createVsCodeWorkspaceFileDiscoveryService,
  createVsCodeWorkspaceTextSearchService,
  type VsCodeEditorToolServiceOptions,
} from './vscode-editor-tool-adapter.js';
import { WorkspaceDiscoveryCursorCodec } from './workspace-discovery-cursor.js';

export interface VsCodeV02ReadRuntimeOptions extends VsCodeEditorToolServiceOptions {
  readonly instanceId: string;
  readonly cursorKey?: Uint8Array;
}

/**
 * Owns exactly one listener generation's v0.2 read services and cursor key.
 * Construction is intentionally not wired into the active v0.1 listener yet.
 */
export class VsCodeV02ReadRuntime {
  public readonly router: V02ReadToolRouter;
  readonly #cursorCodec: WorkspaceDiscoveryCursorCodec;
  #destroyed = false;

  public constructor(options: VsCodeV02ReadRuntimeOptions) {
    const instanceId = InstanceIdSchema.parse(options.instanceId);
    const generatedKey = options.cursorKey === undefined ? randomBytes(32) : null;
    const key = options.cursorKey ?? generatedKey;
    if (key === null) {
      throw new Error('The listener-generation cursor key is unavailable.');
    }
    try {
      this.#cursorCodec = new WorkspaceDiscoveryCursorCodec(key);
    } finally {
      generatedKey?.fill(0);
    }
    const serviceOptions = {
      instanceId,
      cursorCodec: this.#cursorCodec,
      isWorkspaceEnabled: options.isWorkspaceEnabled,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
    this.router = new V02ReadToolRouter({
      listFiles: createVsCodeWorkspaceFileDiscoveryService(serviceOptions),
      readDocuments: createVsCodeWorkspaceDocumentBatchService(serviceOptions),
      searchText: createVsCodeWorkspaceTextSearchService(serviceOptions),
    });
  }

  public destroy(): void {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.#cursorCodec.destroy();
    }
  }

  public withLegacyRouter(legacy: V02LegacyToolRouter): V02ExtensionToolRouter {
    return new V02ExtensionToolRouter(legacy, this.router);
  }
}
