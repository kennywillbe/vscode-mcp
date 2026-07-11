import { Buffer } from 'node:buffer';

import { TOOL_LIMITS, V02_READ_TOOL_LIMITS } from '@vscode-mcp/protocol/constants';
import {
  InstanceIdSchema,
  type ErrorCode,
  type Range,
} from '@vscode-mcp/protocol/schemas';
import {
  V02ReadDocumentsArgumentsSchema,
  V02ReadDocumentsSuccessSchema,
  type V02ReadDocumentsInput,
  type V02ReadDocumentsResult,
  type V02ReadDocumentsSuccess,
  type V02ToolExecutionError,
} from '@vscode-mcp/protocol/tool-schemas-v0.2';

import {
  authorizeWorkspaceDocument,
  type AuthorizedWorkspaceDocument,
  type WorkspaceAuthorizationErrorCode,
  type WorkspaceAuthorizationPathStrategy,
} from './workspace-authorizer.js';
import type {
  EditorHostDocument,
  EditorToolHost,
  EditorToolWorkspaceAccess,
} from './editor-tool-host.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

type BatchItem = V02ReadDocumentsResult['items'][number];
type BatchItemSuccess = Extract<BatchItem, { readonly outcome: 'success' }>;
type BatchInputItem = V02ReadDocumentsInput['documents'][number];
type BatchErrorCode = V02ToolExecutionError['code'];

export interface WorkspaceDocumentBatchServiceOptions {
  readonly instanceId: string;
  readonly host: EditorToolHost;
  readonly getWorkspaceAccess: () =>
    EditorToolWorkspaceAccess | PromiseLike<EditorToolWorkspaceAccess>;
  readonly realpath: (path: string) => Promise<string>;
  readonly pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly now?: () => Date;
}

export class WorkspaceDocumentBatchError extends Error {
  public constructor(
    public readonly code: BatchErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly requestLevel: boolean,
  ) {
    super(message);
    this.name = 'WorkspaceDocumentBatchError';
  }
}

interface AuthorizedHostDocument {
  readonly hostDocument: EditorHostDocument;
  readonly authorization: AuthorizedWorkspaceDocument;
}

interface BoundedLineRead {
  readonly text: string;
  readonly returnedRange: Range;
  readonly nextStartLine: number | null;
  readonly contentTruncated: boolean;
}

interface ItemReadOutcome {
  readonly item: BatchItemSuccess;
  readonly contentTruncated: boolean;
}

/** Unregistered v0.2 batch reader. Runtime promotion is a separate IPC/router step. */
export class WorkspaceDocumentBatchService {
  readonly #instanceId: string;
  readonly #host: EditorToolHost;
  readonly #getWorkspaceAccess: WorkspaceDocumentBatchServiceOptions['getWorkspaceAccess'];
  readonly #realpath: WorkspaceDocumentBatchServiceOptions['realpath'];
  readonly #pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly #now: () => Date;

  public constructor(options: WorkspaceDocumentBatchServiceOptions) {
    this.#instanceId = InstanceIdSchema.parse(options.instanceId);
    this.#host = options.host;
    this.#getWorkspaceAccess = options.getWorkspaceAccess;
    this.#realpath = options.realpath;
    this.#pathStrategy = options.pathStrategy;
    this.#now = options.now ?? (() => new Date());
  }

