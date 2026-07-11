import { Buffer } from 'node:buffer';

import { V02_READ_TOOL_LIMITS } from '@vscode-mcp/protocol/constants';
import {
  InstanceIdSchema,
  WorkspaceRelativePathSchema,
} from '@vscode-mcp/protocol/schemas';
import {
  V02SearchWorkspaceTextArgumentsSchema,
  V02SearchWorkspaceTextSuccessSchema,
  type V02SearchWorkspaceTextResult,
  type V02SearchWorkspaceTextSuccess,
  type V02ToolExecutionError,
  type V02WarningCode,
} from '@vscode-mcp/protocol/tool-schemas-v0.2';

import type { BoundedReadScheduler } from './bounded-read-scheduler.js';
import type { EditorHostDocument } from './editor-tool-host.js';
import {
  authorizeWorkspaceDocument,
  type WorkspaceAuthorizationPathStrategy,
} from './workspace-authorizer.js';
import {
  combineWorkspaceDiscoveryExclude,
  type WorkspaceFileDiscoveryCandidate,
  type WorkspaceFileDiscoveryEntryStat,
} from './workspace-file-discovery-service.js';
import {
  hashWorkspaceDiscoverySortTuple,
  type WorkspaceDiscoveryCursorBinding,
  type WorkspaceDiscoveryCursorCodec,
} from './workspace-discovery-cursor.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

type SearchErrorCode = V02ToolExecutionError['code'];
type SearchDocument = V02SearchWorkspaceTextResult['documents'][number];
type SearchMatch = SearchDocument['matches'][number];

export interface WorkspaceTextSearchHost {
  findFiles(
    folderUri: string,
    include: string,
    exclude: string | null,
    maximumResults: number,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceFileDiscoveryCandidate[]>;
  lstat(path: string): Promise<WorkspaceFileDiscoveryEntryStat>;
  realpath(path: string): Promise<string>;
  readFile(
    path: string,
    signal: AbortSignal,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly before: WorkspaceFileDiscoveryEntryStat;
    readonly after: WorkspaceFileDiscoveryEntryStat;
  }>;
  openDocuments(): Iterable<EditorHostDocument> & { readonly omittedCount?: number };
}

export type WorkspaceTextSearchAccess =
  | { readonly eligible: true; readonly identity: WorkspaceIdentity }
  | { readonly eligible: false };

export interface WorkspaceTextSearchServiceOptions {
  readonly instanceId: string;
  readonly cursorCodec: WorkspaceDiscoveryCursorCodec;
  readonly host: WorkspaceTextSearchHost;
  readonly scheduler: BoundedReadScheduler;
  readonly getWorkspaceAccess: () =>
    WorkspaceTextSearchAccess | PromiseLike<WorkspaceTextSearchAccess>;
  readonly pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly now?: () => Date;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export class WorkspaceTextSearchError extends Error {
  public constructor(
    public readonly code: SearchErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WorkspaceTextSearchError';
  }
}

interface Candidate {
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly stat: WorkspaceFileDiscoveryEntryStat;
}

interface FlatMatch {
  readonly relativePath: string;
  readonly state: SearchDocument['state'];
  readonly match: SearchMatch;
}

interface SearchCounts {
  external: number;
  unsupported: number;
  changed: number;
}

interface SearchFlags {
  candidate: boolean;
  aggregate: boolean;
  context: boolean;
  deadline: boolean;
  output: boolean;
  openDocuments: boolean;
}

const WARNING_ORDER: readonly V02WarningCode[] = [
  'RESULTS_TRUNCATED',
  'CONTENT_TRUNCATED',
  'EXTERNAL_LOCATIONS_OMITTED',
  'UNSUPPORTED_ITEMS_OMITTED',
  'PROVIDER_RETURNED_NO_RESULT',
  'RESOURCE_LIMIT_REACHED',
  'FILES_CHANGED_DURING_REQUEST',
];

const WORD_CHARACTER = /^[\p{L}\p{M}\p{Nd}\p{Pc}\u200C\u200D]$/u;

/** Unregistered v0.2 literal scanner. Runtime promotion is a separate step. */
export class WorkspaceTextSearchService {
  readonly #instanceId: string;
  readonly #cursorCodec: WorkspaceDiscoveryCursorCodec;
  readonly #host: WorkspaceTextSearchHost;
  readonly #scheduler: BoundedReadScheduler;
  readonly #getWorkspaceAccess: WorkspaceTextSearchServiceOptions['getWorkspaceAccess'];
  readonly #pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly #now: () => Date;
  readonly #setTimer: NonNullable<WorkspaceTextSearchServiceOptions['setTimer']>;
  readonly #clearTimer: NonNullable<WorkspaceTextSearchServiceOptions['clearTimer']>;

