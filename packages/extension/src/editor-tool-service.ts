import { Buffer } from 'node:buffer';

import { TOOL_LIMITS } from '@vscode-mcp/protocol/constants';
import {
  IpcCallToolResultSchema,
  type IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas';
import {
  DocumentSnapshotSchema,
  type DocumentSnapshot,
  type ErrorCode,
  type Position,
  type Range,
  type SafeErrorDetails,
} from '@vscode-mcp/protocol/schemas';
import {
  EXTENSION_TOOL_NAMES,
  ExtensionToolInvocationSchema,
  GetEditorContextResultSchema,
  ReadDocumentResultSchema,
  type ExtensionToolName,
  type GetEditorContextArguments,
  type GetEditorContextResult,
  type ReadDocumentArguments,
  type ReadDocumentResult,
  type Warning,
} from '@vscode-mcp/protocol/tool-schemas';

import {
  authorizeWorkspaceDocument,
  type AuthorizedWorkspaceDocument,
  type WorkspaceAuthorizationErrorCode,
  type WorkspaceAuthorizationPathStrategy,
} from './workspace-authorizer.js';
import type {
  EditorHostDocument,
  EditorHostRange,
  EditorHostSelection,
  EditorHostTab,
  EditorHostView,
  EditorToolHost,
  EditorToolWorkspaceAccess,
} from './editor-tool-host.js';
import { saturatingAddProviderCounts } from './provider-output-bounds.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

type EditorState = GetEditorContextResult['visibleEditors'][number];
type EditorTab = GetEditorContextResult['tabs'][number];

export const EDITOR_EXTENSION_TOOL_NAMES = [
  'get_editor_context',
  'read_document',
] as const satisfies readonly ExtensionToolName[];

export interface EditorToolServiceOptions {
  readonly host: EditorToolHost;
  /** Must reflect trust, local-desktop support, and explicit current enablement. */
  readonly getWorkspaceAccess: () =>
    EditorToolWorkspaceAccess | PromiseLike<EditorToolWorkspaceAccess>;
  readonly realpath: (path: string) => Promise<string>;
  readonly pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly now?: () => Date;
}

interface ToolFailureData {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: SafeErrorDetails;
}

class ToolFailure extends Error {
  public constructor(public readonly data: ToolFailureData) {
    super(data.message);
    this.name = 'ToolFailure';
  }
}

interface AuthorizedHostDocument {
  readonly hostDocument: EditorHostDocument;
  readonly authorization: AuthorizedWorkspaceDocument;
}

type ContextEntryResolution<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
      readonly limitOmissions: number;
      readonly unsupportedOmissions: number;
    }
  | {
      readonly ok: false;
      readonly errorCode: WorkspaceAuthorizationErrorCode | 'UNSUPPORTED_DOCUMENT';
    };

/**
 * Implements the Milestone 2 extension tools behind an injected editor-host seam.
 * The handler accepts `unknown` deliberately: IPC already validates requests, but the
 * implementation still treats its own composition boundary as untrusted.
 */
export class EditorToolService {
  readonly #host: EditorToolHost;
  readonly #getWorkspaceAccess: EditorToolServiceOptions['getWorkspaceAccess'];
  readonly #realpath: EditorToolServiceOptions['realpath'];
  readonly #pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly #now: () => Date;

  public constructor(options: EditorToolServiceOptions) {
    this.#host = options.host;
    this.#getWorkspaceAccess = options.getWorkspaceAccess;
    this.#realpath = options.realpath;
    this.#pathStrategy = options.pathStrategy;
    this.#now = options.now ?? (() => new Date());
  }