  public async readDocuments(
    untrustedArguments: unknown,
    signal: AbortSignal,
  ): Promise<V02ReadDocumentsSuccess> {
    const parsed = V02ReadDocumentsArgumentsSchema.safeParse(untrustedArguments);
    if (!parsed.success) {
      throw topLevelFailure(
        'INVALID_ARGUMENT',
        'The tool arguments are invalid.',
        false,
      );
    }
    const access = await this.requireWorkspaceAccess(signal);
    const folder = access.identity.folders.find(
      (candidate) => candidate.workspaceFolderId === parsed.data.workspaceFolderId,
    );
    if (folder === undefined) {
      throw topLevelFailure(
        'WORKSPACE_FOLDER_NOT_FOUND',
        'The workspace folder could not be found.',
        false,
      );
    }

    const contentByteLimit =
      parsed.data.contentByteLimit ??
      V02_READ_TOOL_LIMITS.readDocuments.contentBytesDefault;
    const items: BatchItem[] = [];
    let contentBytes = 0;
    let budgetExhausted = false;
    let contentTruncated = false;

    for (let index = 0; index < parsed.data.documents.length; index += 1) {
      await this.requireSameWorkspaceAccess(access.identity, signal);
      const input = parsed.data.documents[index];
      if (input === undefined) {
        throw topLevelFailure(
          'INTERNAL_ERROR',
          'The batch request failed internally.',
          false,
        );
      }

      if (
        !this.errorTailFits(
          folder.workspaceFolderId,
          items,
          parsed.data.documents.length - index,
          contentTruncated,
        )
      ) {
        throw topLevelFailure(
          'INTERNAL_ERROR',
          'The bounded batch result could not be encoded.',
          false,
        );
      }

      let item: BatchItem;
      let itemContentTruncated = false;
      try {
        const outcome = await this.readOne(
          input,
          folder.workspaceFolderId,
          access.identity,
          signal,
        );
        item = outcome.item;
        itemContentTruncated = outcome.contentTruncated;
      } catch (error) {
        if (isRequestInvalidation(error, signal)) {
          throw normalizeTopLevelFailure(error, signal);
        }
        item = itemError(normalizeItemFailure(error));
      }

      if (item.outcome === 'success') {
        const itemBytes = Buffer.byteLength(item.text, 'utf8');
        const contentFits = contentBytes + itemBytes <= contentByteLimit;
        const serializedFits = this.successWithTailFits(
          folder.workspaceFolderId,
          [...items, item],
          parsed.data.documents.length - index - 1,
          contentTruncated || itemContentTruncated,
        );
        if (!contentFits || !serializedFits) {
          appendBudgetErrors(items, parsed.data.documents.length - index);
          budgetExhausted = true;
          break;
        }
        contentBytes += itemBytes;
        contentTruncated ||= itemContentTruncated;
      }
      items.push(item);
    }

    await this.requireSameWorkspaceAccess(access.identity, signal);
    const warnings = [];
    if (contentTruncated) {
      warnings.push({
        code: 'CONTENT_TRUNCATED' as const,
        message: 'Document content was truncated at the per-item byte limit.',
      });
    }
    if (budgetExhausted) {
      warnings.push({
        code: 'RESOURCE_LIMIT_REACHED' as const,
        message: 'The batch response budget was reached.',
      });
    }
    const result = V02ReadDocumentsSuccessSchema.safeParse({
      contractVersion: '0.2.0',
      instanceId: this.#instanceId,
      observedAt: this.#now().toISOString(),
      truncated: budgetExhausted || contentTruncated,
      warnings,
      result: { workspaceFolderId: folder.workspaceFolderId, items },
    });
    if (!result.success) {
      throw topLevelFailure(
        'INTERNAL_ERROR',
        'The bounded batch result could not be encoded.',
        false,
      );
    }
    return result.data;
  }