  public constructor(options: WorkspaceTextSearchServiceOptions) {
    this.#instanceId = InstanceIdSchema.parse(options.instanceId);
    this.#cursorCodec = options.cursorCodec;
    this.#host = options.host;
    this.#scheduler = options.scheduler;
    this.#getWorkspaceAccess = options.getWorkspaceAccess;
    this.#pathStrategy = options.pathStrategy;
    this.#now = options.now ?? (() => new Date());
    this.#setTimer =
      options.setTimer ??
      ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.#clearTimer =
      options.clearTimer ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  public async searchWorkspaceText(
    untrustedArguments: unknown,
    callerSignal: AbortSignal,
  ): Promise<V02SearchWorkspaceTextSuccess> {
    const parsed = V02SearchWorkspaceTextArgumentsSchema.safeParse(untrustedArguments);
    if (!parsed.success) {
      throw failure('INVALID_ARGUMENT', 'The tool arguments are invalid.', false);
    }
    const deadline = new AbortController();
    let deadlineReached = false;
    const timer = this.#setTimer(() => {
      deadlineReached = true;
      deadline.abort();
    }, V02_READ_TOOL_LIMITS.searchWorkspaceText.timeoutMs);
    const abortFromCaller = (): void => deadline.abort();
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    if (callerSignal.aborted) {
      deadline.abort();
    }