  public readonly callTool = async (
    untrustedInvocation: unknown,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> => {
    const recognizedTool = recognizeExtensionTool(untrustedInvocation);
    const parsed = ExtensionToolInvocationSchema.safeParse(untrustedInvocation);
    if (!parsed.success) {
      if (recognizedTool === null) {
        throw new Error('The extension tool invocation is not recognized.');
      }
      return toolError(
        recognizedTool,
        failure('INVALID_ARGUMENT', 'The tool arguments are invalid.', false),
      );
    }

    try {
      throwIfCancelled(signal);
      switch (parsed.data.tool) {
        case 'get_editor_context':
          return await this.getEditorContext(parsed.data.arguments, signal);
        case 'read_document':
          return await this.readDocument(parsed.data.arguments, signal);
        default:
          return toolError(
            parsed.data.tool,
            failure(
              'PROVIDER_UNAVAILABLE',
              'The tool provider is not available in this milestone.',
              false,
            ),
          );
      }
    } catch (error) {
      const toolFailure = normalizeFailure(error, signal);
      return toolError(parsed.data.tool, toolFailure);
    }
  };

  private async getEditorContext(
    arguments_: GetEditorContextArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const documentLimit =
      arguments_.documentLimit ?? TOOL_LIMITS.editorContext.documentsDefault;
    const tabLimit = arguments_.tabLimit ?? TOOL_LIMITS.editorContext.tabsDefault;
    const warnings = new WarningAccumulator();

    let omittedEditors = 0;
    let omittedDocuments = 0;
    let omittedTabs = 0;

    let activeEditor: EditorState | null = null;
    const rawActiveEditor = this.#host.activeEditor();
    if (rawActiveEditor !== null) {
      const resolved = await this.resolveEditorState(
        rawActiveEditor,
        access.identity,
        signal,
      );
      if (resolved.ok) {
        activeEditor = resolved.value;
        warnings.addResults(resolved.limitOmissions);
        warnings.addUnsupported(resolved.unsupportedOmissions);
      } else {
        omittedEditors = saturatingAddProviderCounts(omittedEditors, 1);
        warnings.addAuthorization(resolved.errorCode);
      }
    }

    const rawVisibleEditors = this.#host.visibleEditors();
    omittedEditors = hostOmittedCount(rawVisibleEditors.omittedCount);
    warnings.addResults(omittedEditors);
    const visibleEditors: EditorState[] = [];
    for (const rawEditor of rawVisibleEditors) {
      throwIfCancelled(signal);
      const resolved = await this.resolveEditorState(
        rawEditor,
        access.identity,
        signal,
      );
      if (!resolved.ok) {
        omittedEditors = saturatingAddProviderCounts(omittedEditors, 1);
        warnings.addAuthorization(resolved.errorCode);
        continue;
      }
      warnings.addResults(resolved.limitOmissions);
      warnings.addUnsupported(resolved.unsupportedOmissions);
      if (visibleEditors.length < documentLimit) {
        visibleEditors.push(resolved.value);
      } else {
        omittedEditors = saturatingAddProviderCounts(omittedEditors, 1);
        warnings.addResults(1);
      }
    }

    const rawOpenDocuments = this.#host.openDocuments();
    omittedDocuments = hostOmittedCount(rawOpenDocuments.omittedCount);
    warnings.addResults(omittedDocuments);
    const openDocuments: DocumentSnapshot[] = [];
    for (const rawDocument of rawOpenDocuments) {
      throwIfCancelled(signal);
      const resolved = await this.resolveDocumentSnapshot(rawDocument, access.identity);
      if (!resolved.ok) {
        omittedDocuments = saturatingAddProviderCounts(omittedDocuments, 1);
        warnings.addAuthorization(resolved.errorCode);
        continue;
      }
      if (openDocuments.length < documentLimit) {
        openDocuments.push(resolved.value);
      } else {
        omittedDocuments = saturatingAddProviderCounts(omittedDocuments, 1);
        warnings.addResults(1);
      }
    }

    const rawTabs = this.#host.tabs();
    omittedTabs = hostOmittedCount(rawTabs.omittedCount);
    warnings.addResults(omittedTabs);
    const tabs: EditorTab[] = [];
    for await (const rawTab of rawTabs) {
      throwIfCancelled(signal);
      const resolved = await this.resolveTab(rawTab, access.identity);
      if (!resolved.ok) {
        omittedTabs = saturatingAddProviderCounts(omittedTabs, 1);
        warnings.addAuthorization(resolved.errorCode);
        continue;
      }
      if (tabs.length < tabLimit) {
        tabs.push(resolved.value);
      } else {
        omittedTabs = saturatingAddProviderCounts(omittedTabs, 1);
        warnings.addResults(1);
      }
    }

    await this.requireSameWorkspaceAccess(access.identity, signal);
    const result = GetEditorContextResultSchema.parse({
      activeEditor,
      visibleEditors,
      openDocuments,
      tabs,
      omitted: {
        editors: omittedEditors,
        documents: omittedDocuments,
        tabs: omittedTabs,
      },
    });
    return editorContextSuccess(result, warnings.toArray(), this.#now);
  }

  private async readDocument(
    arguments_: ReadDocumentArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const targetAuthorization = await this.authorize(
      access.identity,
      arguments_.document,
    );
    if (!targetAuthorization.ok) {
      throw authorizationFailure(targetAuthorization.errorCode);
    }
    throwIfCancelled(signal);

    const liveDocument = await this.findOpenAuthorizedDocument(
      targetAuthorization.document,
      access.identity,
      signal,
    );
    const authorizedDocument =
      liveDocument ??
      (await this.openClosedDocument(
        targetAuthorization.document,
        access.identity,
        signal,
      ));

    const document = authorizedDocument.hostDocument;
    const initialVersion = validDocumentVersion(document.version);
    if (
      arguments_.expectedDocumentVersion !== undefined &&
      arguments_.expectedDocumentVersion !== initialVersion
    ) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_VERSION_MISMATCH',
          'The document version does not match the requested version.',
          true,
          {
            expectedDocumentVersion: arguments_.expectedDocumentVersion,
            actualDocumentVersion: initialVersion,
          },
        ),
      );
    }

