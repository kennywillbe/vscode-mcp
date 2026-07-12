import type { Position } from '@vscode-mcp/protocol/schemas';

import type { EditorHostDocument, EditorHostFileStat } from './editor-tool-host.js';
import type { BoundedProviderItems } from './provider-output-bounds.js';

export interface LanguageHostDisposable {
  dispose(): void;
}

export interface DiagnosticsProviderReadLimits {
  readonly items: number;
  readonly relatedInformation: number;
}

export interface LanguageHostOpenDocuments extends Iterable<EditorHostDocument> {
  readonly availableCount: number;
  readonly omittedCount: number;
}

/**
 * Narrow, VS Code-free surface required by diagnostics, hover, and signature help.
 * Provider payloads intentionally remain `unknown`: extensions and language servers
 * are outside this service's trust boundary and are normalized by the pure service.
 */
export interface LanguageToolHost {
  openDocuments(): LanguageHostOpenDocuments;
  statFile(canonicalPath: string): Promise<EditorHostFileStat>;
  openTextDocument(uri: string): Promise<EditorHostDocument>;
  onDocumentChanged(listener: (uri: string) => void): LanguageHostDisposable;

  diagnostics(
    uri: string,
    limits: DiagnosticsProviderReadLimits,
  ): BoundedProviderItems<unknown>;
  onDiagnosticsChanged(
    listener: (uris: BoundedProviderItems<string>) => void,
  ): LanguageHostDisposable;

  provideHover(
    uri: string,
    position: Position,
  ): Promise<BoundedProviderItems<unknown> | undefined>;
  provideSignatureHelp(
    uri: string,
    position: Position,
    triggerCharacter: string | undefined,
  ): Promise<unknown>;
}
