import { Buffer } from 'node:buffer';

import {
  PROVIDER_OUTPUT_LIMITS,
  SCHEMA_LIMITS,
  TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
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
  ExtensionToolInvocationSchema,
  GetDiagnosticsResultSchema,
  GetHoverResultSchema,
  GetSignatureHelpResultSchema,
  type ExtensionToolName,
  type GetDiagnosticsArguments,
  type GetDiagnosticsResult,
  type GetHoverArguments,
  type GetHoverResult,
  type GetSignatureHelpArguments,
  type GetSignatureHelpResult,
  type Warning,
} from '@vscode-mcp/protocol/tool-schemas';

import type {
  EditorHostDocument,
  EditorToolWorkspaceAccess,
} from './editor-tool-host.js';
import type { LanguageToolHost } from './language-tool-host.js';
import {
  limitBoundedProviderItems,
  readBoundedProviderItems,
  saturatingAddProviderCounts,
  type BoundedProviderItems,
} from './provider-output-bounds.js';
import {
  authorizeWorkspaceDocument,
  type AuthorizedWorkspaceDocument,
  type WorkspaceAuthorizationErrorCode,
  type WorkspaceAuthorizationPathStrategy,
} from './workspace-authorizer.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

export const LANGUAGE_EXTENSION_TOOL_NAMES = [
  'get_diagnostics',
  'get_hover',
  'get_signature_help',
] as const satisfies readonly ExtensionToolName[];

type LanguageToolName = (typeof LANGUAGE_EXTENSION_TOOL_NAMES)[number];
type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';
type DiagnosticResult =
  GetDiagnosticsResult['documents'][number]['diagnostics'][number];
type DiagnosticDocumentResult = GetDiagnosticsResult['documents'][number];
type HoverResultEntry = GetHoverResult['hovers'][number];
type SignatureResultEntry = GetSignatureHelpResult['signatures'][number];
type MarkupContent = NonNullable<SignatureResultEntry['documentation']>;

const ALL_DIAGNOSTIC_SEVERITIES = [
  'error',
  'warning',
  'information',
  'hint',
] as const satisfies readonly DiagnosticSeverity[];
const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
};

export interface LanguageToolServiceOptions {
  readonly host: LanguageToolHost;
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

interface VersionedHostDocument extends AuthorizedHostDocument {
  readonly initialVersion: number;
}

interface DiagnosticsFreshness {
  readonly state: 'settled' | 'changing' | 'unknown';
  readonly heuristic: true;
  readonly quietPeriodMs: typeof TOOL_LIMITS.diagnostics.quietPeriodMs;
  readonly waitedMs: number;
  readonly lastChangeAt: string | null;
}

interface DiagnosticsProviderBudget {
  remainingItems: number;
  remainingRelatedInformation: number;
}

interface DiagnosticProviderSnapshot {
  readonly value: unknown;
  readonly tags: BoundedProviderItems<unknown> | null;
  readonly relatedInformation: BoundedProviderItems<unknown> | null;
}

interface DiagnosticsPublicBudget {
  remainingRelatedInformation: number;
}

/**
 * Pure implementation of diagnostics, hover, and signature help. VS Code is kept
 * behind `LanguageToolHost`, while all provider payloads are treated as untrusted.
 */
export class LanguageToolService {
  readonly #host: LanguageToolHost;
  readonly #getWorkspaceAccess: LanguageToolServiceOptions['getWorkspaceAccess'];
  readonly #realpath: LanguageToolServiceOptions['realpath'];
  readonly #pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly #now: () => Date;

  public constructor(options: LanguageToolServiceOptions) {
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
    const recognizedTool = recognizeLanguageTool(untrustedInvocation);
    if (recognizedTool === null) {
      throw new Error('The language tool invocation is not recognized.');
    }

    const parsed = ExtensionToolInvocationSchema.safeParse(untrustedInvocation);
    if (!parsed.success) {
      return toolError(
        recognizedTool,
        failure('INVALID_ARGUMENT', 'The tool arguments are invalid.', false),
      );
    }

    try {
      throwIfCancelled(signal);
      switch (parsed.data.tool) {
        case 'get_diagnostics':
          return await this.getDiagnostics(parsed.data.arguments, signal);
        case 'get_hover':
          return await this.getHover(parsed.data.arguments, signal);
        case 'get_signature_help':
          return await this.getSignatureHelp(parsed.data.arguments, signal);
        default:
          throw new Error('The invocation was routed to the wrong tool service.');
      }
    } catch (error) {
      return toolError(recognizedTool, normalizeFailure(error, signal));
    }
  };