    const totalLineCount = validLineCount(document.lineCount);
    const startLine = arguments_.startLine ?? TOOL_LIMITS.readDocument.startLineDefault;
    if (startLine >= totalLineCount) {
      throw new ToolFailure(
        failure(
          'POSITION_OUT_OF_RANGE',
          'The requested start line is outside the document.',
          false,
          { totalLineCount },
        ),
      );
    }
    const lineCount = arguments_.lineCount ?? TOOL_LIMITS.readDocument.lineCountDefault;
    const initialEol = document.eol;
    const chunk = readBoundedLines(
      document,
      startLine,
      lineCount,
      TOOL_LIMITS.readDocument.returnedTextBytes,
      signal,
    );

    throwIfCancelled(signal);
    if (document.version !== initialVersion) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_CHANGED_DURING_REQUEST',
          'The document changed while the request was running.',
          true,
        ),
      );
    }
    await this.requireSameWorkspaceAccess(access.identity, signal);
    if (document.version !== initialVersion) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_CHANGED_DURING_REQUEST',
          'The document changed while the request was running.',
          true,
        ),
      );
    }

    const warnings = new WarningAccumulator();
    if (chunk.nextStartLine !== null) {
      warnings.addResults(totalLineCount - chunk.nextStartLine);
    }
    if (chunk.contentTruncated) {
      warnings.addContent();
    }
    const snapshot = createDocumentSnapshot(document, authorizedDocument.authorization);
    const result = ReadDocumentResultSchema.parse({
      document: snapshot,
      eol: initialEol,
      totalLineCount,
      returnedRange: chunk.returnedRange,
      text: chunk.text,
      hasMore: chunk.nextStartLine !== null,
      nextStartLine: chunk.nextStartLine,
    });
    return readDocumentSuccess(result, warnings.toArray(), this.#now);
  }

  private async resolveEditorState(
    editor: EditorHostView,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<ContextEntryResolution<EditorState>> {
    const document = await this.resolveDocumentSnapshot(editor.document, identity);
    if (!document.ok) {
      return document;
    }

    let limitOmissions =
      (editor.omittedSelections ?? 0) + (editor.omittedVisibleRanges ?? 0);
    let unsupportedOmissions = 0;
    const selections = [];
    const selectionLimit = TOOL_LIMITS.editorContext.selectionsPerEditor;
    for (const selection of editor.selections) {
      throwIfCancelled(signal);
      if (selections.length >= selectionLimit) {
        limitOmissions += 1;
        continue;
      }
      const converted = convertSelection(editor.document, selection);
      if (converted === null) {
        unsupportedOmissions += 1;
      } else {
        selections.push(converted);
      }
    }

    const visibleRanges: Range[] = [];
    const rangeLimit = TOOL_LIMITS.editorContext.visibleRangesPerEditor;
    for (const range of editor.visibleRanges) {
      throwIfCancelled(signal);
      if (visibleRanges.length >= rangeLimit) {
        limitOmissions += 1;
        continue;
      }
      const converted = convertRange(editor.document, range);
      if (converted === null) {
        unsupportedOmissions += 1;
      } else {
        visibleRanges.push(converted);
      }
    }

    return {
      ok: true,
      value: {
        document: document.value,
        selections,
        visibleRanges,
      },
      limitOmissions,
      unsupportedOmissions,
    };
  }

  private async resolveDocumentSnapshot(
    document: EditorHostDocument,
    identity: WorkspaceIdentity,
  ): Promise<ContextEntryResolution<DocumentSnapshot>> {
    const authorization = await this.authorize(identity, document.uri);
    if (!authorization.ok) {
      return authorization;
    }
    try {
      validLineCount(document.lineCount);
      return {
        ok: true,
        value: createDocumentSnapshot(document, authorization.document),
        limitOmissions: 0,
        unsupportedOmissions: 0,
      };
    } catch {
      return { ok: false, errorCode: 'UNSUPPORTED_DOCUMENT' };
    }
  }

  private async resolveTab(
    tab: EditorHostTab,
    identity: WorkspaceIdentity,
  ): Promise<ContextEntryResolution<EditorTab>> {
    if (
      tab.document === null ||
      !Number.isSafeInteger(tab.groupIndex) ||
      tab.groupIndex < 0
    ) {
      return { ok: false, errorCode: 'UNSUPPORTED_DOCUMENT' };
    }
    const document = await this.resolveDocumentSnapshot(tab.document, identity);
    if (!document.ok) {
      return document;
    }
    return {
      ok: true,
      value: {
        groupIndex: tab.groupIndex,
        active: tab.active,
        pinned: tab.pinned,
        preview: tab.preview,
        dirty: tab.dirty,
        document: document.value,
      },
      limitOmissions: 0,
      unsupportedOmissions: 0,
    };
  }

  private async findOpenAuthorizedDocument(
    target: AuthorizedWorkspaceDocument,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<AuthorizedHostDocument | null> {
    for (const candidate of this.#host.openDocuments()) {
      throwIfCancelled(signal);
      const authorization = await this.authorize(identity, candidate.uri);
      if (
        authorization.ok &&
        canonicalPathsEqual(
          authorization.document.canonicalPath,
          target.canonicalPath,
          this.#pathStrategy,
        )
      ) {
        return {
          hostDocument: candidate,
          authorization: authorization.document,
        };
      }
    }
    return null;
  }

  private async openClosedDocument(
    target: AuthorizedWorkspaceDocument,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<AuthorizedHostDocument> {
    let fileStat: Awaited<ReturnType<EditorToolHost['statFile']>>;
    throwIfCancelled(signal);
    try {
      fileStat = await this.#host.statFile(target.canonicalPath);
    } catch (error) {
      if (signal.aborted || error instanceof ToolFailure) {
        throw error;
      }
      throw new ToolFailure(
        failure('DOCUMENT_NOT_FOUND', 'The document could not be found.', false),
      );
    }
    throwIfCancelled(signal);
    if (!fileStat.isFile || !Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
      throw new ToolFailure(
        failure('UNSUPPORTED_DOCUMENT', 'The target is not a regular file.', false),
      );
    }
    if (fileStat.size > TOOL_LIMITS.readDocument.closedFileBytes) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_TOO_LARGE',
          'The closed document exceeds the safe open limit.',
          false,
          {
            maximumBytes: TOOL_LIMITS.readDocument.closedFileBytes,
            actualBytes: fileStat.size,
          },
        ),
      );
    }

    let canonicalUri: string;
    try {
      canonicalUri = this.#pathStrategy.pathToFileUri(target.canonicalPath);
    } catch {
      throw new ToolFailure(internalFailure());
    }
    let opened: EditorHostDocument;
    throwIfCancelled(signal);
    try {
      opened = await this.#host.openTextDocument(canonicalUri);
    } catch (error) {
      if (signal.aborted || error instanceof ToolFailure) {
        throw error;
      }
      throw new ToolFailure(
        failure('DOCUMENT_NOT_FOUND', 'The document could not be opened.', false),
      );
    }
    throwIfCancelled(signal);

    // Re-authorize the resource returned by VS Code after the asynchronous open.
    const authorization = await this.authorize(identity, opened.uri);
    if (!authorization.ok) {
      throw authorizationFailure(authorization.errorCode);
    }
    if (
      !canonicalPathsEqual(
        authorization.document.canonicalPath,
        target.canonicalPath,
        this.#pathStrategy,
      )
    ) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_OUTSIDE_WORKSPACE',
          'The opened document did not match the authorized target.',
          false,
        ),
      );
    }
    return { hostDocument: opened, authorization: authorization.document };
  }

  private authorize(
    identity: WorkspaceIdentity,
    reference: Parameters<typeof authorizeWorkspaceDocument>[0]['reference'],
  ): ReturnType<typeof authorizeWorkspaceDocument> {
    return authorizeWorkspaceDocument({
      workspaceIdentity: identity,
      reference,
      realpath: this.#realpath,
      pathStrategy: this.#pathStrategy,
    });
  }

  private async requireWorkspaceAccess(
    signal: AbortSignal,
  ): Promise<Extract<EditorToolWorkspaceAccess, { eligible: true }>> {
    let access: EditorToolWorkspaceAccess;
    try {
      access = await this.#getWorkspaceAccess();
    } catch {
      throw new ToolFailure(internalFailure());
    }
    throwIfCancelled(signal);
    if (!access.eligible) {
      throw new ToolFailure(
        failure(
          'WORKSPACE_UNTRUSTED',
          'The workspace is not eligible for MCP access.',
          false,
        ),
      );
    }
    return access;
  }

  private async requireSameWorkspaceAccess(
    originalIdentity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.requireWorkspaceAccess(signal);
    if (current.identity.fingerprint !== originalIdentity.fingerprint) {
      throw new ToolFailure(
        failure(
          'WORKSPACE_UNTRUSTED',
          'The eligible workspace changed while the request was running.',
          true,
        ),
      );
    }
  }
}