  private async readOne(
    input: BatchInputItem,
    workspaceFolderId: string,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<ItemReadOutcome> {
    if (
      input.document.kind === 'workspacePath' &&
      input.document.workspaceFolderId !== workspaceFolderId
    ) {
      throw itemFailure(
        'WORKSPACE_FOLDER_NOT_FOUND',
        'The document does not belong to the selected workspace folder.',
        false,
      );
    }
    const authorization = await authorizeWorkspaceDocument({
      workspaceIdentity: identity,
      reference: input.document,
      realpath: this.#realpath,
      pathStrategy: this.#pathStrategy,
    });
    throwIfCancelled(signal);
    if (!authorization.ok) {
      throw authorizationFailure(authorization.errorCode);
    }
    if (authorization.document.workspaceFolderId !== workspaceFolderId) {
      throw itemFailure(
        'DOCUMENT_OUTSIDE_WORKSPACE',
        'The document is outside the selected workspace folder.',
        false,
      );
    }

    const liveDocument = await this.findOpenDocument(
      authorization.document,
      identity,
      signal,
    );
    const selected =
      liveDocument ??
      (await this.openClosedDocument(authorization.document, identity, signal));
    const document = selected.hostDocument;
    const initialVersion = validVersion(document.version);
    if (
      input.expectedDocumentVersion !== undefined &&
      input.expectedDocumentVersion !== initialVersion
    ) {
      throw itemFailure(
        'DOCUMENT_VERSION_MISMATCH',
        'The document version does not match the requested version.',
        true,
      );
    }

    const totalLineCount = validLineCount(document.lineCount);
    const startLine = input.startLine ?? TOOL_LIMITS.readDocument.startLineDefault;
    if (startLine >= totalLineCount) {
      throw itemFailure(
        'POSITION_OUT_OF_RANGE',
        'The requested start line is outside the document.',
        false,
      );
    }
    const chunk = readBoundedLines(
      document,
      startLine,
      input.lineCount ?? TOOL_LIMITS.readDocument.lineCountDefault,
      TOOL_LIMITS.readDocument.returnedTextBytes,
      signal,
    );
    if (document.version !== initialVersion) {
      throw itemFailure(
        'DOCUMENT_CHANGED_DURING_REQUEST',
        'The document changed while the item was being read.',
        true,
      );
    }
    await this.requireSameWorkspaceAccess(identity, signal);
    if (document.version !== initialVersion) {
      throw itemFailure(
        'DOCUMENT_CHANGED_DURING_REQUEST',
        'The document changed while the item was being read.',
        true,
      );
    }

    return {
      contentTruncated: chunk.contentTruncated,
      item: {
        outcome: 'success',
        document: {
          workspaceFolderId: selected.authorization.workspaceFolderId,
          relativePath: selected.authorization.relativePath,
          languageId: validLanguageId(document.languageId),
          documentVersion: initialVersion,
          isDirty: document.isDirty,
        },
        eol: validEol(document.eol),
        totalLineCount,
        returnedRange: chunk.returnedRange,
        text: chunk.text,
        hasMore: chunk.nextStartLine !== null,
        nextStartLine: chunk.nextStartLine,
      },
    };
  }

  private async findOpenDocument(
    target: AuthorizedWorkspaceDocument,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<AuthorizedHostDocument | null> {
    for (const candidate of this.#host.openDocuments()) {
      throwIfCancelled(signal);
      const authorization = await authorizeWorkspaceDocument({
        workspaceIdentity: identity,
        reference: candidate.uri,
        realpath: this.#realpath,
        pathStrategy: this.#pathStrategy,
      });
      if (
        authorization.ok &&
        canonicalPathsEqual(
          authorization.document.canonicalPath,
          target.canonicalPath,
          this.#pathStrategy,
        )
      ) {
        return { hostDocument: candidate, authorization: authorization.document };
      }
    }
    return null;
  }

  private async openClosedDocument(
    target: AuthorizedWorkspaceDocument,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<AuthorizedHostDocument> {
    throwIfCancelled(signal);
    let fileStat: Awaited<ReturnType<EditorToolHost['statFile']>>;
    try {
      fileStat = await this.#host.statFile(target.canonicalPath);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw itemFailure(
        'DOCUMENT_NOT_FOUND',
        'The document could not be found.',
        false,
      );
    }
    throwIfCancelled(signal);
    if (!fileStat.isFile || !Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
      throw itemFailure(
        'UNSUPPORTED_DOCUMENT',
        'The target is not a regular file.',
        false,
      );
    }
    if (fileStat.size > TOOL_LIMITS.readDocument.closedFileBytes) {
      throw itemFailure(
        'DOCUMENT_TOO_LARGE',
        'The closed document exceeds the safe open limit.',
        false,
      );
    }

    let uri: string;
    try {
      uri = this.#pathStrategy.pathToFileUri(target.canonicalPath);
    } catch {
      throw itemFailure('INTERNAL_ERROR', 'The document could not be opened.', false);
    }
    let document: EditorHostDocument;
    throwIfCancelled(signal);
    try {
      document = await this.#host.openTextDocument(uri);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw itemFailure(
        'DOCUMENT_NOT_FOUND',
        'The document could not be opened.',
        false,
      );
    }
    throwIfCancelled(signal);
    const authorization = await authorizeWorkspaceDocument({
      workspaceIdentity: identity,
      reference: document.uri,
      realpath: this.#realpath,
      pathStrategy: this.#pathStrategy,
    });
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
      throw itemFailure(
        'DOCUMENT_OUTSIDE_WORKSPACE',
        'The opened document did not match the authorized target.',
        false,
      );
    }
    return { hostDocument: document, authorization: authorization.document };
  }