  private async getDiagnostics(
    arguments_: GetDiagnosticsArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const warnings = new WarningAccumulator();
    const documents =
      arguments_.document === undefined
        ? await this.accessibleOpenDocuments(access.identity, signal, warnings)
        : [
            await this.resolveRequestedDocument(
              access.identity,
              arguments_.document,
              signal,
            ),
          ];

    const versionedDocuments = documents.map((document) => ({
      ...document,
      initialVersion: validDocumentVersion(document.hostDocument.version),
    }));
    if (
      arguments_.expectedDocumentVersion !== undefined &&
      versionedDocuments[0]?.initialVersion !== arguments_.expectedDocumentVersion
    ) {
      throw versionMismatch(
        arguments_.expectedDocumentVersion,
        versionedDocuments[0]?.initialVersion ?? 0,
      );
    }

    const relevantUris = new Set(
      versionedDocuments.map((document) => document.hostDocument.uri),
    );
    const freshness = await this.waitForDiagnosticsQuiet(
      relevantUris,
      () => {
        // Freshness is event/quiet-period based, not a deep-equality claim. Observing
        // each collection with a zero-item snapshot avoids a first eager traversal;
        // the single post-wait read owns the request-wide 8,000-item raw budget.
        const snapshotBudget: DiagnosticsProviderBudget = {
          remainingItems: 0,
          remainingRelatedInformation: 0,
        };
        for (const document of versionedDocuments) {
          this.readRawDiagnostics(document.hostDocument.uri, snapshotBudget);
        }
      },
      signal,
    );

    await this.assertDocumentsUnchanged(versionedDocuments, access.identity, signal);

    const allowedSeverities = new Set(
      arguments_.severities ?? ALL_DIAGNOSTIC_SEVERITIES,
    );
    const includeRelatedInformation = arguments_.includeRelatedInformation ?? true;
    const normalizedDocuments: DiagnosticDocumentResult[] = [];
    const providerBudget = createDiagnosticsProviderBudget(includeRelatedInformation);
    const publicBudget: DiagnosticsPublicBudget = {
      remainingRelatedInformation:
        TOOL_LIMITS.diagnostics.relatedInformationPerRequestMax,
    };

    for (const document of versionedDocuments) {
      throwIfCancelled(signal);
      const rawDiagnostics = this.readRawDiagnostics(
        document.hostDocument.uri,
        providerBudget,
      );
      const diagnostics: DiagnosticResult[] = [];
      warnings.addResults(rawDiagnostics.omittedCount);

      for (let index = 0; index < rawDiagnostics.items.length; index += 1) {
        throwIfCancelled(signal);
        const rawDiagnostic = rawDiagnostics.items[index];
        if (rawDiagnostic === undefined) {
          throw new ToolFailure(internalFailure());
        }
        const normalized = await this.normalizeDiagnostic(
          rawDiagnostic,
          document.hostDocument,
          access.identity,
          allowedSeverities,
          includeRelatedInformation,
          publicBudget,
          warnings,
          signal,
        );
        if (normalized !== null) {
          diagnostics.push(normalized);
        }
      }
      diagnostics.sort(compareDiagnostics);
      normalizedDocuments.push({
        document: createDocumentSnapshot(document.hostDocument, document.authorization),
        diagnostics,
      });
    }

    normalizedDocuments.sort((left, right) =>
      compareText(left.document.uri, right.document.uri),
    );
    const limit = arguments_.limit ?? TOOL_LIMITS.diagnostics.itemsDefault;
    let remaining = limit;
    for (const document of normalizedDocuments) {
      if (document.diagnostics.length <= remaining) {
        remaining -= document.diagnostics.length;
        continue;
      }
      const omitted = document.diagnostics.length - remaining;
      document.diagnostics.splice(remaining);
      warnings.addResults(omitted);
      remaining = 0;
    }

    await this.assertDocumentsUnchanged(versionedDocuments, access.identity, signal);
    const result = GetDiagnosticsResultSchema.parse({
      coverage:
        arguments_.document === undefined ? 'open_documents' : 'requested_document',
      freshness,
      documents: normalizedDocuments,
    });
    return toolSuccess('get_diagnostics', result, warnings, this.#now);
  }

  private async getHover(
    arguments_: GetHoverArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const document = await this.preparePositionDocument(
      access.identity,
      arguments_.document,
      arguments_.position,
      arguments_.expectedDocumentVersion,
      signal,
    );
    const warnings = new WarningAccumulator();

    throwIfCancelled(signal);
    const raw = await this.callProvider(
      () => this.#host.provideHover(document.hostDocument.uri, arguments_.position),
      document,
      signal,
    );
    await this.assertDocumentsUnchanged([document], access.identity, signal);
    const hovers = normalizeHoverPayload(raw, document.hostDocument, warnings, signal);
    await this.assertDocumentsUnchanged([document], access.identity, signal);

    const result = GetHoverResultSchema.parse({
      document: createDocumentSnapshot(document.hostDocument, document.authorization),
      hovers,
    });
    return toolSuccess('get_hover', result, warnings, this.#now);
  }

  private async getSignatureHelp(
    arguments_: GetSignatureHelpArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const document = await this.preparePositionDocument(
      access.identity,
      arguments_.document,
      arguments_.position,
      arguments_.expectedDocumentVersion,
      signal,
    );
    const warnings = new WarningAccumulator();

    throwIfCancelled(signal);
    const raw = await this.callProvider(
      () =>
        this.#host.provideSignatureHelp(
          document.hostDocument.uri,
          arguments_.position,
          arguments_.triggerCharacter,
        ),
      document,
      signal,
    );
    await this.assertDocumentsUnchanged([document], access.identity, signal);
    const normalized = normalizeSignatureHelpPayload(raw, warnings, signal);
    await this.assertDocumentsUnchanged([document], access.identity, signal);

    const result = GetSignatureHelpResultSchema.parse({
      document: createDocumentSnapshot(document.hostDocument, document.authorization),
      ...normalized,
    });
    return toolSuccess('get_signature_help', result, warnings, this.#now);
  }

  private async preparePositionDocument(
    identity: WorkspaceIdentity,
    reference: Parameters<typeof authorizeWorkspaceDocument>[0]['reference'],
    position: Position,
    expectedDocumentVersion: number | undefined,
    signal: AbortSignal,
  ): Promise<VersionedHostDocument> {
    const resolved = await this.resolveRequestedDocument(identity, reference, signal);
    const initialVersion = validDocumentVersion(resolved.hostDocument.version);
    if (
      expectedDocumentVersion !== undefined &&
      expectedDocumentVersion !== initialVersion
    ) {
      throw versionMismatch(expectedDocumentVersion, initialVersion);
    }
    if (normalizePosition(position, resolved.hostDocument) === null) {
      throw new ToolFailure(
        failure(
          'POSITION_OUT_OF_RANGE',
          'The requested position is outside the document.',
          false,
        ),
      );
    }
    return { ...resolved, initialVersion };
  }

  private async normalizeDiagnostic(
    raw: DiagnosticProviderSnapshot,
    document: EditorHostDocument,
    identity: WorkspaceIdentity,
    allowedSeverities: ReadonlySet<DiagnosticSeverity>,
    includeRelatedInformation: boolean,
    publicBudget: DiagnosticsPublicBudget,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<DiagnosticResult | null> {
    const record = asRecord(raw.value);
    if (record === null) {
      warnings.addUnsupported(1);
      return null;
    }
    const severity = normalizeSeverity(record['severity']);
    if (severity === null) {
      warnings.addUnsupported(1);
      return null;
    }
    if (!allowedSeverities.has(severity)) {
      return null;
    }
    const range = normalizeRange(record['range'], document);
    if (range === null || typeof record['message'] !== 'string') {
      warnings.addUnsupported(1);
      return null;
    }

    const message = truncateUtf8(
      record['message'],
      TOOL_LIMITS.diagnostics.messageBytes,
      warnings,
    );
    const source = normalizeOptionalBoundedString(
      record['source'],
      SCHEMA_LIMITS.displayNameCharacters,
      warnings,
    );
    const code = await this.normalizeDiagnosticCode(
      record['code'],
      identity,
      warnings,
      signal,
    );
    const tags = normalizeDiagnosticTags(raw.tags, warnings);
    const relatedInformation: DiagnosticResult['relatedInformation'] = [];

    if (includeRelatedInformation) {
      if (raw.relatedInformation === null) {
        warnings.addUnsupported(1);
      } else {
        const boundedRelated = limitBoundedProviderItems(
          raw.relatedInformation,
          Math.min(
            TOOL_LIMITS.diagnostics.relatedInformationPerItemMax,
            publicBudget.remainingRelatedInformation,
          ),
        );
        publicBudget.remainingRelatedInformation -= boundedRelated.items.length;
        warnings.addResults(boundedRelated.omittedCount);
        for (let index = 0; index < boundedRelated.items.length; index += 1) {
          throwIfCancelled(signal);
          const information = await this.normalizeRelatedInformation(
            boundedRelated.items[index],
            identity,
            warnings,
            signal,
          );
          if (information !== null) {
            relatedInformation.push(information);
          }
        }
      }
    }

    return { range, severity, message, source, code, tags, relatedInformation };
  }

  private async normalizeDiagnosticCode(
    raw: unknown,
    identity: WorkspaceIdentity,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<DiagnosticResult['code']> {
    if (raw === undefined || raw === null) {
      return null;
    }

    let rawValue: unknown = raw;
    let rawTargetUri: unknown = null;
    const record = asRecord(raw);
    if (record !== null) {
      rawValue = record['value'];
      rawTargetUri = record['targetUri'];
    }
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
      warnings.addUnsupported(1);
      return null;
    }
    const value = truncateUtf16(
      String(rawValue),
      SCHEMA_LIMITS.diagnosticCodeCharacters,
      warnings,
    );
    if (rawTargetUri === undefined || rawTargetUri === null) {
      return { value, targetUri: null };
    }
    if (typeof rawTargetUri !== 'string') {
      warnings.addUnsupported(1);
      return { value, targetUri: null };
    }

    throwIfCancelled(signal);
    const authorization = await this.authorize(identity, rawTargetUri);
    if (!authorization.ok) {
      warnings.addAuthorization(authorization.errorCode);
      return { value, targetUri: null };
    }
    return { value, targetUri: authorization.document.uri };
  }

  private async normalizeRelatedInformation(
    raw: unknown,
    identity: WorkspaceIdentity,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<DiagnosticResult['relatedInformation'][number] | null> {
    const record = asRecord(raw);
    if (
      record === null ||
      typeof record['uri'] !== 'string' ||
      typeof record['message'] !== 'string'
    ) {
      warnings.addUnsupported(1);
      return null;
    }

    const authorization = await this.authorize(identity, record['uri']);
    if (!authorization.ok) {
      warnings.addAuthorization(authorization.errorCode);
      return null;
    }

    let relatedDocument: AuthorizedHostDocument;
    try {
      relatedDocument = await this.resolveAuthorizedDocument(
        authorization.document,
        identity,
        signal,
      );
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof ToolFailure && error.data.code === 'CANCELLED')
      ) {
        throw error;
      }
      warnings.addUnsupported(1);
      return null;
    }
    const range = normalizeRange(record['range'], relatedDocument.hostDocument);
    if (range === null) {
      warnings.addUnsupported(1);
      return null;
    }
    return {
      uri: relatedDocument.authorization.uri,
      range,
      message: truncateUtf8(
        record['message'],
        TOOL_LIMITS.diagnostics.messageBytes,
        warnings,
      ),
    };
  }

  private readRawDiagnostics(
    uri: string,
    budget: DiagnosticsProviderBudget,
  ): BoundedProviderItems<DiagnosticProviderSnapshot> {
    try {
      const raw = this.#host.diagnostics(uri, {
        items: budget.remainingItems,
        relatedInformation: budget.remainingRelatedInformation,
      });
      const bounded = readBoundedProviderItems(raw, budget.remainingItems);
      if (bounded === null) {
        throw new Error('The language host returned an invalid diagnostic snapshot.');
      }
      budget.remainingItems -= bounded.items.length;

      const items: DiagnosticProviderSnapshot[] = [];
      for (let index = 0; index < bounded.items.length; index += 1) {
        const value = bounded.items[index];
        const record = asRecord(value);
        const tags = readOptionalProviderItems(
          record?.['tags'],
          PROVIDER_OUTPUT_LIMITS.diagnostics.tagsPerItemMax,
        );
        const relatedInformation = readOptionalProviderItems(
          record?.['relatedInformation'],
          Math.min(
            budget.remainingRelatedInformation,
            PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerItemMax,
          ),
        );
        if (relatedInformation !== null) {
          budget.remainingRelatedInformation -= relatedInformation.items.length;
        }
        items.push({ value, tags, relatedInformation });
      }
      return { items, omittedCount: bounded.omittedCount };
    } catch {
      throw new ToolFailure(internalFailure());
    }
  }