    try {
      const signal = deadline.signal;
      throwIfCallerCancelled(callerSignal);
      const access = await this.requireWorkspaceAccess(callerSignal);
      const folder = access.identity.folders.find(
        (candidate) => candidate.workspaceFolderId === parsed.data.workspaceFolderId,
      );
      if (folder === undefined) {
        throw failure(
          'WORKSPACE_FOLDER_NOT_FOUND',
          'The workspace folder could not be found.',
          false,
        );
      }

      const include = parsed.data.include ?? '**/*';
      const exclude = combineWorkspaceDiscoveryExclude(parsed.data.exclude);
      const contextLines =
        parsed.data.contextLines ??
        V02_READ_TOOL_LIMITS.searchWorkspaceText.contextLinesDefault;
      const caseSensitive = parsed.data.caseSensitive ?? true;
      const wholeWord = parsed.data.wholeWord ?? false;
      const binding: WorkspaceDiscoveryCursorBinding = {
        tool: 'search_workspace_text',
        instanceId: this.#instanceId,
        workspaceFingerprint: access.identity.fingerprint,
        workspaceFolderId: folder.workspaceFolderId,
        include,
        exclude,
        optionsHash: hashWorkspaceDiscoverySortTuple(
          JSON.stringify({
            query: parsed.data.query,
            caseSensitive,
            wholeWord,
            contextLines,
          }),
        ),
      };
      let offset = 0;
      if (parsed.data.cursor !== undefined) {
        const position = this.#cursorCodec.decode(parsed.data.cursor, binding);
        if (position === null) {
          throw failure('INVALID_CURSOR', 'The continuation cursor is invalid.', false);
        }
        offset = position.offset;
      }

      const counts: SearchCounts = { external: 0, unsupported: 0, changed: 0 };
      const flags: SearchFlags = {
        candidate: false,
        aggregate: false,
        context: false,
        deadline: false,
        output: false,
        openDocuments: false,
      };
      const candidates = await this.discoverCandidates(
        folder.uri,
        folder.workspaceFolderId,
        include,
        exclude,
        access.identity,
        counts,
        flags,
        signal,
        callerSignal,
        () => deadlineReached,
      );
      const liveDocuments = await this.liveDocumentMap(
        access.identity,
        folder.workspaceFolderId,
        counts,
        flags,
        signal,
        callerSignal,
      );
      const limit =
        parsed.data.limit ?? V02_READ_TOOL_LIMITS.searchWorkspaceText.matchesDefault;
      const targetMatches = Math.min(Number.MAX_SAFE_INTEGER, offset + limit + 1);
      const matches: FlatMatch[] = [];
      let inspectedBytes = 0;
      let contextBytes = 0;

      for (const candidate of candidates) {
        throwIfCallerCancelled(callerSignal);
        if (deadlineReached) {
          flags.deadline = true;
          break;
        }
        if (matches.length >= targetMatches) {
          break;
        }
        const live = liveDocuments.get(this.canonicalKey(candidate.canonicalPath));
        const remainingBytes =
          V02_READ_TOOL_LIMITS.searchWorkspaceText.aggregateInspectedBytes -
          inspectedBytes;
        const scanned =
          live === undefined
            ? await this.scanClosedCandidate(
                candidate,
                parsed.data.query,
                caseSensitive,
                wholeWord,
                contextLines,
                targetMatches - matches.length,
                remainingBytes,
                signal,
                callerSignal,
              )
            : this.scanLiveCandidate(
                candidate,
                live,
                parsed.data.query,
                caseSensitive,
                wholeWord,
                contextLines,
                targetMatches - matches.length,
                remainingBytes,
                signal,
                callerSignal,
              );
        if (scanned.kind === 'aggregate') {
          flags.aggregate = true;
          break;
        }
        if (scanned.kind === 'unsupported') {
          counts.unsupported = saturatingAdd(counts.unsupported, 1);
          continue;
        }
        if (scanned.kind === 'changed') {
          counts.changed = saturatingAdd(counts.changed, 1);
          continue;
        }
        if (scanned.contextOmitted) {
          flags.context = true;
        }
        inspectedBytes += scanned.inspectedBytes;
        for (const match of scanned.matches) {
          if (matches.length >= targetMatches) {
            break;
          }
          let acceptedMatch = match;
          if (match.context !== null) {
            const bytes = Buffer.byteLength(match.context.text, 'utf8');
            if (
              contextBytes + bytes >
              V02_READ_TOOL_LIMITS.searchWorkspaceText.aggregateContextBytes
            ) {
              flags.context = true;
              acceptedMatch = { ...match, context: null };
            } else {
              contextBytes += bytes;
            }
          }
          matches.push({
            relativePath: candidate.relativePath,
            state: scanned.state,
            match: acceptedMatch,
          });
        }
      }

      throwIfCallerCancelled(callerSignal);
      if (deadlineReached) {
        flags.deadline = true;
      }
      await this.requireSameWorkspaceAccess(access.identity, callerSignal);
      const page = matches.slice(offset, offset + limit);
      let knownHasMore = matches.length > offset + page.length;
      let documents = groupMatches(folder.workspaceFolderId, page);
      let success = this.buildSuccess(
        folder.workspaceFolderId,
        parsed.data.query,
        binding,
        offset,
        documents,
        knownHasMore,
        counts,
        flags,
      );

      if (success === null && page.some((entry) => entry.match.context !== null)) {
        flags.context = true;
        documents = groupMatches(
          folder.workspaceFolderId,
          page.map((entry) => ({
            ...entry,
            match: { ...entry.match, context: null },
          })),
        );
        success = this.buildSuccess(
          folder.workspaceFolderId,
          parsed.data.query,
          binding,
          offset,
          documents,
          knownHasMore,
          counts,
          flags,
        );
      }

      while (success === null && page.length > 0) {
        flags.output = true;
        page.pop();
        knownHasMore = true;
        documents = groupMatches(folder.workspaceFolderId, page);
        success = this.buildSuccess(
          folder.workspaceFolderId,
          parsed.data.query,
          binding,
          offset,
          documents,
          knownHasMore,
          counts,
          flags,
        );
      }
      if (success === null) {
        throw failure(
          'INTERNAL_ERROR',
          'The bounded search result could not be encoded.',
          false,
        );
      }
      return success;
    } catch (error) {
      if (callerSignal.aborted) {
        throw failure('CANCELLED', 'The request was cancelled.', true);
      }
      if (deadlineReached && !(error instanceof WorkspaceTextSearchError)) {
        throw failure('TIMEOUT', 'The search deadline was reached.', true);
      }
      throw error instanceof WorkspaceTextSearchError
        ? error
        : failure('INTERNAL_ERROR', 'Workspace text search failed.', false);
    } finally {
      callerSignal.removeEventListener('abort', abortFromCaller);
      this.#clearTimer(timer);
    }
  }

