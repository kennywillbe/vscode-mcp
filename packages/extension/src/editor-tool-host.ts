import type { WorkspaceIdentity } from './workspace-identity.js';

/**
 * Minimal editor-host surface used by the read-only editor tools. Keeping this
 * interface free of `vscode` lets the authorization and truncation rules run in
 * ordinary Node unit tests.
 */
export interface EditorHostPosition {
  readonly line: number;
  readonly character: number;
}

export interface EditorHostRange {
  readonly start: EditorHostPosition;
  readonly end: EditorHostPosition;
}

export interface EditorHostSelection extends EditorHostRange {
  readonly anchor: EditorHostPosition;
  readonly active: EditorHostPosition;
}

export interface EditorHostDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly lineCount: number;
  readonly eol: 'LF' | 'CRLF';
  lineText(line: number): string;
}

export interface EditorHostView {
  readonly document: EditorHostDocument;
  readonly selections: readonly EditorHostSelection[];
  readonly visibleRanges: readonly EditorHostRange[];
  /** Entries omitted by the production adapter before wrapper allocation. */
  readonly omittedSelections?: number;
  /** Entries omitted by the production adapter before wrapper allocation. */
  readonly omittedVisibleRanges?: number;
}

export interface EditorHostTab {
  readonly groupIndex: number;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly preview: boolean;
  readonly dirty: boolean;
  /** Null for non-text tabs and text tabs without an accessible live document. */
  readonly document: EditorHostDocument | null;
}

export interface EditorHostFileStat {
  readonly size: number;
  readonly isFile: boolean;
}

export interface EditorHostIterable<Value> extends Iterable<Value> {
  /** Items the adapter did not expose because its raw-source scan budget was reached. */
  readonly omittedCount?: number;
}

export type EditorHostTabSource = (
  Iterable<EditorHostTab> | AsyncIterable<EditorHostTab>
) & {
  /** Tabs the adapter did not expose because its raw-source scan budget was reached. */
  readonly omittedCount?: number;
};

export interface EditorToolHost {
  activeEditor(): EditorHostView | null;
  /** Implementations should wrap host collections lazily rather than copying them. */
  visibleEditors(): EditorHostIterable<EditorHostView>;
  /** Implementations should wrap host collections lazily rather than copying them. */
  openDocuments(): EditorHostIterable<EditorHostDocument>;
  /** Async iteration lets production resolve one text tab at a time. */
  tabs(): EditorHostTabSource;
  statFile(canonicalPath: string): Promise<EditorHostFileStat>;
  openTextDocument(uri: string): Promise<EditorHostDocument>;
}

export type EditorToolWorkspaceAccess =
  | {
      readonly eligible: true;
      readonly identity: WorkspaceIdentity;
    }
  | {
      readonly eligible: false;
    };