  private async waitForDiagnosticsQuiet(
    relevantUris: ReadonlySet<string>,
    snapshot: () => void,
    signal: AbortSignal,
  ): Promise<DiagnosticsFreshness> {
    if (relevantUris.size === 0) {
      return unknownFreshness();
    }

    let subscription: ReturnType<LanguageToolHost['onDiagnosticsChanged']>;
    let lastChangeAt: string | null = null;
    let lastChangeMonotonic: number | null = null;
    let incompleteChangeEvent = false;
    let wake: (() => void) | null = null;
    try {
      subscription = this.#host.onDiagnosticsChanged((uris) => {
        let relevant = uris.omittedCount > 0;
        if (uris.omittedCount > 0) {
          incompleteChangeEvent = true;
        }
        for (let index = 0; !relevant && index < uris.items.length; index += 1) {
          const uri = uris.items[index];
          relevant = uri !== undefined && relevantUris.has(uri);
        }
        if (!relevant) {
          return;
        }
        lastChangeAt = this.#now().toISOString();
        lastChangeMonotonic = Date.now();
        wake?.();
      });
    } catch {
      snapshot();
      return unknownFreshness();
    }

    const startedAt = Date.now();
    try {
      snapshot();
      while (true) {
        throwIfCancelled(signal);
        const current = Date.now();
        const quietBase = lastChangeMonotonic ?? startedAt;
        const quietRemaining =
          TOOL_LIMITS.diagnostics.quietPeriodMs - (current - quietBase);
        const maximumRemaining =
          TOOL_LIMITS.diagnostics.maximumWaitMs - (current - startedAt);
        if (quietRemaining <= 0) {
          return {
            state: incompleteChangeEvent ? 'unknown' : 'settled',
            heuristic: true,
            quietPeriodMs: TOOL_LIMITS.diagnostics.quietPeriodMs,
            waitedMs: boundedWaitedMs(startedAt),
            lastChangeAt,
          };
        }
        if (maximumRemaining <= 0) {
          return {
            state: 'changing',
            heuristic: true,
            quietPeriodMs: TOOL_LIMITS.diagnostics.quietPeriodMs,
            waitedMs: TOOL_LIMITS.diagnostics.maximumWaitMs,
            lastChangeAt,
          };
        }

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const complete = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            wake = null;
            resolve();
          };
          const cancel = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            wake = null;
            reject(cancelledFailure());
          };
          const timer = setTimeout(
            complete,
            Math.max(1, Math.min(quietRemaining, maximumRemaining)),
          );
          wake = complete;
          signal.addEventListener('abort', cancel, { once: true });
        });
      }
    } finally {
      subscription.dispose();
    }
  }

  private async callProvider(
    operation: () => Promise<unknown>,
    document: VersionedHostDocument,
    signal: AbortSignal,
  ): Promise<unknown> {
    let documentChanged = false;
    let subscription: ReturnType<LanguageToolHost['onDocumentChanged']>;
    try {
      subscription = this.#host.onDocumentChanged((uri) => {
        if (
          uri === document.hostDocument.uri &&
          document.hostDocument.version !== document.initialVersion
        ) {
          documentChanged = true;
        }
      });
    } catch {
      throw new ToolFailure(internalFailure());
    }

    try {
      throwIfCancelled(signal);
      if (document.hostDocument.version !== document.initialVersion) {
        throw documentChangedFailure();
      }
      let providerResult: unknown;
      let providerFailed = false;
      try {
        providerResult = await operation();
      } catch {
        providerFailed = true;
      }
      throwIfCancelled(signal);
      if (
        documentChanged ||
        document.hostDocument.version !== document.initialVersion
      ) {
        throw documentChangedFailure();
      }
      if (providerFailed) {
        throw new ToolFailure(internalFailure());
      }
      return providerResult;
    } finally {
      subscription.dispose();
    }
  }

  private async accessibleOpenDocuments(
    identity: WorkspaceIdentity,
    signal: AbortSignal,
    warnings: WarningAccumulator,
  ): Promise<AuthorizedHostDocument[]> {
    const documents: AuthorizedHostDocument[] = [];
    const candidates = this.#host.openDocuments();
    const scanCount = Math.min(
      candidates.availableCount,
      TOOL_LIMITS.diagnostics.documentsMax,
    );
    warnings.addResults(
      saturatingAddProviderCounts(
        candidates.omittedCount,
        candidates.availableCount - scanCount,
      ),
    );
    let inspectedCount = 0;
    for (const candidate of candidates) {
      if (inspectedCount >= scanCount) {
        break;
      }
      inspectedCount += 1;
      throwIfCancelled(signal);
      const authorization = await this.authorize(identity, candidate.uri);
      if (!authorization.ok) {
        warnings.addAuthorization(authorization.errorCode);
        continue;
      }
      if (
        documents.some((existing) =>
          canonicalPathsEqual(
            existing.authorization.canonicalPath,
            authorization.document.canonicalPath,
            this.#pathStrategy,
          ),
        )
      ) {
        continue;
      }
      documents.push({
        hostDocument: candidate,
        authorization: authorization.document,
      });
    }
    return documents;
  }

  private async resolveRequestedDocument(
    identity: WorkspaceIdentity,
    reference: Parameters<typeof authorizeWorkspaceDocument>[0]['reference'],
    signal: AbortSignal,
  ): Promise<AuthorizedHostDocument> {
    const authorization = await this.authorize(identity, reference);
    if (!authorization.ok) {
      throw authorizationFailure(authorization.errorCode);
    }
    return this.resolveAuthorizedDocument(authorization.document, identity, signal);
  }

  private async resolveAuthorizedDocument(
    target: AuthorizedWorkspaceDocument,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<AuthorizedHostDocument> {
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
        return { hostDocument: candidate, authorization: authorization.document };
      }
    }

    let stat: Awaited<ReturnType<LanguageToolHost['statFile']>>;
    throwIfCancelled(signal);
    try {
      stat = await this.#host.statFile(target.canonicalPath);
      throwIfCancelled(signal);
    } catch (error) {
      if (signal.aborted || error instanceof ToolFailure) {
        throw signal.aborted ? cancelledFailure() : error;
      }
      throw new ToolFailure(
        failure('DOCUMENT_NOT_FOUND', 'The document could not be found.', false),
      );
    }
    throwIfCancelled(signal);
    if (!stat.isFile || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new ToolFailure(
        failure('UNSUPPORTED_DOCUMENT', 'The target is not a regular file.', false),
      );
    }
    if (stat.size > TOOL_LIMITS.readDocument.closedFileBytes) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_TOO_LARGE',
          'The closed document exceeds the safe open limit.',
          false,
          {
            maximumBytes: TOOL_LIMITS.readDocument.closedFileBytes,
            actualBytes: stat.size,
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
      throwIfCancelled(signal);
    } catch (error) {
      if (signal.aborted || error instanceof ToolFailure) {
        throw signal.aborted ? cancelledFailure() : error;
      }
      throw new ToolFailure(
        failure('DOCUMENT_NOT_FOUND', 'The document could not be opened.', false),
      );
    }

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

  private async assertDocumentsUnchanged(
    documents: readonly VersionedHostDocument[],
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(signal);
    for (const document of documents) {
      if (document.hostDocument.version !== document.initialVersion) {
        throw new ToolFailure(
          failure(
            'DOCUMENT_CHANGED_DURING_REQUEST',
            'The document changed while the request was running.',
            true,
          ),
        );
      }
      const authorization = await this.authorize(identity, document.hostDocument.uri);
      if (!authorization.ok) {
        throw authorizationFailure(authorization.errorCode);
      }
      if (
        !canonicalPathsEqual(
          authorization.document.canonicalPath,
          document.authorization.canonicalPath,
          this.#pathStrategy,
        )
      ) {
        throw new ToolFailure(
          failure(
            'DOCUMENT_OUTSIDE_WORKSPACE',
            'The document target changed while the request was running.',
            true,
          ),
        );
      }
    }
    await this.requireSameWorkspaceAccess(identity, signal);
    for (const document of documents) {
      if (document.hostDocument.version !== document.initialVersion) {
        throw new ToolFailure(
          failure(
            'DOCUMENT_CHANGED_DURING_REQUEST',
            'The document changed while the request was running.',
            true,
          ),
        );
      }
    }
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
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.requireWorkspaceAccess(signal);
    if (current.identity.fingerprint !== identity.fingerprint) {
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

function normalizeHoverPayload(
  raw: unknown,
  document: EditorHostDocument,
  warnings: WarningAccumulator,
  signal: AbortSignal,
): HoverResultEntry[] {
  if (raw === undefined || raw === null) {
    warnings.addProviderNoResult();
    return [];
  }
  const values = readBoundedProviderItems(raw, PROVIDER_OUTPUT_LIMITS.hover.entriesMax);
  if (values === null) {
    warnings.addUnsupported(1);
    warnings.addProviderNoResult();
    return [];
  }
  warnings.addResults(values.omittedCount);
  if (values.items.length === 0) {
    return [];
  }
  const budget = new TextBudget(TOOL_LIMITS.hover.combinedTextBytes, warnings);
  let remainingRawContents = PROVIDER_OUTPUT_LIMITS.hover.contentsPerRequestMax;
  let remainingPublicContents = TOOL_LIMITS.hover.contentsPerRequestMax;
  const hovers: HoverResultEntry[] = [];

  for (let index = 0; index < values.items.length; index += 1) {
    throwIfCancelled(signal);
    if (budget.exhausted) {
      warnings.addResults(values.items.length - index);
      break;
    }
    const record = asRecord(values.items[index]);
    if (record === null) {
      warnings.addUnsupported(1);
      continue;
    }
    const range =
      record['range'] === undefined || record['range'] === null
        ? null
        : normalizeRange(record['range'], document);
    if (record['range'] !== undefined && record['range'] !== null && range === null) {
      warnings.addUnsupported(1);
      continue;
    }
    const rawContents = readBoundedProviderItems(
      record['contents'],
      Math.min(remainingRawContents, PROVIDER_OUTPUT_LIMITS.hover.contentsPerEntryMax),
    );
    if (rawContents === null) {
      warnings.addUnsupported(1);
      continue;
    }
    remainingRawContents -= rawContents.items.length;
    const boundedContents = limitBoundedProviderItems(
      rawContents,
      Math.min(remainingPublicContents, TOOL_LIMITS.hover.contentsPerEntryMax),
    );
    remainingPublicContents -= boundedContents.items.length;
    warnings.addResults(boundedContents.omittedCount);

    const contents: MarkupContent[] = [];
    for (
      let contentIndex = 0;
      contentIndex < boundedContents.items.length;
      contentIndex += 1
    ) {
      if (budget.exhausted) {
        warnings.addResults(boundedContents.items.length - contentIndex);
        break;
      }
      const content = normalizeMarkup(
        boundedContents.items[contentIndex],
        budget,
        warnings,
      );
      if (content !== null) {
        contents.push(content);
      }
    }
    if (contents.length === 0) {
      if (boundedContents.items.length === 0 && boundedContents.omittedCount === 0) {
        warnings.addUnsupported(1);
      }
      continue;
    }
    hovers.push({ range, contents });
  }
  return hovers;
}

function normalizeSignatureHelpPayload(
  raw: unknown,
  warnings: WarningAccumulator,
  signal: AbortSignal,
): Pick<GetSignatureHelpResult, 'activeSignature' | 'activeParameter' | 'signatures'> {
  if (raw === undefined || raw === null) {
    warnings.addProviderNoResult();
    return { activeSignature: null, activeParameter: null, signatures: [] };
  }
  const record = asRecord(raw);
  if (record === null) {
    warnings.addUnsupported(1);
    warnings.addProviderNoResult();
    return { activeSignature: null, activeParameter: null, signatures: [] };
  }
  const rawSignatures = readBoundedProviderItems(
    record['signatures'],
    PROVIDER_OUTPUT_LIMITS.signatureHelp.signaturesMax,
  );
  if (rawSignatures === null) {
    warnings.addUnsupported(1);
    warnings.addProviderNoResult();
    return { activeSignature: null, activeParameter: null, signatures: [] };
  }
  warnings.addResults(rawSignatures.omittedCount);
  if (rawSignatures.items.length === 0) {
    return { activeSignature: null, activeParameter: null, signatures: [] };
  }

  const budget = new TextBudget(TOOL_LIMITS.signatureHelp.combinedTextBytes, warnings);

  const signatures: SignatureResultEntry[] = [];
  const perSignatureActiveParameters: Array<number | null> = [];
  const returnedIndexByRawIndex = new Map<number, number>();
  for (let index = 0; index < rawSignatures.items.length; index += 1) {
    throwIfCancelled(signal);
    if (budget.exhausted) {
      warnings.addResults(rawSignatures.items.length - index);
      break;
    }
    const rawSignature = asRecord(rawSignatures.items[index]);
    if (rawSignature === null || typeof rawSignature['label'] !== 'string') {
      warnings.addUnsupported(1);
      continue;
    }

    const label = budget.take(rawSignature['label']);
    const documentation = normalizeNullableMarkup(
      rawSignature['documentation'],
      budget,
      warnings,
    );
    const rawParameters = readOptionalProviderItems(
      rawSignature['parameters'],
      PROVIDER_OUTPUT_LIMITS.signatureHelp.parametersPerSignatureMax,
    );
    if (rawParameters === null) {
      warnings.addUnsupported(1);
    }
    const boundedParameters = limitBoundedProviderItems(
      rawParameters ?? { items: [], omittedCount: 0 },
      TOOL_LIMITS.signatureHelp.parametersPerSignatureMax,
    );
    warnings.addResults(boundedParameters.omittedCount);
    const parameters: SignatureResultEntry['parameters'] = [];
    for (
      let parameterIndex = 0;
      parameterIndex < boundedParameters.items.length;
      parameterIndex += 1
    ) {
      if (budget.exhausted) {
        warnings.addResults(boundedParameters.items.length - parameterIndex);
        break;
      }
      const parameter = normalizeSignatureParameter(
        boundedParameters.items[parameterIndex],
        label,
        budget,
        warnings,
      );
      if (parameter !== null) {
        parameters.push(parameter);
      }
    }

    returnedIndexByRawIndex.set(index, signatures.length);
    signatures.push({ label, documentation, parameters });
    perSignatureActiveParameters.push(
      normalizeOptionalIndex(rawSignature['activeParameter'], warnings),
    );
  }

  const rawActiveSignature = normalizeOptionalIndex(
    record['activeSignature'],
    warnings,
  );
  const activeSignature =
    rawActiveSignature === null
      ? null
      : (returnedIndexByRawIndex.get(rawActiveSignature) ?? null);

  let activeParameter: number | null = null;
  if (activeSignature !== null) {
    activeParameter =
      perSignatureActiveParameters[activeSignature] ??
      normalizeOptionalIndex(record['activeParameter'], warnings);
    const active = signatures[activeSignature];
    if (
      activeParameter !== null &&
      (active === undefined || activeParameter >= active.parameters.length)
    ) {
      warnings.addUnsupported(1);
      activeParameter = null;
    }
  }

  return { activeSignature, activeParameter, signatures };
}

function normalizeSignatureParameter(
  raw: unknown,
  signatureLabel: string,
  budget: TextBudget,
  warnings: WarningAccumulator,
): SignatureResultEntry['parameters'][number] | null {
  const record = asRecord(raw);
  if (record === null) {
    warnings.addUnsupported(1);
    return null;
  }

  let label: string | null = null;
  let labelRange: [number, number] | null = null;
  if (typeof record['label'] === 'string') {
    label = budget.take(
      truncateUtf16Value(record['label'], SCHEMA_LIMITS.detailTextCharacters, warnings),
    );
  } else if (Array.isArray(record['label'])) {
    const values = record['label'];
    const start = values[0];
    const end = values[1];
    if (
      values.length === 2 &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      typeof start === 'number' &&
      typeof end === 'number' &&
      start >= 0 &&
      start <= end &&
      end <= signatureLabel.length
    ) {
      labelRange = [start, end];
    } else {
      warnings.addUnsupported(1);
    }
  } else {
    warnings.addUnsupported(1);
  }

  return {
    label,
    labelRange,
    documentation: normalizeNullableMarkup(record['documentation'], budget, warnings),
  };
}

function normalizeMarkup(
  raw: unknown,
  budget: TextBudget,
  warnings: WarningAccumulator,
): MarkupContent | null {
  const record = asRecord(raw);
  if (
    record === null ||
    (record['kind'] !== 'markdown' && record['kind'] !== 'plaintext') ||
    typeof record['value'] !== 'string'
  ) {
    warnings.addUnsupported(1);
    return null;
  }
  return { kind: record['kind'], value: budget.take(record['value']) };
}

function normalizeNullableMarkup(
  raw: unknown,
  budget: TextBudget,
  warnings: WarningAccumulator,
): MarkupContent | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  return normalizeMarkup(raw, budget, warnings);
}

function normalizeDiagnosticTags(
  raw: BoundedProviderItems<unknown> | null,
  warnings: WarningAccumulator,
): DiagnosticResult['tags'] {
  if (raw === null) {
    warnings.addUnsupported(1);
    return [];
  }
  const bounded = limitBoundedProviderItems(
    raw,
    TOOL_LIMITS.diagnostics.tagsPerItemMax,
  );
  warnings.addResults(bounded.omittedCount);
  const tags: DiagnosticResult['tags'] = [];
  for (let index = 0; index < bounded.items.length; index += 1) {
    const tag = bounded.items[index];
    if ((tag === 'unnecessary' || tag === 'deprecated') && !tags.includes(tag)) {
      tags.push(tag);
    } else {
      warnings.addUnsupported(1);
    }
  }
  tags.sort(compareText);
  return tags;
}

function normalizeSeverity(raw: unknown): DiagnosticSeverity | null {
  return raw === 'error' || raw === 'warning' || raw === 'information' || raw === 'hint'
    ? raw
    : null;
}

function normalizeOptionalBoundedString(
  raw: unknown,
  maximumCharacters: number,
  warnings: WarningAccumulator,
): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    warnings.addUnsupported(1);
    return null;
  }
  return truncateUtf16(raw, maximumCharacters, warnings);
}

