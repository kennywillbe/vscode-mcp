import * as vscode from 'vscode';

import {
  projectVisualTextChanges,
  type ProjectedVisualTextChange,
  type VisualTextChangeKind,
} from './visual-change-model.js';
import {
  documentUtf16Length,
  readDocumentTextWithinLimit,
} from './bounded-document-text.js';

const MAX_TRACKED_FILES = 200;
const MAX_TRACKED_CHANGES = 4_096;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const CONFIGURATION_SECTION = 'vscodeMcp.changeHighlights';
const SNAPSHOT_SCHEME = 'vscode-mcp-change';

export type VisualChangeTool =
  | 'apply_text_edits'
  | 'create_workspace_file'
  | 'move_workspace_file'
  | 'delete_workspace_file'
  | 'revert_documents'
  | 'rename_symbol'
  | 'format_document'
  | 'apply_code_action';

type FileChangeKind = 'text' | 'created' | 'moved' | 'deleted';

interface StoredTextChange {
  readonly kind: VisualTextChangeKind;
  readonly range: vscode.Range;
}

interface StoredFileChange {
  readonly uri: vscode.Uri;
  readonly tool: VisualChangeTool;
  readonly fileKind: FileChangeKind;
  readonly sequence: number;
  readonly changes: readonly StoredTextChange[];
  readonly beforeUri: vscode.Uri | null;
  readonly modifiedUri: vscode.Uri;
}

interface PreparedDocumentChange {
  readonly uri: vscode.Uri;
  readonly versionBefore: number;
  readonly textBefore?: string;
  readonly changes: readonly ProjectedVisualTextChange[];
}

export interface PreparedVisualChange {
  readonly tool: VisualChangeTool;
  readonly documents: readonly PreparedDocumentChange[];
}

interface NavigationTarget {
  readonly record: StoredFileChange;
  readonly change: StoredTextChange | null;
}

export interface VisualChangeSummary {
  readonly files: number;
  readonly changes: number;
}