  private async discoverCandidates(
    folderUri: string,
    workspaceFolderId: string,
    include: string,
    exclude: string | null,
    identity: WorkspaceIdentity,
    counts: SearchCounts,
    flags: SearchFlags,
    signal: AbortSignal,
    callerSignal: AbortSignal,
    deadlineReached: () => boolean,
  ): Promise<Candidate[]> {
    let raw: readonly WorkspaceFileDiscoveryCandidate[];
    try {
      raw = await this.#host.findFiles(
        folderUri,
        include,
        exclude,
        V02_READ_TOOL_LIMITS.discoveryCandidates +
          V02_READ_TOOL_LIMITS.discoveryDetectionSlots,
        signal,
      );
    } catch (error) {
      throwIfCallerCancelled(callerSignal);
      if (deadlineReached()) {
        throw error;
      }
      throw failure('INTERNAL_ERROR', 'Workspace discovery failed.', false);
    }
    flags.candidate = raw.length > V02_READ_TOOL_LIMITS.discoveryCandidates;
    const candidates: Candidate[] = [];
    const canonical = new Set<string>();
    for (const rawCandidate of raw.slice(0, V02_READ_TOOL_LIMITS.discoveryCandidates)) {
      throwIfCallerCancelled(callerSignal);
      if (deadlineReached()) {
        flags.deadline = true;
        break;
      }
      const path = this.localPath(rawCandidate.uri);
      if (path === null) {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }
      let before: WorkspaceFileDiscoveryEntryStat;
      try {
        before = await this.#host.lstat(path);
      } catch {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }
      if (before.kind !== 'file') {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }
      const authorization = await authorizeWorkspaceDocument({
        workspaceIdentity: identity,
        reference: rawCandidate.uri,
        realpath: (value) => this.#host.realpath(value),
        pathStrategy: this.#pathStrategy,
      });
      if (
        !authorization.ok ||
        authorization.document.workspaceFolderId !== workspaceFolderId
      ) {
        counts.external = saturatingAdd(counts.external, 1);
        continue;
      }
      let after: WorkspaceFileDiscoveryEntryStat;
      try {
        after = await this.#host.lstat(path);
      } catch {
        counts.changed = saturatingAdd(counts.changed, 1);
        continue;
      }
      if (!sameEntry(before, after)) {
        counts.changed = saturatingAdd(counts.changed, 1);
        continue;
      }
      if (
        after.size > V02_READ_TOOL_LIMITS.searchWorkspaceText.closedFileBytes ||
        !WorkspaceRelativePathSchema.safeParse(authorization.document.relativePath)
          .success
      ) {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }
      const key = this.canonicalKey(authorization.document.canonicalPath);
      if (canonical.has(key)) {
        continue;
      }
      canonical.add(key);
      candidates.push({
        canonicalPath: authorization.document.canonicalPath,
        relativePath: authorization.document.relativePath,
        stat: after,
      });
    }
    candidates.sort((left, right) =>
      compareCodePoints(left.relativePath, right.relativePath),
    );
    return candidates;
  }