function normalizeOptionalIndex(
  raw: unknown,
  warnings: WarningAccumulator,
): number | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    warnings.addUnsupported(1);
    return null;
  }
  return raw;
}

function normalizeRange(raw: unknown, document: EditorHostDocument): Range | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const start = normalizePosition(record['start'], document);
  const end = normalizePosition(record['end'], document);
  if (start === null || end === null || comparePositions(start, end) > 0) {
    return null;
  }
  return { start, end };
}

function normalizePosition(
  raw: unknown,
  document: EditorHostDocument,
): Position | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const line = record['line'];
  const character = record['character'];
  if (
    typeof line !== 'number' ||
    typeof character !== 'number' ||
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(character) ||
    line < 0 ||
    character < 0 ||
    line >= document.lineCount
  ) {
    return null;
  }
  try {
    const text = document.lineText(line);
    return typeof text === 'string' && character <= text.length
      ? { line, character }
      : null;
  } catch {
    return null;
  }
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

function compareDiagnostics(left: DiagnosticResult, right: DiagnosticResult): number {
  return (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    comparePositions(left.range.start, right.range.start) ||
    comparePositions(left.range.end, right.range.end) ||
    compareText(left.message, right.message)
  );
}

function comparePositions(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDocumentVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
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

function recognizeLanguageTool(value: unknown): LanguageToolName | null {
  const record = asRecord(value);
  if (record === null || typeof record['tool'] !== 'string') {
    return null;
  }
  for (const tool of LANGUAGE_EXTENSION_TOOL_NAMES) {
    if (record['tool'] === tool) {
      return tool;
    }
  }
  return null;
}

function createDiagnosticsProviderBudget(
  includeRelatedInformation: boolean,
): DiagnosticsProviderBudget {
  return {
    remainingItems: PROVIDER_OUTPUT_LIMITS.diagnostics.itemsPerRequestMax,
    remainingRelatedInformation: includeRelatedInformation
      ? PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerRequestMax
      : 0,
  };
}

function readOptionalProviderItems(
  value: unknown,
  maximumItems: number,
): BoundedProviderItems<unknown> | null {
  if (value === undefined || value === null) {
    return { items: [], omittedCount: 0 };
  }
  return readBoundedProviderItems(value, maximumItems);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledFailure();
  }
}