export class VisualChangeController
  implements vscode.Disposable, vscode.FileDecorationProvider
{
  readonly #records = new Map<string, StoredFileChange>();
  readonly #armedDocumentVersions = new Map<string, number>();
  readonly #snapshots = new Map<
    string,
    { readonly text: string; readonly bytes: number }
  >();
  readonly #fileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly #addedDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('vscodeMcp.changeHighlight.addedBackground'),
    borderColor: new vscode.ThemeColor('vscodeMcp.changeHighlight.addedBorder'),
    borderStyle: 'solid',
    borderWidth: '0 0 1px 0',
    overviewRulerColor: new vscode.ThemeColor(
      'vscodeMcp.changeHighlight.addedOverviewRuler',
    ),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  readonly #modifiedDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(
      'vscodeMcp.changeHighlight.modifiedBackground',
    ),
    borderColor: new vscode.ThemeColor('vscodeMcp.changeHighlight.modifiedBorder'),
    borderStyle: 'solid',
    borderWidth: '0 0 1px 0',
    overviewRulerColor: new vscode.ThemeColor(
      'vscodeMcp.changeHighlight.modifiedOverviewRuler',
    ),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  readonly #deletedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor(
      'vscodeMcp.changeHighlight.deletedBackground',
    ),
    overviewRulerColor: new vscode.ThemeColor(
      'vscodeMcp.changeHighlight.deletedOverviewRuler',
    ),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      contentText: '− ',
      color: new vscode.ThemeColor('vscodeMcp.changeHighlight.deletedBorder'),
      fontWeight: 'bold',
    },
  });
  readonly #fileOperationDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor(
      'vscodeMcp.changeHighlight.fileOperationBackground',
    ),
    overviewRulerColor: new vscode.ThemeColor(
      'vscodeMcp.changeHighlight.modifiedOverviewRuler',
    ),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  readonly #statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    9,
  );
  readonly #disposables: vscode.Disposable[];
  #sequence = 0;
  #navigationCursor = -1;
  #disposed = false;

  public readonly onDidChangeFileDecorations = this.#fileDecorations.event;

  public constructor() {
    this.#statusBar.name = 'VS Code MCP changes';
    this.#statusBar.command = 'vscode-mcp.reviewChanges';
    this.#disposables = [
      this.#addedDecoration,
      this.#modifiedDecoration,
      this.#deletedDecoration,
      this.#fileOperationDecoration,
      this.#statusBar,
      this.#fileDecorations,
      vscode.window.registerFileDecorationProvider(this),
      vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, {
        provideTextDocumentContent: (uri) => this.#snapshots.get(uri.toString())?.text,
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderVisibleEditors()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length === 0) return;
        const key = event.document.uri.toString();
        const armedVersion = this.#armedDocumentVersions.get(key);
        if (armedVersion !== undefined && event.document.version > armedVersion) {
          this.#armedDocumentVersions.delete(key);
          return;
        }
        this.clearUri(event.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.clearUri(document.uri);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIGURATION_SECTION)) this.refreshUi();
      }),
    ];
    this.updateStatusBar();
  }

  public prepareWorkspaceEdit(
    tool: VisualChangeTool,
    edit: vscode.WorkspaceEdit,
    documents: readonly vscode.TextDocument[],
  ): PreparedVisualChange {
    const byUri = new Map(
      documents.map((document) => [document.uri.toString(), document] as const),
    );
    const prepared: PreparedDocumentChange[] = [];
    let preparedSnapshotBytes = 0;
    for (const [uri, edits] of edit.entries()) {
      const document = byUri.get(uri.toString());
      if (document === undefined || edits.length === 0) continue;
      const availableSnapshotBytes = Math.min(
        MAX_SNAPSHOT_BYTES,
        MAX_TOTAL_SNAPSHOT_BYTES - this.snapshotBytes() - preparedSnapshotBytes,
      );
      const textBefore = readDocumentTextWithinLimit(document, availableSnapshotBytes);
      if (textBefore !== undefined) {
        preparedSnapshotBytes += Buffer.byteLength(textBefore, 'utf8');
      }
      prepared.push({
        uri,
        versionBefore: document.version,
        ...(textBefore === undefined ? {} : { textBefore }),
        changes: projectVisualTextChanges(
          edits.map((textEdit) => ({
            startOffset: document.offsetAt(textEdit.range.start),
            endOffset: document.offsetAt(textEdit.range.end),
            newTextLength: textEdit.newText.length,
          })),
        ),
      });
    }
    return { tool, documents: prepared };
  }

  public armPrepared(prepared: PreparedVisualChange): void {
    for (const item of prepared.documents) {
      if (item.changes.length > 0) {
        this.#armedDocumentVersions.set(item.uri.toString(), item.versionBefore);
      }
    }
  }

  public cancelPrepared(prepared: PreparedVisualChange): void {
    for (const item of prepared.documents) {
      this.#armedDocumentVersions.delete(item.uri.toString());
    }
  }

  public commitPrepared(prepared: PreparedVisualChange): void {
    for (const item of prepared.documents) {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === item.uri.toString(),
      );
      if (document === undefined) continue;
      const maximum = documentUtf16Length(document);
      const changes = item.changes.map((change) => {
        const start = document.positionAt(Math.min(change.startOffset, maximum));
        const end = document.positionAt(Math.min(change.endOffset, maximum));
        return { kind: change.kind, range: new vscode.Range(start, end) };
      });
      this.store({
        uri: item.uri,
        tool: prepared.tool,
        fileKind: 'text',
        changes,
        ...(item.textBefore === undefined ? {} : { beforeText: item.textBefore }),
      });
    }
  }

  public recordWholeDocument(
    tool: Extract<VisualChangeTool, 'create_workspace_file'>,
    document: vscode.TextDocument,
    kind: Extract<FileChangeKind, 'created' | 'text'>,
  ): void {
    const end = document.positionAt(document.getText().length);
    this.store({
      uri: document.uri,
      tool,
      fileKind: kind,
      changes:
        end.line === 0 && end.character === 0
          ? []
          : [
              {
                kind: kind === 'created' ? 'added' : 'modified',
                range: document.validateRange(
                  new vscode.Range(0, 0, end.line, end.character),
                ),
              },
            ],
      beforeText: '',
    });
  }

  public recordFileOperation(
    tool: Extract<VisualChangeTool, 'move_workspace_file' | 'delete_workspace_file'>,
    uri: vscode.Uri,
    kind: Extract<FileChangeKind, 'moved' | 'deleted'>,
    beforeText?: string,
  ): void {
    this.store({
      uri,
      tool,
      fileKind: kind,
      changes: [],
      ...(beforeText === undefined ? {} : { beforeText }),
    });
  }

  public recordMove(
    source: vscode.Uri,
    destination: vscode.Uri,
    beforeText?: string,
  ): void {
    const sourceRecord = this.#records.get(source.toString());
    if (sourceRecord !== undefined) this.#records.delete(source.toString());
    this.store({
      uri: destination,
      tool: 'move_workspace_file',
      fileKind: 'moved',
      changes: [],
      ...(beforeText === undefined ? {} : { beforeText }),
      ...(sourceRecord === undefined ? {} : { beforeUri: sourceRecord.beforeUri }),
    });
    if (sourceRecord !== undefined) {
      this.releaseSnapshot(sourceRecord.modifiedUri, sourceRecord.beforeUri);
    }
    this.#fileDecorations.fire([source, destination]);
  }

  public clearAll(): void {
    if (this.#records.size === 0) return;
    const uris = [...this.#records.values()].map((record) => record.uri);
    for (const record of this.#records.values()) this.releaseRecord(record);
    this.#records.clear();
    this.#navigationCursor = -1;
    this.refreshUi(uris);
  }

  public clearActiveFile(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri !== undefined) this.clearUri(uri);
  }

  public summary(): VisualChangeSummary {
    return {
      files: this.#records.size,
      changes: [...this.#records.values()].reduce(
        (total, record) => total + Math.max(1, record.changes.length),
        0,
      ),
    };
  }

  public async reviewChanges(): Promise<void> {
    const records = this.orderedRecords();
    if (records.length === 0) {
      void vscode.window.showInformationMessage(
        'VS Code MCP has no highlighted changes in this listener session.',
      );
      return;
    }
    const comparable = records.filter(
      (record): record is StoredFileChange & { readonly beforeUri: vscode.Uri } =>
        record.beforeUri !== null,
    );
    if (comparable.length === 0) {
      await this.navigateTo(records[0]!, null);
      void vscode.window.showWarningMessage(
        'VS Code MCP could not retain a bounded before-snapshot for this change.',
      );
      return;
    }
    if (comparable.length === 1) {
      const record = comparable[0]!;
      await vscode.commands.executeCommand(
        'vscode.diff',
        record.beforeUri,
        record.modifiedUri,
        diffTitle(record),
        { preview: false, preserveFocus: false },
      );
    } else {
      await vscode.commands.executeCommand(
        'vscode.changes',
        'VS Code MCP Changes',
        comparable.map((record) => [record.uri, record.beforeUri, record.modifiedUri]),
      );
    }
    if (comparable.length !== records.length) {
      void vscode.window.showWarningMessage(
        `${records.length - comparable.length} oversized VS Code MCP change${records.length - comparable.length === 1 ? '' : 's'} could not be included in the bounded diff snapshot.`,
      );
    }
  }

  public async nextChange(direction: 1 | -1): Promise<void> {
    const targets = this.navigationTargets();
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(
        'VS Code MCP has no highlighted changes in this listener session.',
      );
      return;
    }
    this.#navigationCursor =
      (this.#navigationCursor + direction + targets.length) % targets.length;
    const target = targets[this.#navigationCursor];
    if (target !== undefined) await this.navigateTo(target.record, target.change);
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const configuration = this.configuration();
    if (!configuration.enabled || !configuration.showExplorerBadges) return undefined;
    const record = this.#records.get(uri.toString());
    if (record === undefined || record.fileKind === 'deleted') return undefined;
    return new vscode.FileDecoration(
      record.fileKind === 'created' ? 'A' : 'M',
      `Changed by VS Code MCP via ${record.tool}`,
      new vscode.ThemeColor(
        record.fileKind === 'created'
          ? 'vscodeMcp.changeHighlight.addedBorder'
          : 'vscodeMcp.changeHighlight.modifiedBorder',
      ),
    );
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#records.clear();
    this.#armedDocumentVersions.clear();
    this.#snapshots.clear();
    for (const disposable of this.#disposables) disposable.dispose();
  }

  private store(
    input: Omit<StoredFileChange, 'sequence' | 'beforeUri' | 'modifiedUri'> & {
      readonly beforeText?: string;
      readonly beforeUri?: vscode.Uri | null;
    },
  ): void {
    const key = input.uri.toString();
    const existing = this.#records.get(key);
    if (existing !== undefined) this.#records.delete(key);
    const beforeUri =
      input.beforeUri !== undefined
        ? input.beforeUri
        : (existing?.beforeUri ??
          this.createSnapshot(input.uri, 'before', input.beforeText));
    const modifiedUri =
      input.fileKind === 'deleted'
        ? this.createSnapshot(input.uri, 'after', '')
        : input.uri;
    this.#records.set(key, {
      uri: input.uri,
      tool: input.tool,
      fileKind: input.fileKind,
      changes: input.changes,
      sequence: ++this.#sequence,
      beforeUri,
      modifiedUri: modifiedUri ?? input.uri,
    });
    if (existing !== undefined) {
      this.releaseSnapshot(existing.beforeUri, beforeUri);
      this.releaseSnapshot(existing.modifiedUri, modifiedUri);
    }
    const evicted = this.enforceLimits();
    this.#navigationCursor = -1;
    this.refreshUi([input.uri, ...evicted]);
  }

  private enforceLimits(): readonly vscode.Uri[] {
    const evicted: vscode.Uri[] = [];
    const changeCount = (): number =>
      [...this.#records.values()].reduce(
        (total, record) => total + Math.max(1, record.changes.length),
        0,
      );
    while (
      this.#records.size > MAX_TRACKED_FILES ||
      changeCount() > MAX_TRACKED_CHANGES
    ) {
      const oldest = this.#records.keys().next().value;
      if (oldest === undefined) break;
      const record = this.#records.get(oldest);
      if (record !== undefined) {
        evicted.push(record.uri);
        this.releaseRecord(record);
      }
      this.#records.delete(oldest);
    }
    return evicted;
  }

  private clearUri(uri: vscode.Uri): void {
    const record = this.#records.get(uri.toString());
    if (record === undefined) return;
    this.#records.delete(uri.toString());
    this.releaseRecord(record);
    this.#navigationCursor = -1;
    this.refreshUi([uri]);
  }

  private createSnapshot(
    source: vscode.Uri,
    side: 'before' | 'after',
    text: string | undefined,
  ): vscode.Uri | null {
    if (text === undefined) return null;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (
      bytes > MAX_SNAPSHOT_BYTES ||
      this.snapshotBytes() + bytes > MAX_TOTAL_SNAPSHOT_BYTES
    )
      return null;
    const extension = source.path.match(/(\.[^./]+)$/)?.[1] ?? '.txt';
    const uri = vscode.Uri.from({
      scheme: SNAPSHOT_SCHEME,
      path: `/snapshot/${++this.#sequence}-${side}${extension}`,
    });
    this.#snapshots.set(uri.toString(), { text, bytes });
    return uri;
  }

  private snapshotBytes(): number {
    let bytes = 0;
    for (const snapshot of this.#snapshots.values()) bytes += snapshot.bytes;
    return bytes;
  }

  private releaseRecord(record: StoredFileChange): void {
    this.releaseSnapshot(record.beforeUri);
    this.releaseSnapshot(record.modifiedUri);
  }

  private releaseSnapshot(uri: vscode.Uri | null, preserved?: vscode.Uri | null): void {
    if (
      uri !== null &&
      uri.scheme === SNAPSHOT_SCHEME &&
      uri.toString() !== preserved?.toString()
    ) {
      this.#snapshots.delete(uri.toString());
    }
  }

  private refreshUi(changedUris?: readonly vscode.Uri[]): void {
    this.renderVisibleEditors();
    this.updateStatusBar();
    this.#fileDecorations.fire(
      changedUris === undefined ? undefined : [...changedUris],
    );
  }

  private renderVisibleEditors(): void {
    const enabled = this.configuration().enabled;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.#addedDecoration, []);
      editor.setDecorations(this.#modifiedDecoration, []);
      editor.setDecorations(this.#deletedDecoration, []);
      editor.setDecorations(this.#fileOperationDecoration, []);
      if (!enabled) continue;
      const record = this.#records.get(editor.document.uri.toString());
      if (record === undefined) continue;
      const additions: vscode.DecorationOptions[] = [];
      const modifications: vscode.DecorationOptions[] = [];
      const deletions: vscode.DecorationOptions[] = [];
      for (const change of record.changes) {
        const option = {
          range:
            change.kind === 'deleted'
              ? deletionLineRange(editor.document, change.range.start)
              : change.range,
          hoverMessage: hoverMessage(record.tool, change.kind),
        };
        if (change.kind === 'added') additions.push(option);
        else if (change.kind === 'modified') modifications.push(option);
        else deletions.push(option);
      }
      editor.setDecorations(this.#addedDecoration, additions);
      editor.setDecorations(this.#modifiedDecoration, modifications);
      editor.setDecorations(this.#deletedDecoration, deletions);
      if (record.changes.length === 0 && record.fileKind !== 'deleted') {
        editor.setDecorations(this.#fileOperationDecoration, [
          {
            range: deletionLineRange(editor.document, new vscode.Position(0, 0)),
            hoverMessage: hoverMessage(record.tool, record.fileKind),
          },
        ]);
      }
    }
  }

  private updateStatusBar(): void {
    const config = this.configuration();
    const summary = this.summary();
    if (!config.enabled || !config.showStatusBar || summary.files === 0) {
      this.#statusBar.hide();
      return;
    }
    this.#statusBar.text = `$(diff) MCP: ${summary.files} changed`;
    this.#statusBar.tooltip = `${summary.changes} highlighted VS Code MCP change${summary.changes === 1 ? '' : 's'} across ${summary.files} file${summary.files === 1 ? '' : 's'}. Click to review.`;
    this.#statusBar.show();
  }

  private configuration(): {
    readonly enabled: boolean;
    readonly showExplorerBadges: boolean;
    readonly showStatusBar: boolean;
  } {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    return {
      enabled: configuration.get<boolean>('enabled', true),
      showExplorerBadges: configuration.get<boolean>('showExplorerBadges', true),
      showStatusBar: configuration.get<boolean>('showStatusBar', true),
    };
  }

  private orderedRecords(): readonly StoredFileChange[] {
    return [...this.#records.values()].sort(
      (left, right) =>
        right.sequence - left.sequence ||
        left.uri.toString().localeCompare(right.uri.toString()),
    );
  }

  private navigationTargets(): readonly NavigationTarget[] {
    const targets: NavigationTarget[] = [];
    for (const record of this.orderedRecords()) {
      if (record.changes.length === 0) {
        targets.push({ record, change: null });
        continue;
      }
      for (const change of [...record.changes].sort(
        (left, right) =>
          left.range.start.line - right.range.start.line ||
          left.range.start.character - right.range.start.character,
      )) {
        targets.push({ record, change });
      }
    }
    return targets;
  }

  private async navigateTo(
    record: StoredFileChange,
    requested: StoredTextChange | null,
  ): Promise<void> {
    if (record.fileKind === 'deleted') {
      void vscode.window.showInformationMessage(
        `VS Code MCP deleted ${vscode.workspace.asRelativePath(record.uri, true)}.`,
      );
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(record.uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
      });
      const change = requested ?? record.changes[0] ?? null;
      const range =
        change?.kind === 'deleted'
          ? deletionLineRange(document, change.range.start)
          : (change?.range ?? deletionLineRange(document, new vscode.Position(0, 0)));
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      void vscode.window.showWarningMessage(
        'The selected VS Code MCP change is no longer available.',
      );
      this.clearUri(record.uri);
    }
  }
}

function deletionLineRange(
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.Range {
  const line = document.lineAt(Math.min(position.line, document.lineCount - 1));
  return line.rangeIncludingLineBreak;
}

function hoverMessage(
  tool: VisualChangeTool,
  kind: VisualTextChangeKind | FileChangeKind,
): vscode.MarkdownString {
  const message = new vscode.MarkdownString();
  message.appendMarkdown(
    `**VS Code MCP**\n\n${changeKindLabel(kind)} via \`${tool}\`.`,
  );
  message.isTrusted = false;
  return message;
}

function diffTitle(record: StoredFileChange): string {
  return `VS Code MCP: ${vscode.workspace.asRelativePath(record.uri, true)} · ${record.tool}`;
}

function changeKindLabel(kind: VisualTextChangeKind | FileChangeKind): string {
  switch (kind) {
    case 'added':
    case 'created':
      return 'Added content';
    case 'modified':
    case 'text':
      return 'Modified content';
    case 'deleted':
      return 'Deleted content';
    case 'moved':
      return 'Moved file';
  }
}