  private async liveDocumentMap(
    identity: WorkspaceIdentity,
    workspaceFolderId: string,
    counts: SearchCounts,
    flags: SearchFlags,
    signal: AbortSignal,
    callerSignal: AbortSignal,
  ): Promise<Map<string, EditorHostDocument>> {
    const source = this.#host.openDocuments();
    if ((source.omittedCount ?? 0) > 0) {
      flags.openDocuments = true;
    }
    const documents = new Map<string, EditorHostDocument>();
    for (const document of source) {
      throwIfCallerCancelled(callerSignal);
      if (signal.aborted) {
        break;
      }
      const authorization = await authorizeWorkspaceDocument({
        workspaceIdentity: identity,
        reference: document.uri,
        realpath: (value) => this.#host.realpath(value),
        pathStrategy: this.#pathStrategy,
      });
      if (!authorization.ok) {
        continue;
      }
      if (authorization.document.workspaceFolderId !== workspaceFolderId) {
        continue;
      }
      if (!validLiveDocument(document)) {
        counts.unsupported = saturatingAdd(counts.unsupported, 1);
        continue;
      }
      documents.set(this.canonicalKey(authorization.document.canonicalPath), document);
    }
    return documents;
  }

  private scanLiveCandidate(
    candidate: Candidate,
    document: EditorHostDocument,
    query: string,
    caseSensitive: boolean,
    wholeWord: boolean,
    contextLines: number,
    maximumMatches: number,
    remainingBytes: number,
    signal: AbortSignal,
    callerSignal: AbortSignal,
  ): ScanOutcome {
    const version = document.version;
    let liveText: LiveTextResult;
    try {
      liveText = liveDocumentText(document, remainingBytes, signal, callerSignal);
    } catch (error) {
      throwIfCallerCancelled(callerSignal);
      if (signal.aborted) {
        return { kind: 'aggregate' };
      }
      void error;
      return { kind: 'unsupported' };
    }
    if (signal.aborted) {
      return { kind: 'aggregate' };
    }
    if (liveText.tooLarge) {
      return { kind: 'aggregate' };
    }
    const matched = literalMatches(
      liveText.text,
      query,
      caseSensitive,
      wholeWord,
      contextLines,
      maximumMatches,
    );
    if (document.version !== version) {
      return { kind: 'changed' };
    }
    return {
      kind: 'success',
      inspectedBytes: liveText.bytes,
      state: { source: 'live', documentVersion: version, isDirty: document.isDirty },
      matches: matched.matches,
      contextOmitted: matched.contextOmitted,
    };
  }