function cancelledFailure(): ToolFailure {
  return new ToolFailure(failure('CANCELLED', 'The tool request was cancelled.', true));
}

function versionMismatch(expected: number, actual: number): ToolFailure {
  return new ToolFailure(
    failure(
      'DOCUMENT_VERSION_MISMATCH',
      'The document version does not match the requested version.',
      true,
      { expectedDocumentVersion: expected, actualDocumentVersion: actual },
    ),
  );
}

function documentChangedFailure(): ToolFailure {
  return new ToolFailure(
    failure(
      'DOCUMENT_CHANGED_DURING_REQUEST',
      'The document changed while the request was running.',
      true,
    ),
  );
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

function normalizeFailure(error: unknown, signal: AbortSignal): ToolFailureData {
  if (signal.aborted) {
    return failure('CANCELLED', 'The tool request was cancelled.', true);
  }
  return error instanceof ToolFailure ? error.data : internalFailure();
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
  return failure(
    'INTERNAL_ERROR',
    'The language tool request failed internally.',
    false,
  );
}

function toolError(tool: LanguageToolName, error: ToolFailureData): IpcCallToolResult {
  return IpcCallToolResultSchema.parse({ outcome: 'toolError', tool, error });
}

function toolSuccess(
  tool: LanguageToolName,
  result: GetDiagnosticsResult | GetHoverResult | GetSignatureHelpResult,
  warnings: WarningAccumulator,
  now: () => Date,
): IpcCallToolResult {
  const payload =
    tool === 'get_diagnostics'
      ? { tool, result: GetDiagnosticsResultSchema.parse(result) }
      : tool === 'get_hover'
        ? { tool, result: GetHoverResultSchema.parse(result) }
        : { tool, result: GetSignatureHelpResultSchema.parse(result) };
  return IpcCallToolResultSchema.parse({
    outcome: 'success',
    observedAt: now().toISOString(),
    truncated: warnings.isTruncated,
    warnings: warnings.toArray(),
    payload,
  });
}

function boundedWaitedMs(startedAt: number): number {
  return Math.min(
    TOOL_LIMITS.diagnostics.maximumWaitMs,
    Math.max(0, Math.round(Date.now() - startedAt)),
  );
}

function unknownFreshness(): DiagnosticsFreshness {
  return {
    state: 'unknown',
    heuristic: true,
    quietPeriodMs: TOOL_LIMITS.diagnostics.quietPeriodMs,
    waitedMs: 0,
    lastChangeAt: null,
  };
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
  warnings: WarningAccumulator,
): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
    return value;
  }
  warnings.addContent();
  return utf8Prefix(value, maximumBytes);
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