  private async requireWorkspaceAccess(
    signal: AbortSignal,
  ): Promise<Extract<EditorToolWorkspaceAccess, { readonly eligible: true }>> {
    throwIfCancelled(signal);
    let access: EditorToolWorkspaceAccess;
    try {
      access = await this.#getWorkspaceAccess();
    } catch {
      throw topLevelFailure('INTERNAL_ERROR', 'The workspace check failed.', false);
    }
    throwIfCancelled(signal);
    if (!access.eligible) {
      throw topLevelFailure(
        'WORKSPACE_UNTRUSTED',
        'The workspace is not eligible.',
        false,
      );
    }
    return access;
  }

  private async requireSameWorkspaceAccess(
    original: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.requireWorkspaceAccess(signal);
    if (current.identity.fingerprint !== original.fingerprint) {
      throw topLevelFailure(
        'WORKSPACE_UNTRUSTED',
        'The eligible workspace changed while the request was running.',
        true,
      );
    }
  }

  private errorTailFits(
    workspaceFolderId: string,
    prefix: readonly BatchItem[],
    errorCount: number,
    contentTruncated: boolean,
  ): boolean {
    return this.successWithTailFits(
      workspaceFolderId,
      prefix,
      errorCount,
      contentTruncated,
    );
  }

  private successWithTailFits(
    workspaceFolderId: string,
    prefix: readonly BatchItem[],
    errorCount: number,
    contentTruncated: boolean,
  ): boolean {
    return V02ReadDocumentsSuccessSchema.safeParse({
      contractVersion: '0.2.0',
      instanceId: this.#instanceId,
      observedAt: this.#now().toISOString(),
      truncated: errorCount > 0 || contentTruncated,
      warnings: [
        ...(contentTruncated
          ? [
              {
                code: 'CONTENT_TRUNCATED',
                message: 'Document content was truncated at the per-item byte limit.',
              } as const,
            ]
          : []),
        ...(errorCount > 0
          ? [
              {
                code: 'RESOURCE_LIMIT_REACHED',
                message: 'The batch response budget was reached.',
              } as const,
            ]
          : []),
      ],
      result: {
        workspaceFolderId,
        items: [...prefix, ...budgetErrors(errorCount)],
      },
    }).success;
  }
}

function readBoundedLines(
  document: EditorHostDocument,
  startLine: number,
  maximumLines: number,
  maximumBytes: number,
  signal: AbortSignal,
): BoundedLineRead {
  const totalLineCount = validLineCount(document.lineCount);
  const endLine = Math.min(totalLineCount, startLine + maximumLines);
  const eol = document.eol === 'CRLF' ? '\r\n' : '\n';
  let text = '';
  let bytes = 0;
  let returnedEnd = { line: startLine, character: 0 };
  let nextStartLine: number | null = null;
  let contentTruncated = false;
  for (let line = startLine; line < endLine; line += 1) {
    throwIfCancelled(signal);
    const lineText = validLineText(document.lineText(line));
    const piece = line === startLine ? lineText : `${eol}${lineText}`;
    const pieceBytes = Buffer.byteLength(piece, 'utf8');
    if (bytes + pieceBytes <= maximumBytes) {
      text += piece;
      bytes += pieceBytes;
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
  if (nextStartLine === null && endLine < totalLineCount) {
    nextStartLine = endLine;
  }
  return {
    text,
    returnedRange: { start: { line: startLine, character: 0 }, end: returnedEnd },
    nextStartLine,
    contentTruncated,
  };
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let prefix = '';
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, 'utf8');
    if (bytes + scalarBytes > maximumBytes) {
      break;
    }
    prefix += scalar;
    bytes += scalarBytes;
  }
  return prefix;
}