  private async scanClosedCandidate(
    candidate: Candidate,
    query: string,
    caseSensitive: boolean,
    wholeWord: boolean,
    contextLines: number,
    maximumMatches: number,
    remainingBytes: number,
    signal: AbortSignal,
    callerSignal: AbortSignal,
  ): Promise<ScanOutcome> {
    if (candidate.stat.size > remainingBytes) {
      return { kind: 'aggregate' };
    }
    let read: Awaited<ReturnType<WorkspaceTextSearchHost['readFile']>>;
    try {
      read = await this.#scheduler.run(signal, () =>
        this.#host.readFile(candidate.canonicalPath, signal),
      );
    } catch (error) {
      throwIfCallerCancelled(callerSignal);
      if (signal.aborted) {
        void error;
        return { kind: 'aggregate' };
      }
      return { kind: 'unsupported' };
    }
    throwIfCallerCancelled(callerSignal);
    if (signal.aborted) {
      return { kind: 'aggregate' };
    }
    if (
      !sameEntry(candidate.stat, read.before) ||
      !sameEntry(read.before, read.after) ||
      read.bytes.byteLength !== read.after.size
    ) {
      return { kind: 'changed' };
    }
    if (read.bytes.subarray(0, 8_192).includes(0)) {
      return { kind: 'unsupported' };
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
    } catch {
      return { kind: 'unsupported' };
    }
    const inspectedBytes = Buffer.byteLength(text, 'utf8');
    if (inspectedBytes > remainingBytes) {
      return { kind: 'aggregate' };
    }
    let modifiedAt: string;
    try {
      modifiedAt = new Date(read.after.modifiedTime).toISOString();
    } catch {
      return { kind: 'unsupported' };
    }
    const matched = literalMatches(
      text,
      query,
      caseSensitive,
      wholeWord,
      contextLines,
      maximumMatches,
    );
    return {
      kind: 'success',
      inspectedBytes,
      state: { source: 'disk', sizeBytes: read.after.size, modifiedAt },
      matches: matched.matches,
      contextOmitted: matched.contextOmitted,
    };
  }

  private buildSuccess(
    workspaceFolderId: string,
    query: string,
    binding: WorkspaceDiscoveryCursorBinding,
    offset: number,
    documents: SearchDocument[],
    hasMore: boolean,
    counts: SearchCounts,
    flags: SearchFlags,
  ): V02SearchWorkspaceTextSuccess | null {
    const returnedMatchCount = documents.reduce(
      (total, document) => total + document.matches.length,
      0,
    );
    const last = documents.at(-1);
    const lastMatch = last?.matches.at(-1);
    const nextCursor =
      hasMore && last !== undefined && lastMatch !== undefined
        ? this.#cursorCodec.encode(binding, {
            offset: offset + returnedMatchCount,
            sortTupleHash: hashWorkspaceDiscoverySortTuple(
              JSON.stringify({
                path: last.document.relativePath,
                range: lastMatch.range,
              }),
            ),
          })
        : null;
    const warnings = createWarnings(counts, flags);
    const parsed = V02SearchWorkspaceTextSuccessSchema.safeParse({
      contractVersion: '0.2.0',
      instanceId: this.#instanceId,
      observedAt: this.#now().toISOString(),
      truncated: warnings.length > 0,
      warnings,
      result: {
        workspaceFolderId,
        query,
        documents,
        returnedMatchCount,
        hasMore,
        nextCursor,
      },
    });
    return parsed.success ? parsed.data : null;
  }

  private async requireWorkspaceAccess(
    signal: AbortSignal,
  ): Promise<Extract<WorkspaceTextSearchAccess, { readonly eligible: true }>> {
    throwIfCallerCancelled(signal);
    let access: WorkspaceTextSearchAccess;
    try {
      access = await this.#getWorkspaceAccess();
    } catch {
      throw failure('INTERNAL_ERROR', 'The workspace check failed.', false);
    }
    throwIfCallerCancelled(signal);
    if (!access.eligible) {
      throw failure('WORKSPACE_UNTRUSTED', 'The workspace is not eligible.', false);
    }
    return access;
  }

  private async requireSameWorkspaceAccess(
    original: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.requireWorkspaceAccess(signal);
    if (current.identity.fingerprint !== original.fingerprint) {
      throw failure(
        'WORKSPACE_UNTRUSTED',
        'The eligible workspace changed while the request was running.',
        true,
      );
    }
  }

  private localPath(uri: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== 'file:' ||
      (parsed.hostname.length > 0 && parsed.hostname !== 'localhost') ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    try {
      const path = this.#pathStrategy.fileUriToPath(parsed);
      return this.#pathStrategy.isAbsolute(path) && !path.includes('\0') ? path : null;
    } catch {
      return null;
    }
  }

  private canonicalKey(path: string): string {
    const normalized = this.#pathStrategy.normalize(path);
    return this.#pathStrategy.caseSensitive ? normalized : normalized.toLowerCase();
  }
}