interface BoundedLineRead {
  readonly text: string;
  readonly returnedRange: Range;
  readonly nextStartLine: number | null;
  readonly contentTruncated: boolean;
}

function readBoundedLines(
  document: EditorHostDocument,
  startLine: number,
  maximumLines: number,
  maximumBytes: number,
  signal: AbortSignal,
): BoundedLineRead {
  const totalLineCount = validLineCount(document.lineCount);
  const requestedEndLine = Math.min(totalLineCount, startLine + maximumLines);
  const eol = document.eol === 'CRLF' ? '\r\n' : '\n';
  let text = '';
  let byteLength = 0;
  let returnedEnd: Position = { line: startLine, character: 0 };
  let nextStartLine: number | null = null;
  let contentTruncated = false;

  for (let line = startLine; line < requestedEndLine; line += 1) {
    throwIfCancelled(signal);
    const lineText = validLineText(document.lineText(line));
    const piece = line === startLine ? lineText : `${eol}${lineText}`;
    const pieceBytes = Buffer.byteLength(piece, 'utf8');
    if (byteLength + pieceBytes <= maximumBytes) {
      text += piece;
      byteLength += pieceBytes;
      returnedEnd = { line, character: lineText.length };
      continue;
    }

    if (line === startLine) {
      const prefix = utf8Prefix(lineText, maximumBytes);
      text = prefix;
      returnedEnd = { line, character: prefix.length };
      contentTruncated = prefix.length < lineText.length;
      nextStartLine = line + 1 < totalLineCount ? line + 1 : null;
    } else {
      nextStartLine = line;
    }
    break;
  }

  if (nextStartLine === null && requestedEndLine < totalLineCount) {
    nextStartLine = requestedEndLine;
  }
  return {
    text,
    returnedRange: {
      start: { line: startLine, character: 0 },
      end: returnedEnd,
    },
    nextStartLine,
    contentTruncated,
  };
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let byteLength = 0;
  let prefix = '';
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (byteLength + codePointBytes > maximumBytes) {
      break;
    }
    prefix += codePoint;
    byteLength += codePointBytes;
  }
  return prefix;
}