function truncateUtf16(
  value: string,
  maximumCodeUnits: number,
  warnings: WarningAccumulator,
): string {
  return truncateUtf16Value(value, maximumCodeUnits, warnings);
}

function truncateUtf16Value(
  value: string,
  maximumCodeUnits: number,
  warnings: WarningAccumulator,
): string {
  if (value.length <= maximumCodeUnits) {
    return value;
  }
  warnings.addContent();
  let prefix = value.slice(0, maximumCodeUnits);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

class TextBudget {
  #remaining: number;

  public constructor(
    maximumBytes: number,
    private readonly warnings: WarningAccumulator,
  ) {
    this.#remaining = maximumBytes;
  }

  public get exhausted(): boolean {
    return this.#remaining === 0;
  }

  public take(value: string): string {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= this.#remaining) {
      this.#remaining -= bytes;
      return value;
    }
    const prefix = utf8Prefix(value, this.#remaining);
    this.#remaining = 0;
    this.warnings.addContent();
    return prefix;
  }
}

class WarningAccumulator {
  #results = 0;
  #content = false;
  #external = 0;
  #unsupported = 0;
  #providerNoResult = false;

  public get isTruncated(): boolean {
    return (
      this.#results > 0 || this.#content || this.#external > 0 || this.#unsupported > 0
    );
  }

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

  public addProviderNoResult(): void {
    this.#providerNoResult = true;
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
        message: 'Some provider results were omitted to enforce result limits.',
        omittedCount: this.#results,
      });
    }
    if (this.#content) {
      warnings.push({
        code: 'CONTENT_TRUNCATED',
        message: 'Provider text was truncated at a contract byte or character limit.',
      });
    }
    if (this.#external > 0) {
      warnings.push({
        code: 'EXTERNAL_LOCATIONS_OMITTED',
        message: 'Provider locations outside the enabled workspace were omitted.',
        omittedCount: this.#external,
      });
    }
    if (this.#unsupported > 0) {
      warnings.push({
        code: 'UNSUPPORTED_ITEMS_OMITTED',
        message: 'Malformed or unsupported provider items were omitted.',
        omittedCount: this.#unsupported,
      });
    }
    if (this.#providerNoResult) {
      warnings.push({
        code: 'PROVIDER_RETURNED_NO_RESULT',
        message: 'The language provider returned no result.',
      });
    }
    return warnings;
  }
}