type ScanOutcome =
  | { readonly kind: 'aggregate' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'changed' }
  | {
      readonly kind: 'success';
      readonly inspectedBytes: number;
      readonly state: SearchDocument['state'];
      readonly matches: SearchMatch[];
      readonly contextOmitted: boolean;
    };

interface LiteralMatchResult {
  readonly matches: SearchMatch[];
  readonly contextOmitted: boolean;
}

type LiveTextResult =
  | { readonly tooLarge: true }
  | { readonly tooLarge: false; readonly text: string; readonly bytes: number };

function literalMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
  contextLines: number,
  maximumMatches: number,
): LiteralMatchResult {
  const expression = new RegExp(escapeRegExp(query), caseSensitive ? 'gu' : 'giu');
  const lineStarts = createLineStarts(text);
  const matches: SearchMatch[] = [];
  let contextOmitted = false;
  for (const result of text.matchAll(expression)) {
    if (matches.length >= maximumMatches) {
      break;
    }
    const start = result.index;
    const matched = result[0];
    const end = start + matched.length;
    if (wholeWord && !isWholeWord(text, start, end)) {
      continue;
    }
    const range = {
      start: offsetPosition(lineStarts, start),
      end: offsetPosition(lineStarts, end),
    };
    const context = createContext(text, lineStarts, range, start, end, contextLines);
    if (contextLines > 0 && context === null) {
      contextOmitted = true;
    }
    matches.push({
      range,
      context,
    });
  }
  return { matches, contextOmitted };
}

function createContext(
  text: string,
  lineStarts: readonly number[],
  range: SearchMatch['range'],
  matchStart: number,
  matchEnd: number,
  contextLines: number,
): NonNullable<SearchMatch['context']> | null {
  if (contextLines === 0) {
    return null;
  }
  const startLine = Math.max(0, range.start.line - contextLines);
  const endLine = Math.min(lineStarts.length - 1, range.end.line + contextLines);
  const contextStart = lineStarts[startLine] ?? 0;
  const nextLineStart = lineStarts[endLine + 1];
  const contextEnd =
    nextLineStart === undefined ? text.length : trimLineBreakEnd(text, nextLineStart);
  const contextText = text.slice(contextStart, contextEnd);
  if (
    Buffer.byteLength(contextText, 'utf8') >
    V02_READ_TOOL_LIMITS.searchWorkspaceText.contextSnippetBytes
  ) {
    return null;
  }
  return {
    range: {
      start: { line: startLine, character: 0 },
      end: offsetPosition(lineStarts, contextEnd),
    },
    text: contextText,
    highlightRange: {
      start: offsetPosition(createLineStarts(contextText), matchStart - contextStart),
      end: offsetPosition(createLineStarts(contextText), matchEnd - contextStart),
    },
  };
}

function groupMatches(
  workspaceFolderId: string,
  matches: readonly FlatMatch[],
): SearchDocument[] {
  const documents: SearchDocument[] = [];
  for (const entry of matches) {
    const current = documents.at(-1);
    if (current?.document.relativePath === entry.relativePath) {
      current.matches.push(entry.match);
    } else {
      documents.push({
        document: { workspaceFolderId, relativePath: entry.relativePath },
        state: entry.state,
        matches: [entry.match],
      });
    }
  }
  return documents;
}

function liveDocumentText(
  document: EditorHostDocument,
  maximumBytes: number,
  signal: AbortSignal,
  callerSignal: AbortSignal,
): LiveTextResult {
  const eol = document.eol === 'CRLF' ? '\r\n' : '\n';
  let text = '';
  let bytes = 0;
  for (let line = 0; line < document.lineCount; line += 1) {
    throwIfCallerCancelled(callerSignal);
    if (signal.aborted) {
      break;
    }
    const lineText = document.lineText(line);
    const piece = line === 0 ? lineText : `${eol}${lineText}`;
    const pieceBytes = Buffer.byteLength(piece, 'utf8');
    if (bytes + pieceBytes > maximumBytes) {
      return { tooLarge: true };
    }
    text += piece;
    bytes += pieceBytes;
  }
  return { tooLarge: false, text, bytes };
}