function createDocumentSnapshot(
  document: EditorHostDocument,
  authorization: AuthorizedWorkspaceDocument,
): DocumentSnapshot {
  return DocumentSnapshotSchema.parse({
    uri: authorization.uri,
    workspaceFolderId: authorization.workspaceFolderId,
    relativePath: authorization.relativePath,
    languageId: document.languageId,
    documentVersion: validDocumentVersion(document.version),
    isDirty: document.isDirty,
  });
}

function convertSelection(
  document: EditorHostDocument,
  selection: EditorHostSelection,
): EditorState['selections'][number] | null {
  const anchor = convertPosition(document, selection.anchor);
  const active = convertPosition(document, selection.active);
  const start = convertPosition(document, selection.start);
  const end = convertPosition(document, selection.end);
  return anchor === null || active === null || start === null || end === null
    ? null
    : { anchor, active, start, end };
}

function convertRange(
  document: EditorHostDocument,
  range: EditorHostRange,
): Range | null {
  const start = convertPosition(document, range.start);
  const end = convertPosition(document, range.end);
  return start === null || end === null ? null : { start, end };
}

function convertPosition(
  document: EditorHostDocument,
  position: { readonly line: number; readonly character: number },
): Position | null {
  if (
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.character < 0 ||
    position.line >= document.lineCount
  ) {
    return null;
  }
  try {
    const text = validLineText(document.lineText(position.line));
    return position.character <= text.length
      ? { line: position.line, character: position.character }
      : null;
  } catch {
    return null;
  }
}

function validDocumentVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ToolFailure(internalFailure());
  }
  return value;
}

function validLineCount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ToolFailure(internalFailure());
  }
  return value;
}

function validLineText(value: string): string {
  if (typeof value !== 'string') {
    throw new ToolFailure(internalFailure());
  }
  return value;
}

function canonicalPathsEqual(
  left: string,
  right: string,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): boolean {
  return (
    pathStrategy.relativeForContainment(left, right) === '' &&
    pathStrategy.relativeForContainment(right, left) === ''
  );
}

function recognizeExtensionTool(value: unknown): ExtensionToolName | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tool' in value) ||
    typeof value.tool !== 'string'
  ) {
    return null;
  }
  for (const tool of EXTENSION_TOOL_NAMES) {
    if (tool === value.tool) {
      return tool;
    }
  }
  return null;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolFailure(
      failure('CANCELLED', 'The tool request was cancelled.', true),
    );
  }
}

function hostOmittedCount(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizeFailure(error: unknown, signal: AbortSignal): ToolFailureData {
  if (signal.aborted) {
    return failure('CANCELLED', 'The tool request was cancelled.', true);
  }
  return error instanceof ToolFailure ? error.data : internalFailure();
}

function authorizationFailure(code: WorkspaceAuthorizationErrorCode): ToolFailure {
  const messages: Record<WorkspaceAuthorizationErrorCode, string> = {
    INVALID_ARGUMENT: 'The document reference is invalid.',
    WORKSPACE_FOLDER_NOT_FOUND: 'The workspace folder could not be found.',
    DOCUMENT_NOT_FOUND: 'The document could not be found.',
    DOCUMENT_OUTSIDE_WORKSPACE: 'The document is outside the enabled workspace.',
    UNSUPPORTED_URI_SCHEME: 'The document URI scheme is not supported.',
    UNSUPPORTED_DOCUMENT: 'The document type is not supported.',
    INTERNAL_ERROR: 'The document authorization check failed internally.',
  };
  return new ToolFailure(failure(code, messages[code], false));
}

function failure(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  details?: SafeErrorDetails,
): ToolFailureData {
  return details === undefined
    ? { code, message, retryable }
    : { code, message, retryable, details };
}

function internalFailure(): ToolFailureData {
  return failure('INTERNAL_ERROR', 'The editor tool request failed internally.', false);
}

function toolError(tool: ExtensionToolName, error: ToolFailureData): IpcCallToolResult {
  return IpcCallToolResultSchema.parse({ outcome: 'toolError', tool, error });
}

function editorContextSuccess(
  result: GetEditorContextResult,
  warnings: readonly Warning[],
  now: () => Date,
): IpcCallToolResult {
  return IpcCallToolResultSchema.parse({
    outcome: 'success',
    observedAt: now().toISOString(),
    truncated: warnings.length > 0,
    warnings,
    payload: { tool: 'get_editor_context', result },
  });
}

function readDocumentSuccess(
  result: ReadDocumentResult,
  warnings: readonly Warning[],
  now: () => Date,
): IpcCallToolResult {
  return IpcCallToolResultSchema.parse({
    outcome: 'success',
    observedAt: now().toISOString(),
    truncated: warnings.length > 0,
    warnings,
    payload: { tool: 'read_document', result },
  });
}

class WarningAccumulator {
  #results = 0;
  #content = false;
  #external = 0;
  #unsupported = 0;

  public addResults(count: number): void {
    this.#results = saturatingAddProviderCounts(this.#results, count);
  }

  public addContent(): void {
    this.#content = true;
  }

  public addExternal(count: number): void {
    this.#external = saturatingAddProviderCounts(this.#external, count);
  }

  public addUnsupported(count: number): void {
    this.#unsupported = saturatingAddProviderCounts(this.#unsupported, count);
  }

  public addAuthorization(
    code: WorkspaceAuthorizationErrorCode | 'UNSUPPORTED_DOCUMENT',
  ): void {
    if (code === 'DOCUMENT_OUTSIDE_WORKSPACE') {
      this.addExternal(1);
    } else {
      this.addUnsupported(1);
    }
  }

  public toArray(): Warning[] {
    const warnings: Warning[] = [];
    if (this.#results > 0) {
      warnings.push({
        code: 'RESULTS_TRUNCATED',
        message: 'Some results were omitted to enforce the configured limits.',
        omittedCount: this.#results,
      });
    }
    if (this.#content) {
      warnings.push({
        code: 'CONTENT_TRUNCATED',
        message: 'Document content was truncated at the UTF-8 byte limit.',
      });
    }
    if (this.#external > 0) {
      warnings.push({
        code: 'EXTERNAL_LOCATIONS_OMITTED',
        message: 'Entries outside the enabled workspace were omitted.',
        omittedCount: this.#external,
      });
    }
    if (this.#unsupported > 0) {
      warnings.push({
        code: 'UNSUPPORTED_ITEMS_OMITTED',
        message: 'Unsupported entries were omitted.',
        omittedCount: this.#unsupported,
      });
    }
    return warnings;
  }
}
