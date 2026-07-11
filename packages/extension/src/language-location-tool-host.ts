import type { GetDefinitionArguments } from '@vscode-mcp/protocol/tool-schemas';

import type { WorkspaceIdentity } from './workspace-identity.js';
import type { BoundedProviderItems } from './provider-output-bounds.js';

export type LanguageDefinitionKind = Exclude<GetDefinitionArguments['kind'], undefined>;

export interface LanguageHostPosition {
  readonly line: number;
  readonly character: number;
}

export interface LanguageHostRange {
  readonly start: LanguageHostPosition;
  readonly end: LanguageHostPosition;
}

export interface LanguageHostDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly lineCount: number;
  readonly eol: 'LF' | 'CRLF';
  lineText(line: number): string;
}

export interface LanguageHostFileStat {
  readonly size: number;
  readonly isFile: boolean;
}

export interface LanguageHostLocation {
  readonly shape: 'location';
  readonly uri: string;
  readonly range: LanguageHostRange;
}

export interface LanguageHostLocationLink {
  readonly shape: 'locationLink';
  readonly targetUri: string;
  readonly targetRange: LanguageHostRange;
  readonly targetSelectionRange: LanguageHostRange;
  readonly originSelectionRange: LanguageHostRange | null;
}

export type LanguageHostDefinitionTarget =
  LanguageHostLocation | LanguageHostLocationLink;

export interface LanguageHostReference {
  readonly uri: string;
  readonly range: LanguageHostRange;
}

export interface LanguageHostHierarchicalSymbol {
  readonly name: string;
  readonly detail: string;
  readonly kind: string;
  readonly range: LanguageHostRange;
  readonly selectionRange: LanguageHostRange;
  readonly deprecated: boolean;
  readonly children: readonly (LanguageHostHierarchicalSymbol | null)[];
}

export interface LanguageHostFlatSymbol {
  readonly name: string;
  readonly kind: string;
  readonly containerName: string;
  readonly uri: string;
  readonly range: LanguageHostRange;
  readonly deprecated: boolean;
}

export type LanguageHostDocumentSymbols =
  | {
      readonly state: 'noResult';
    }
  | {
      readonly state: 'result';
      readonly shape: 'hierarchical';
      readonly items: readonly (LanguageHostHierarchicalSymbol | null)[];
      readonly omittedCount: number;
    }
  | {
      readonly state: 'result';
      readonly shape: 'flat';
      readonly items: readonly (LanguageHostFlatSymbol | null)[];
      readonly omittedCount: number;
    };

export interface LanguageHostWorkspaceSymbol {
  readonly name: string;
  readonly kind: string;
  readonly containerName: string;
  readonly uri: string;
  readonly range: LanguageHostRange;
}

export interface LanguageHostCallItem {
  readonly name: string;
  readonly detail: string;
  readonly kind: string;
  readonly uri: string;
  readonly range: LanguageHostRange;
  readonly selectionRange: LanguageHostRange;
  /** Opaque provider value. It is accepted only from the fixed prepare command. */
  readonly providerHandle: unknown;
}

export interface LanguageHostIncomingCall {
  readonly from: LanguageHostCallItem;
  readonly callSiteRanges: readonly (LanguageHostRange | null)[];
}

export interface LanguageHostOutgoingCall {
  readonly to: LanguageHostCallItem;
  readonly callSiteRanges: readonly (LanguageHostRange | null)[];
}

export type LanguageHostProviderBatch<Item> =
  | { readonly state: 'noResult' }
  | ({ readonly state: 'result' } & BoundedProviderItems<Item | null>);

/**
 * Minimal runtime-free language-provider surface. Production is the only layer that
 * knows command identifiers; the service receives typed operations, never a command.
 */
export interface LanguageLocationToolHost {
  openDocuments(): Iterable<LanguageHostDocument>;
  statFile(canonicalPath: string): Promise<LanguageHostFileStat>;
  openTextDocument(uri: string): Promise<LanguageHostDocument>;
  provideDefinition(
    kind: LanguageDefinitionKind,
    uri: string,
    position: LanguageHostPosition,
  ): Promise<LanguageHostProviderBatch<LanguageHostDefinitionTarget>>;
  provideReferences(
    uri: string,
    position: LanguageHostPosition,
  ): Promise<LanguageHostProviderBatch<LanguageHostReference>>;
  provideDocumentSymbols(uri: string): Promise<LanguageHostDocumentSymbols>;
  provideWorkspaceSymbols(
    query: string,
  ): Promise<LanguageHostProviderBatch<LanguageHostWorkspaceSymbol>>;
  prepareCallHierarchy(
    uri: string,
    position: LanguageHostPosition,
  ): Promise<LanguageHostProviderBatch<LanguageHostCallItem>>;
  provideIncomingCalls(
    item: LanguageHostCallItem,
  ): Promise<LanguageHostProviderBatch<LanguageHostIncomingCall>>;
  provideOutgoingCalls(
    item: LanguageHostCallItem,
  ): Promise<LanguageHostProviderBatch<LanguageHostOutgoingCall>>;
}

export type LanguageLocationWorkspaceAccess =
  | { readonly eligible: true; readonly identity: WorkspaceIdentity }
  | { readonly eligible: false };

/** Signals a positively known absence, rather than a provider returning no result. */
export class LanguageProviderUnavailableError extends Error {
  public constructor() {
    super('The requested language provider is unavailable.');
    this.name = 'LanguageProviderUnavailableError';
  }
}