function validLiveDocument(document: EditorHostDocument): boolean {
  return (
    Number.isSafeInteger(document.version) &&
    document.version >= 0 &&
    Number.isSafeInteger(document.lineCount) &&
    document.lineCount > 0 &&
    (document.eol === 'LF' || document.eol === 'CRLF')
  );
}

function createLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetPosition(lineStarts: readonly number[], offset: number) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low, character: offset - (lineStarts[low] ?? 0) };
}

function trimLineBreakEnd(text: string, nextLineStart: number): number {
  let end = nextLineStart;
  if (end > 0 && text.charCodeAt(end - 1) === 10) {
    end -= 1;
  }
  if (end > 0 && text.charCodeAt(end - 1) === 13) {
    end -= 1;
  }
  return end;
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const first = scalarAt(text, start);
  const last = scalarBefore(text, end);
  const before = scalarBefore(text, start);
  const after = scalarAt(text, end);
  return isWord(first) !== isWord(before) && isWord(last) !== isWord(after);
}

function scalarAt(text: string, offset: number): string | null {
  if (offset < 0 || offset >= text.length) {
    return null;
  }
  const point = text.codePointAt(offset);
  return point === undefined ? null : String.fromCodePoint(point);
}

function scalarBefore(text: string, offset: number): string | null {
  if (offset <= 0 || offset > text.length) {
    return null;
  }
  const last = text.charCodeAt(offset - 1);
  const start = last >= 0xdc00 && last <= 0xdfff ? offset - 2 : offset - 1;
  return scalarAt(text, Math.max(0, start));
}

function isWord(value: string | null): boolean {
  return value !== null && WORD_CHARACTER.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sameEntry(
  left: WorkspaceFileDiscoveryEntryStat,
  right: WorkspaceFileDiscoveryEntryStat,
): boolean {
  return (
    left.kind === 'file' &&
    right.kind === 'file' &&
    left.identity === right.identity &&
    left.size === right.size &&
    left.modifiedTime === right.modifiedTime
  );
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function createWarnings(counts: SearchCounts, flags: SearchFlags) {
  const warnings: Array<{
    code: V02WarningCode;
    message: string;
    omittedCount?: number;
  }> = [];
  if (flags.output) {
    warnings.push({
      code: 'RESULTS_TRUNCATED',
      message: 'The serialized result limit was reached.',
    });
  }
  if (flags.context) {
    warnings.push({
      code: 'CONTENT_TRUNCATED',
      message: 'Optional match context was omitted.',
    });
  }
  if (counts.external > 0) {
    warnings.push({
      code: 'EXTERNAL_LOCATIONS_OMITTED',
      message: 'Entries outside the selected workspace authority were omitted.',
      omittedCount: counts.external,
    });
  }
  if (counts.unsupported > 0) {
    warnings.push({
      code: 'UNSUPPORTED_ITEMS_OMITTED',
      message: 'Unsupported or unreadable entries were omitted.',
      omittedCount: counts.unsupported,
    });
  }
  if (flags.candidate || flags.aggregate || flags.deadline || flags.openDocuments) {
    warnings.push({
      code: 'RESOURCE_LIMIT_REACHED',
      message: 'A search resource limit was reached.',
    });
  }
  if (counts.changed > 0) {
    warnings.push({
      code: 'FILES_CHANGED_DURING_REQUEST',
      message: 'Entries changed during search and were omitted.',
      omittedCount: counts.changed,
    });
  }
  warnings.sort(
    (left, right) =>
      WARNING_ORDER.indexOf(left.code) - WARNING_ORDER.indexOf(right.code),
  );
  return warnings;
}

function throwIfCallerCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw failure('CANCELLED', 'The request was cancelled.', true);
  }
}

function failure(
  code: SearchErrorCode,
  message: string,
  retryable: boolean,
): WorkspaceTextSearchError {
  return new WorkspaceTextSearchError(code, message, retryable);
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
