import type {
  ExtensionToolProvider,
  ExtensionToolRouter,
} from './extension-tool-router.js';
import { ExtensionToolRouter as Router } from './extension-tool-router.js';
import { EDITOR_EXTENSION_TOOL_NAMES } from './editor-tool-service.js';
import { LANGUAGE_LOCATION_EXTENSION_TOOL_NAMES } from './language-location-tool-service.js';
import { LANGUAGE_EXTENSION_TOOL_NAMES } from './language-tool-service.js';
import { createVsCodeEditorToolService } from './vscode-editor-tool-adapter.js';
import { createVsCodeLanguageLocationToolService } from './vscode-language-location-tool-adapter.js';
import { createVsCodeLanguageToolService } from './vscode-language-tool-adapter.js';

export interface VsCodeExtensionToolRouterOptions {
  readonly isWorkspaceEnabled: (
    workspaceFingerprint: string,
  ) => boolean | PromiseLike<boolean>;
}

export function createVsCodeExtensionToolRouter(
  options: VsCodeExtensionToolRouterOptions,
): ExtensionToolRouter {
  const editor = createVsCodeEditorToolService(options);
  const language = createVsCodeLanguageToolService(options);
  const locations = createVsCodeLanguageLocationToolService(options);
  return new Router([
    provider(EDITOR_EXTENSION_TOOL_NAMES, editor),
    provider(LANGUAGE_EXTENSION_TOOL_NAMES, language),
    provider(LANGUAGE_LOCATION_EXTENSION_TOOL_NAMES, locations),
  ]);
}

function provider(
  names: ExtensionToolProvider['names'],
  service: Pick<ExtensionToolProvider, 'callTool'>,
): ExtensionToolProvider {
  return { names, callTool: service.callTool };
}
