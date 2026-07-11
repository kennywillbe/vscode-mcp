import process from 'node:process';
import { realpath, stat } from 'node:fs/promises';

import {
  PROVIDER_OUTPUT_LIMITS,
  TOOL_LIMITS,
  V02_READ_TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import * as vscode from 'vscode';

import { EditorToolService } from './editor-tool-service.js';
import { BoundedReadScheduler } from './bounded-read-scheduler.js';
import type {
  EditorHostDocument,
  EditorHostIterable,
  EditorHostRange,
  EditorHostSelection,
  EditorHostTab,
  EditorHostTabSource,
  EditorHostView,
  EditorToolHost,
  EditorToolWorkspaceAccess,
} from './editor-tool-host.js';
import { saturatingAddProviderCounts } from './provider-output-bounds.js';
import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import type { WorkspaceDiscoveryCursorCodec } from './workspace-discovery-cursor.js';
import { WorkspaceDocumentBatchService } from './workspace-document-batch-service.js';
import { WorkspaceFileDiscoveryService } from './workspace-file-discovery-service.js';
import { createWorkspaceIdentity } from './workspace-identity.js';
import { VsCodeWorkspaceFileDiscoveryHost } from './vscode-workspace-file-discovery-adapter.js';
import { VsCodeWorkspaceTextSearchHost } from './vscode-workspace-text-search-adapter.js';
import { WorkspaceTextSearchService } from './workspace-text-search-service.js';

export interface VsCodeEditorToolServiceOptions {
  readonly isWorkspaceEnabled: (
    workspaceFingerprint: string,
  ) => boolean | PromiseLike<boolean>;
  readonly now?: () => Date;
}

export interface VsCodeWorkspaceDocumentBatchServiceOptions extends VsCodeEditorToolServiceOptions {
  readonly instanceId: string;
}

export interface VsCodeWorkspaceTextSearchServiceOptions extends VsCodeEditorToolServiceOptions {
  readonly instanceId: string;
  readonly cursorCodec: WorkspaceDiscoveryCursorCodec;
}

export type VsCodeWorkspaceFileDiscoveryServiceOptions =
  VsCodeWorkspaceTextSearchServiceOptions;

/** Creates the production VS Code adapter while leaving lifecycle ownership to main. */
export function createVsCodeEditorToolService(
  options: VsCodeEditorToolServiceOptions,
): EditorToolService {
  const serviceOptions = {
    host: new VsCodeEditorToolHost(),
    getWorkspaceAccess: () => currentWorkspaceAccess(options.isWorkspaceEnabled),
    realpath,
    pathStrategy: createWorkspaceAuthorizationPathStrategy(
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return new EditorToolService(serviceOptions);
}

/** Creates the unregistered v0.2 batch reader over the same audited host seam. */
export function createVsCodeWorkspaceDocumentBatchService(
  options: VsCodeWorkspaceDocumentBatchServiceOptions,
): WorkspaceDocumentBatchService {
  return new WorkspaceDocumentBatchService({
    instanceId: options.instanceId,
    host: new VsCodeEditorToolHost(),
    getWorkspaceAccess: () => currentWorkspaceAccess(options.isWorkspaceEnabled),
    realpath,
    pathStrategy: createWorkspaceAuthorizationPathStrategy(
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function createVsCodeWorkspaceFileDiscoveryService(
  options: VsCodeWorkspaceFileDiscoveryServiceOptions,
): WorkspaceFileDiscoveryService {
  return new WorkspaceFileDiscoveryService({
    instanceId: options.instanceId,
    cursorCodec: options.cursorCodec,
    host: new VsCodeWorkspaceFileDiscoveryHost(),
    getWorkspaceAccess: () => currentWorkspaceAccess(options.isWorkspaceEnabled),
    pathStrategy: createWorkspaceAuthorizationPathStrategy(
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** Creates one unregistered scanner with a per-window shared closed-read ceiling. */
export function createVsCodeWorkspaceTextSearchService(
  options: VsCodeWorkspaceTextSearchServiceOptions,
): WorkspaceTextSearchService {
  return new WorkspaceTextSearchService({
    instanceId: options.instanceId,
    cursorCodec: options.cursorCodec,
    host: new VsCodeWorkspaceTextSearchHost(),
    scheduler: new BoundedReadScheduler(
      V02_READ_TOOL_LIMITS.searchWorkspaceText.concurrentClosedFileReadsPerWindow,
    ),
    getWorkspaceAccess: () => currentWorkspaceAccess(options.isWorkspaceEnabled),
    pathStrategy: createWorkspaceAuthorizationPathStrategy(
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

class VsCodeEditorToolHost implements EditorToolHost {
  public activeEditor(): EditorHostView | null {
    const editor = vscode.window.activeTextEditor;
    return editor === undefined ? null : wrapEditor(editor);
  }

  public visibleEditors(): EditorHostIterable<EditorHostView> {
    return boundedEditorIterable(vscode.window.visibleTextEditors, wrapEditor);
  }

  public openDocuments(): EditorHostIterable<EditorHostDocument> {
    return boundedEditorIterable(vscode.workspace.textDocuments, wrapDocument);
  }

  public tabs(): EditorHostTabSource {
    const groups = vscode.window.tabGroups.all;
    let totalTabs = 0;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      totalTabs = saturatingAddProviderCounts(
        totalTabs,
        groups[groupIndex]?.tabs.length ?? 0,
      );
    }
    const maximumTabs = PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax;
    const availableTabs = Math.min(totalTabs, maximumTabs);

    return {
      omittedCount: totalTabs - availableTabs,
      async *[Symbol.asyncIterator](): AsyncIterator<EditorHostTab> {
        let yieldedTabs = 0;
        for (
          let groupIndex = 0;
          groupIndex < groups.length && yieldedTabs < availableTabs;
          groupIndex += 1
        ) {
          const group = groups[groupIndex];
          if (group === undefined) {
            continue;
          }
          for (
            let tabIndex = 0;
            tabIndex < group.tabs.length && yieldedTabs < availableTabs;
            tabIndex += 1
          ) {
            const tab = group.tabs[tabIndex];
            if (tab === undefined) {
              continue;
            }
            yieldedTabs += 1;
            let document: vscode.TextDocument | undefined;
            if (tab.input instanceof vscode.TabInputText) {
              try {
                // Resolve one text tab at a time without materializing every document.
                document = await vscode.workspace.openTextDocument(tab.input.uri);
              } catch {
                document = undefined;
              }
            }
            yield {
              groupIndex,
              active: tab.isActive,
              pinned: tab.isPinned,
              preview: tab.isPreview,
              dirty: tab.isDirty,
              document: document === undefined ? null : wrapDocument(document),
            };
          }
        }
      },
    };
  }

  public async statFile(canonicalPath: string): Promise<{
    readonly size: number;
    readonly isFile: boolean;
  }> {
    const fileStat = await stat(canonicalPath);
    return { size: fileStat.size, isFile: fileStat.isFile() };
  }

  public async openTextDocument(uri: string): Promise<EditorHostDocument> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(uri, true),
    );
    return wrapDocument(document);
  }
}

function boundedEditorIterable<Input, Output>(
  source: readonly Input[],
  mapper: (value: Input) => Output,
): EditorHostIterable<Output> {
  const maximumItems = PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax;
  const availableCount = Math.min(source.length, maximumItems);
  return {
    omittedCount: source.length - availableCount,
    *[Symbol.iterator](): Iterator<Output> {
      for (let index = 0; index < availableCount; index += 1) {
        const value = source[index];
        if (value !== undefined) {
          yield mapper(value);
        }
      }
    },
  };
}

async function currentWorkspaceAccess(
  isWorkspaceEnabled: VsCodeEditorToolServiceOptions['isWorkspaceEnabled'],
): Promise<EditorToolWorkspaceAccess> {
  if (
    !vscode.workspace.isTrusted ||
    vscode.env.remoteName !== undefined ||
    vscode.env.uiKind !== vscode.UIKind.Desktop ||
    process.env['SNAP'] !== undefined ||
    process.env['FLATPAK_ID'] !== undefined
  ) {
    return { eligible: false };
  }

  const folders = vscode.workspace.workspaceFolders;
  if (
    folders === undefined ||
    folders.length === 0 ||
    folders.some((folder) => folder.uri.scheme !== 'file')
  ) {
    return { eligible: false };
  }

  const identity = await createWorkspaceIdentity({
    displayName: vscode.workspace.name ?? folders[0]?.name ?? 'workspace',
    workspaceFileUri:
      vscode.workspace.workspaceFile?.scheme === 'file'
        ? vscode.workspace.workspaceFile.toString()
        : null,
    folders: folders.map((folder) => ({
      name: folder.name,
      uri: folder.uri.toString(),
      fsPath: folder.uri.fsPath,
    })),
  });
  return (await isWorkspaceEnabled(identity.fingerprint))
    ? { eligible: true, identity }
    : { eligible: false };
}

function wrapEditor(editor: vscode.TextEditor): EditorHostView {
  const selections: EditorHostSelection[] = [];
  const selectionMaximum = TOOL_LIMITS.editorContext.selectionsPerEditor;
  for (
    let index = 0;
    index < editor.selections.length && index < selectionMaximum;
    index += 1
  ) {
    const selection = editor.selections[index];
    if (selection !== undefined) {
      selections.push(wrapSelection(selection));
    }
  }

  const visibleRanges: EditorHostRange[] = [];
  const rangeMaximum = TOOL_LIMITS.editorContext.visibleRangesPerEditor;
  for (
    let index = 0;
    index < editor.visibleRanges.length && index < rangeMaximum;
    index += 1
  ) {
    const range = editor.visibleRanges[index];
    if (range !== undefined) {
      visibleRanges.push(wrapRange(range));
    }
  }

  return {
    document: wrapDocument(editor.document),
    selections,
    visibleRanges,
    omittedSelections: Math.max(0, editor.selections.length - selections.length),
    omittedVisibleRanges: Math.max(
      0,
      editor.visibleRanges.length - visibleRanges.length,
    ),
  };
}

function wrapDocument(document: vscode.TextDocument): EditorHostDocument {
  return {
    get uri(): string {
      return document.uri.toString();
    },
    get languageId(): string {
      return document.languageId;
    },
    get version(): number {
      return document.version;
    },
    get isDirty(): boolean {
      return document.isDirty;
    },
    get lineCount(): number {
      return document.lineCount;
    },
    get eol(): 'LF' | 'CRLF' {
      return document.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF';
    },
    lineText(line: number): string {
      return document.lineAt(line).text;
    },
  };
}

function wrapSelection(selection: vscode.Selection): EditorHostSelection {
  return {
    anchor: wrapPosition(selection.anchor),
    active: wrapPosition(selection.active),
    start: wrapPosition(selection.start),
    end: wrapPosition(selection.end),
  };
}

function wrapRange(range: vscode.Range): EditorHostRange {
  return {
    start: wrapPosition(range.start),
    end: wrapPosition(range.end),
  };
}

function wrapPosition(position: vscode.Position): {
  readonly line: number;
  readonly character: number;
} {
  return { line: position.line, character: position.character };
}