function appendBudgetErrors(items: BatchItem[], count: number): void {
  items.push(...budgetErrors(count));
}

function budgetErrors(count: number): BatchItem[] {
  return Array.from({ length: count }, () =>
    itemError({
      code: 'BATCH_BUDGET_EXHAUSTED',
      message: 'The batch response budget was exhausted before this item.',
      retryable: true,
    }),
  );
}

function itemError(error: {
  readonly code: BatchErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}): BatchItem {
  return {
    outcome: 'error',
    error: { code: error.code, message: error.message, retryable: error.retryable },
  };
}

function normalizeItemFailure(error: unknown): WorkspaceDocumentBatchError {
  return error instanceof WorkspaceDocumentBatchError
    ? error
    : itemFailure('INTERNAL_ERROR', 'The document item failed internally.', false);
}

function normalizeTopLevelFailure(
  error: unknown,
  signal: AbortSignal,
): WorkspaceDocumentBatchError {
  if (signal.aborted) {
    return topLevelFailure('CANCELLED', 'The request was cancelled.', true);
  }
  return error instanceof WorkspaceDocumentBatchError
    ? error
    : topLevelFailure('INTERNAL_ERROR', 'The batch request failed internally.', false);
}

function isRequestInvalidation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof WorkspaceDocumentBatchError && error.requestLevel)
  );
}

function authorizationFailure(
  code: WorkspaceAuthorizationErrorCode,
): WorkspaceDocumentBatchError {
  const messages: Record<WorkspaceAuthorizationErrorCode, string> = {
    INVALID_ARGUMENT: 'The document reference is invalid.',
    WORKSPACE_FOLDER_NOT_FOUND: 'The workspace folder could not be found.',
    DOCUMENT_NOT_FOUND: 'The document could not be found.',
    DOCUMENT_OUTSIDE_WORKSPACE: 'The document is outside the selected workspace.',
    UNSUPPORTED_URI_SCHEME: 'The document URI scheme is not supported.',
    UNSUPPORTED_DOCUMENT: 'The document type is not supported.',
    INTERNAL_ERROR: 'The document authorization check failed internally.',
  };
  return itemFailure(code, messages[code], false);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw topLevelFailure('CANCELLED', 'The request was cancelled.', true);
  }
}

function itemFailure(
  code: ErrorCode,
  message: string,
  retryable: boolean,
): WorkspaceDocumentBatchError {
  return new WorkspaceDocumentBatchError(code, message, retryable, false);
}

function topLevelFailure(
  code: BatchErrorCode,
  message: string,
  retryable: boolean,
): WorkspaceDocumentBatchError {
  return new WorkspaceDocumentBatchError(code, message, retryable, true);
}

function validVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw itemFailure('INTERNAL_ERROR', 'The document state is invalid.', false);
  }
  return value;
}

function validLineCount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw itemFailure('INTERNAL_ERROR', 'The document state is invalid.', false);
  }
  return value;
}

function validLineText(value: string): string {
  if (typeof value !== 'string') {
    throw itemFailure('INTERNAL_ERROR', 'The document state is invalid.', false);
  }
  return value;
}

function validLanguageId(value: string): string {
  if (value.length === 0 || value.length > 256) {
    throw itemFailure('INTERNAL_ERROR', 'The document state is invalid.', false);
  }
  return value;
}

function validEol(value: string): 'LF' | 'CRLF' {
  if (value !== 'LF' && value !== 'CRLF') {
    throw itemFailure('INTERNAL_ERROR', 'The document state is invalid.', false);
  }
  return value;
}

function canonicalPathsEqual(
  left: string,
  right: string,
  strategy: WorkspaceAuthorizationPathStrategy,
): boolean {
  return (
    strategy.relativeForContainment(left, right) === '' &&
    strategy.relativeForContainment(right, left) === ''
  );
}
