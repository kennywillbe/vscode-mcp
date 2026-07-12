import { Buffer } from 'node:buffer';

import {
  PROVIDER_OUTPUT_LIMITS,
  PROTOCOL_LIMITS,
  SCHEMA_LIMITS,
  TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import {
  IpcCallToolResultSchema,
  type IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas';
import {
  DocumentSnapshotSchema,
  type DocumentRef,
  type DocumentSnapshot,
  type ErrorCode,
  type Position,
  type Range,
  type SafeErrorDetails,
} from '@vscode-mcp/protocol/schemas';
import {
  ExtensionToolInvocationSchema,
  FindReferencesResultSchema,
  GetCallHierarchyResultSchema,
  GetDefinitionResultSchema,
  GetDocumentSymbolsResultSchema,
  SearchWorkspaceSymbolsResultSchema,
  type ExtensionToolName,
  type FindReferencesArguments,
  type FindReferencesResult,
  type GetCallHierarchyArguments,
  type GetCallHierarchyResult,
  type GetDefinitionArguments,
  type GetDefinitionResult,
  type GetDocumentSymbolsArguments,
  type GetDocumentSymbolsResult,
  type SearchWorkspaceSymbolsArguments,
  type SearchWorkspaceSymbolsResult,
  type Warning,
} from '@vscode-mcp/protocol/tool-schemas';

import {
  authorizeWorkspaceDocument,
  type AuthorizedWorkspaceDocument,
  type WorkspaceAuthorizationErrorCode,
  type WorkspaceAuthorizationPathStrategy,
} from './workspace-authorizer.js';
import {
  LanguageProviderUnavailableError,
  type LanguageHostCallItem,
  type LanguageHostDefinitionTarget,
  type LanguageHostDocument,
  type LanguageHostFlatSymbol,
  type LanguageHostHierarchicalSymbol,
  type LanguageHostIncomingCall,
  type LanguageHostOutgoingCall,
  type LanguageHostRange,
  type LanguageHostReference,
  type LanguageHostWorkspaceSymbol,
  type LanguageLocationToolHost,
  type LanguageLocationWorkspaceAccess,
} from './language-location-tool-host.js';
import {
  limitBoundedProviderItems,
  saturatingAddProviderCounts,
  snapshotBoundedProviderItems,
  type BoundedProviderItems,
} from './provider-output-bounds.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

export const LANGUAGE_LOCATION_EXTENSION_TOOL_NAMES = [
  'get_definition',
  'find_references',
  'get_document_symbols',
  'search_workspace_symbols',
  'get_call_hierarchy',
] as const satisfies readonly ExtensionToolName[];

export interface LanguageLocationToolProviderSeam {
  readonly names: typeof LANGUAGE_LOCATION_EXTENSION_TOOL_NAMES;
  readonly callTool: (
    untrustedInvocation: unknown,
    signal: AbortSignal,
  ) => Promise<IpcCallToolResult>;
}

export interface LanguageLocationToolServiceOptions {
  readonly host: LanguageLocationToolHost;
  /** Must include local-desktop, trust, and explicit current enablement checks. */
  readonly getWorkspaceAccess: () =>
    LanguageLocationWorkspaceAccess | PromiseLike<LanguageLocationWorkspaceAccess>;
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

interface OpenedDocument {
  readonly hostDocument: LanguageHostDocument;
  readonly authorization: AuthorizedWorkspaceDocument;
}

interface RequestedDocument extends OpenedDocument {
  readonly initialVersion: number;
}

interface ProviderDocument extends OpenedDocument {
  readonly canonicalUri: string;
}

interface InternalCallItem {
  readonly result: GetCallHierarchyResult['roots'][number];
  readonly providerItem: LanguageHostCallItem;
  readonly document: ProviderDocument;
  readonly documentVersion: number;
}

interface InternalDefinitionLocation {
  readonly result: GetDefinitionResult['locations'][number];
  readonly canonicalPath: string;
}

interface IncomingCallMerge {
  readonly from: NonNullable<GetCallHierarchyResult['incoming']>[number]['from'];
  readonly ranges: Map<string, Range>;
}

interface OutgoingCallMerge {
  readonly to: NonNullable<GetCallHierarchyResult['outgoing']>[number]['to'];
  readonly ranges: Map<string, Range>;
}

const OUTPUT_COLLECTION_BUDGET_BYTES = 384 * 1024;

/**
 * Implements the location/symbol/call-hierarchy tools without importing VS Code.
 * Every async provider boundary is followed by cancellation, document-version, and
 * workspace-eligibility checks before provider data can cross IPC.
 */
export class LanguageLocationToolService implements LanguageLocationToolProviderSeam {
  public readonly names = LANGUAGE_LOCATION_EXTENSION_TOOL_NAMES;

  readonly #host: LanguageLocationToolHost;
  readonly #getWorkspaceAccess: LanguageLocationToolServiceOptions['getWorkspaceAccess'];
  readonly #realpath: LanguageLocationToolServiceOptions['realpath'];
  readonly #pathStrategy: WorkspaceAuthorizationPathStrategy;
  readonly #now: () => Date;

  public constructor(options: LanguageLocationToolServiceOptions) {
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
    const recognizedTool = recognizeTool(untrustedInvocation);
    if (recognizedTool === null) {
      throw new Error('The language-location tool invocation is not recognized.');
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
        case 'get_definition':
          return await this.getDefinition(parsed.data.arguments, signal);
        case 'find_references':
          return await this.findReferences(parsed.data.arguments, signal);
        case 'get_document_symbols':
          return await this.getDocumentSymbols(parsed.data.arguments, signal);
        case 'search_workspace_symbols':
          return await this.searchWorkspaceSymbols(parsed.data.arguments, signal);
        case 'get_call_hierarchy':
          return await this.getCallHierarchy(parsed.data.arguments, signal);
        default:
          throw new Error('The invocation was routed to the wrong tool provider.');
      }
    } catch (error) {
      return toolError(recognizedTool, normalizeFailure(error, signal));
    }
  };

  private async getDefinition(
    arguments_: GetDefinitionArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const requested = await this.resolveRequestedDocument(
      access.identity,
      arguments_.document,
      arguments_.expectedDocumentVersion,
      arguments_.position,
      signal,
    );
    const kind = arguments_.kind ?? 'definition';
    const warnings = new WarningAccumulator();
    const batch = await this.runProvider(
      () =>
        this.#host.provideDefinition(
          kind,
          requested.authorization.uri,
          arguments_.position,
        ),
      signal,
    );
    await this.recheckRequest(access.identity, requested, signal);
    if (batch.state === 'noResult') {
      warnings.addNoResult();
    }

    const documentCache = new Map<string, ProviderDocument>();
    const locations: InternalDefinitionLocation[] = [];
    if (batch.state === 'result') {
      for (const target of boundedProviderItems(
        batch,
        PROVIDER_OUTPUT_LIMITS.definition.itemsMax,
        warnings,
      )) {
        throwIfCancelled(signal);
        const normalized = await this.normalizeDefinitionTarget(
          target,
          requested,
          access.identity,
          documentCache,
          warnings,
          signal,
        );
        if (normalized !== null) {
          locations.push(normalized);
        }
      }
    }

    const ordered = dedupeAndSortDefinitions(locations);
    const limit = arguments_.limit ?? TOOL_LIMITS.definition.itemsDefault;
    const bounded = takeBudgetedPrefix(ordered, limit, warnings).map(
      (location) => location.result,
    );
    await this.recheckRequest(access.identity, requested, signal);
    const result = GetDefinitionResultSchema.parse({
      document: createDocumentSnapshot(requested.hostDocument, requested.authorization),
      kind,
      locations: bounded,
    });
    return success('get_definition', result, warnings, this.#now);
  }

  private async findReferences(
    arguments_: FindReferencesArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const requested = await this.resolveRequestedDocument(
      access.identity,
      arguments_.document,
      arguments_.expectedDocumentVersion,
      arguments_.position,
      signal,
    );
    const warnings = new WarningAccumulator();
    const batch = await this.runProvider(
      () =>
        this.#host.provideReferences(requested.authorization.uri, arguments_.position),
      signal,
    );
    await this.recheckRequest(access.identity, requested, signal);
    if (batch.state === 'noResult') {
      warnings.addNoResult();
    }

    const documentCache = new Map<string, ProviderDocument>();
    const references: Array<{
      readonly result: FindReferencesResult['references'][number];
      readonly canonicalPath: string;
    }> = [];
    if (batch.state === 'result') {
      for (const reference of boundedProviderItems(
        batch,
        PROVIDER_OUTPUT_LIMITS.references.itemsMax,
        warnings,
      )) {
        throwIfCancelled(signal);
        const normalized = await this.normalizeReference(
          reference,
          access.identity,
          documentCache,
          warnings,
          signal,
        );
        if (normalized !== null) {
          references.push(normalized);
        }
      }
    }

    let declarationKeys = new Set<string>();
    if (!(arguments_.includeDeclaration ?? false) && references.length > 0) {
      declarationKeys = await this.collectDeclarationKeys(
        requested,
        access.identity,
        arguments_.position,
        documentCache,
        signal,
      );
      await this.recheckRequest(access.identity, requested, signal);
    }

    const unique = dedupeAndSortReferences(
      references.filter(
        (reference) => !declarationKeys.has(referenceKey(reference.result)),
      ),
    );
    const limit = arguments_.limit ?? TOOL_LIMITS.references.itemsDefault;
    if (unique.length > limit) {
      warnings.addResults(unique.length - limit);
    }
    const limited = unique.slice(0, limit);
    const contextLines =
      arguments_.contextLines ?? TOOL_LIMITS.references.contextLinesDefault;
    const withContext: FindReferencesResult['references'] = [];
    for (const reference of limited) {
      throwIfCancelled(signal);
      const providerDocument = documentCache.get(reference.canonicalPath);
      if (providerDocument === undefined) {
        warnings.addUnsupported(1);
        continue;
      }
      const context = createReferenceContext(
        providerDocument.hostDocument,
        reference.result.range,
        contextLines,
        warnings,
        signal,
      );
      withContext.push({ ...reference.result, context });
    }
    const budgeted = budgetReferences(withContext, warnings);

    await this.recheckRequest(access.identity, requested, signal);
    const result = FindReferencesResultSchema.parse({
      document: createDocumentSnapshot(requested.hostDocument, requested.authorization),
      references: budgeted,
    });
    return success('find_references', result, warnings, this.#now);
  }

  private async getDocumentSymbols(
    arguments_: GetDocumentSymbolsArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const requested = await this.resolveRequestedDocument(
      access.identity,
      arguments_.document,
      arguments_.expectedDocumentVersion,
      undefined,
      signal,
    );
    const warnings = new WarningAccumulator();
    const providerResult = await this.runProvider(
      () => this.#host.provideDocumentSymbols(requested.authorization.uri),
      signal,
    );
    await this.recheckRequest(access.identity, requested, signal);

    const providerShape =
      providerResult.state === 'result' ? providerResult.shape : 'hierarchical';
    if (providerResult.state === 'noResult') {
      warnings.addNoResult();
    }
    const symbols: GetDocumentSymbolsResult['symbols'] = [];
    if (providerResult.state === 'result') {
      if (providerResult.shape === 'hierarchical') {
        warnings.addResults(providerResult.omittedCount);
        this.flattenHierarchicalSymbols(
          providerResult.items,
          requested,
          symbols,
          warnings,
          signal,
        );
      } else {
        await this.flattenFlatSymbols(
          boundedProviderItems(
            providerResult,
            PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax,
            warnings,
          ),
          requested,
          access.identity,
          symbols,
          warnings,
          signal,
        );
      }
    }

    const limit = arguments_.limit ?? TOOL_LIMITS.documentSymbols.itemsDefault;
    const bounded = takeBudgetedPrefix(symbols, limit, warnings);
    await this.recheckRequest(access.identity, requested, signal);
    const result = GetDocumentSymbolsResultSchema.parse({
      document: createDocumentSnapshot(requested.hostDocument, requested.authorization),
      providerShape,
      symbols: bounded,
    });
    return success('get_document_symbols', result, warnings, this.#now);
  }

  private async searchWorkspaceSymbols(
    arguments_: SearchWorkspaceSymbolsArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const warnings = new WarningAccumulator();
    const batch = await this.runProvider(
      () => this.#host.provideWorkspaceSymbols(arguments_.query),
      signal,
    );
    await this.requireSameWorkspaceAccess(access.identity, signal);
    if (batch.state === 'noResult') {
      warnings.addNoResult();
    }

    const documentCache = new Map<string, ProviderDocument>();
    const symbols: SearchWorkspaceSymbolsResult['symbols'] = [];
    const seen = new Set<string>();
    if (batch.state === 'result') {
      for (const item of boundedProviderItems(
        batch,
        PROVIDER_OUTPUT_LIMITS.workspaceSymbols.itemsMax,
        warnings,
      )) {
        throwIfCancelled(signal);
        const normalized = await this.normalizeWorkspaceSymbol(
          item,
          access.identity,
          documentCache,
          warnings,
          signal,
        );
        if (normalized === null) {
          continue;
        }
        const key = workspaceSymbolKey(normalized);
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push(normalized);
        }
      }
    }

    const limit = arguments_.limit ?? TOOL_LIMITS.workspaceSymbols.itemsDefault;
    const bounded = takeBudgetedPrefix(symbols, limit, warnings);
    await this.requireSameWorkspaceAccess(access.identity, signal);
    const result = SearchWorkspaceSymbolsResultSchema.parse({
      query: arguments_.query,
      symbols: bounded,
    });
    return success('search_workspace_symbols', result, warnings, this.#now);
  }

  private async getCallHierarchy(
    arguments_: GetCallHierarchyArguments,
    signal: AbortSignal,
  ): Promise<IpcCallToolResult> {
    const access = await this.requireWorkspaceAccess(signal);
    const requested = await this.resolveRequestedDocument(
      access.identity,
      arguments_.document,
      arguments_.expectedDocumentVersion,
      arguments_.position,
      signal,
    );
    const warnings = new WarningAccumulator();
    const prepared = await this.runProvider(
      () =>
        this.#host.prepareCallHierarchy(
          requested.authorization.uri,
          arguments_.position,
        ),
      signal,
    );
    await this.recheckRequest(access.identity, requested, signal);
    if (prepared.state === 'noResult') {
      warnings.addNoResult();
    }

    const documentCache = new Map<string, ProviderDocument>();
    const roots: InternalCallItem[] = [];
    const rootKeys = new Set<string>();
    if (prepared.state === 'result') {
      for (const item of boundedProviderItems(
        prepared,
        PROVIDER_OUTPUT_LIMITS.callHierarchy.rootsMax,
        warnings,
      )) {
        throwIfCancelled(signal);
        const root = await this.normalizeCallItem(
          item,
          access.identity,
          documentCache,
          warnings,
          signal,
        );
        if (root === null) {
          continue;
        }
        const key = callItemKey(root.result);
        if (!rootKeys.has(key)) {
          rootKeys.add(key);
          roots.push(root);
        }
      }
    }
    if (roots.length > TOOL_LIMITS.callHierarchy.rootsMax) {
      warnings.addResults(roots.length - TOOL_LIMITS.callHierarchy.rootsMax);
      roots.length = TOOL_LIMITS.callHierarchy.rootsMax;
    }

    const selectedRootIndex = arguments_.rootIndex ?? 0;
    if (roots.length > 0 && selectedRootIndex >= roots.length) {
      throw new ToolFailure(
        failure(
          'INVALID_ARGUMENT',
          'The call-hierarchy root index is invalid.',
          false,
          {
            availableRootCount: roots.length,
          },
        ),
      );
    }
    if (roots.length === 0 && selectedRootIndex !== 0) {
      throw new ToolFailure(
        failure(
          'INVALID_ARGUMENT',
          'The call-hierarchy root index is invalid.',
          false,
          {
            availableRootCount: 0,
          },
        ),
      );
    }

    const direction = arguments_.direction ?? 'both';
    const perDirectionLimit =
      arguments_.limitPerDirection ??
      TOOL_LIMITS.callHierarchy.itemsPerDirectionDefault;
    let incoming: NonNullable<GetCallHierarchyResult['incoming']> | null =
      direction === 'outgoing' ? null : [];
    let outgoing: NonNullable<GetCallHierarchyResult['outgoing']> | null =
      direction === 'incoming' ? null : [];
    const selectedRoot = roots[selectedRootIndex];

    if (selectedRoot !== undefined && incoming !== null) {
      const batch = await this.runProvider(
        () => this.#host.provideIncomingCalls(selectedRoot.providerItem),
        signal,
      );
      await this.recheckRequest(access.identity, requested, signal);
      recheckProviderDocumentVersion(selectedRoot);
      if (batch.state === 'noResult') {
        warnings.addNoResult();
      } else {
        incoming = await this.normalizeIncomingCalls(
          boundedProviderItems(
            batch,
            PROVIDER_OUTPUT_LIMITS.callHierarchy.callsPerDirectionMax,
            warnings,
          ),
          access.identity,
          documentCache,
          perDirectionLimit,
          warnings,
          signal,
        );
      }
      recheckProviderDocumentVersion(selectedRoot);
    }
    if (selectedRoot !== undefined && outgoing !== null) {
      const batch = await this.runProvider(
        () => this.#host.provideOutgoingCalls(selectedRoot.providerItem),
        signal,
      );
      await this.recheckRequest(access.identity, requested, signal);
      recheckProviderDocumentVersion(selectedRoot);
      if (batch.state === 'noResult') {
        warnings.addNoResult();
      } else {
        outgoing = await this.normalizeOutgoingCalls(
          boundedProviderItems(
            batch,
            PROVIDER_OUTPUT_LIMITS.callHierarchy.callsPerDirectionMax,
            warnings,
          ),
          selectedRoot.document,
          access.identity,
          documentCache,
          perDirectionLimit,
          warnings,
          signal,
        );
      }
      recheckProviderDocumentVersion(selectedRoot);
    }

    const budgeted = budgetCallHierarchy(
      roots.map((root) => root.result),
      selectedRootIndex,
      incoming,
      outgoing,
      warnings,
    );
    await this.recheckRequest(access.identity, requested, signal);
    if (selectedRoot !== undefined) {
      recheckProviderDocumentVersion(selectedRoot);
    }
    const result = GetCallHierarchyResultSchema.parse({
      document: createDocumentSnapshot(requested.hostDocument, requested.authorization),
      ...budgeted,
    });
    return success('get_call_hierarchy', result, warnings, this.#now);
  }

  private async resolveRequestedDocument(
    identity: WorkspaceIdentity,
    reference: DocumentRef,
    expectedVersion: number | undefined,
    position: Position | undefined,
    signal: AbortSignal,
  ): Promise<RequestedDocument> {
    const authorization = await this.authorize(identity, reference);
    if (!authorization.ok) {
      throw authorizationFailure(authorization.errorCode);
    }
    const opened = await this.openAuthorizedDocument(
      authorization.document,
      identity,
      signal,
    );
    const version = validDocumentVersion(opened.hostDocument.version);
    if (expectedVersion !== undefined && expectedVersion !== version) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_VERSION_MISMATCH',
          'The document version does not match the requested version.',
          true,
          { expectedDocumentVersion: expectedVersion, actualDocumentVersion: version },
        ),
      );
    }
    if (
      position !== undefined &&
      normalizePosition(opened.hostDocument, position) === null
    ) {
      throw new ToolFailure(
        failure(
          'POSITION_OUT_OF_RANGE',
          'The requested position is outside the document.',
          false,
        ),
      );
    }
    const canonicalAuthorization = {
      ...authorization.document,
      uri: canonicalUri(authorization.document.canonicalPath, this.#pathStrategy),
    };
    return {
      hostDocument: opened.hostDocument,
      authorization: canonicalAuthorization,
      initialVersion: version,
    };
  }

  private async openAuthorizedDocument(
    target: AuthorizedWorkspaceDocument,
    identity: WorkspaceIdentity,
    signal: AbortSignal,
  ): Promise<OpenedDocument> {
    const openDocuments = this.#host.openDocuments()[Symbol.iterator]();
    for (
      let inspectedOpenDocuments = 0;
      inspectedOpenDocuments < PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax;
      inspectedOpenDocuments += 1
    ) {
      throwIfCancelled(signal);
      const step = openDocuments.next();
      if (step.done) {
        break;
      }
      const candidate = step.value;
      const candidateAuthorization = await this.authorize(identity, candidate.uri);
      if (
        candidateAuthorization.ok &&
        canonicalPathsEqual(
          candidateAuthorization.document.canonicalPath,
          target.canonicalPath,
          this.#pathStrategy,
        )
      ) {
        validDocument(candidate);
        return { hostDocument: candidate, authorization: target };
      }
    }

    let stat: Awaited<ReturnType<LanguageLocationToolHost['statFile']>>;
    throwIfCancelled(signal);
    try {
      stat = await this.#host.statFile(target.canonicalPath);
      throwIfCancelled(signal);
    } catch (error) {
      if (signal.aborted || error instanceof ToolFailure) {
        throw error;
      }
      throw new ToolFailure(
        failure('DOCUMENT_NOT_FOUND', 'The document could not be found.', false),
      );
    }
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

    let opened: LanguageHostDocument;
    throwIfCancelled(signal);
    try {
      opened = await this.#host.openTextDocument(
        canonicalUri(target.canonicalPath, this.#pathStrategy),
      );
      throwIfCancelled(signal);
    } catch (error) {
      if (signal.aborted || error instanceof ToolFailure) {
        throw error;
      }
      throw new ToolFailure(
        failure('DOCUMENT_NOT_FOUND', 'The document could not be opened.', false),
      );
    }
    throwIfCancelled(signal);
    const openedAuthorization = await this.authorize(identity, opened.uri);
    if (!openedAuthorization.ok) {
      throw authorizationFailure(openedAuthorization.errorCode);
    }
    if (
      !canonicalPathsEqual(
        openedAuthorization.document.canonicalPath,
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
    validDocument(opened);
    return { hostDocument: opened, authorization: target };
  }

  private async resolveProviderDocument(
    identity: WorkspaceIdentity,
    uri: string,
    cache: Map<string, ProviderDocument>,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<ProviderDocument | null> {
    if (
      typeof uri !== 'string' ||
      Buffer.byteLength(uri, 'utf8') > SCHEMA_LIMITS.uriCharacters
    ) {
      warnings.addUnsupported(1);
      return null;
    }
    const authorization = await this.authorize(identity, uri);
    if (!authorization.ok) {
      warnings.addAuthorization(authorization.errorCode);
      return null;
    }
    const existing = cache.get(authorization.document.canonicalPath);
    if (existing !== undefined) {
      return existing;
    }
    let opened: OpenedDocument;
    try {
      opened = await this.openAuthorizedDocument(
        authorization.document,
        identity,
        signal,
      );
    } catch (error) {
      throwIfCancelled(signal);
      if (
        error instanceof ToolFailure &&
        error.data.code === 'DOCUMENT_OUTSIDE_WORKSPACE'
      ) {
        warnings.addAuthorization('DOCUMENT_OUTSIDE_WORKSPACE');
        return null;
      }
      warnings.addUnsupported(1);
      return null;
    }
    const providerDocument: ProviderDocument = {
      ...opened,
      canonicalUri: canonicalUri(
        authorization.document.canonicalPath,
        this.#pathStrategy,
      ),
    };
    cache.set(authorization.document.canonicalPath, providerDocument);
    return providerDocument;
  }

  private async normalizeDefinitionTarget(
    target: LanguageHostDefinitionTarget | null,
    requested: RequestedDocument,
    identity: WorkspaceIdentity,
    cache: Map<string, ProviderDocument>,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<InternalDefinitionLocation | null> {
    if (
      target === null ||
      (target.shape !== 'location' && target.shape !== 'locationLink')
    ) {
      warnings.addUnsupported(1);
      return null;
    }
    const uri = target.shape === 'location' ? target.uri : target.targetUri;
    const providerDocument = await this.resolveProviderDocument(
      identity,
      uri,
      cache,
      warnings,
      signal,
    );
    if (providerDocument === null) {
      return null;
    }
    const targetRange = normalizeRange(
      providerDocument.hostDocument,
      target.shape === 'location' ? target.range : target.targetRange,
    );
    const targetSelectionRange = normalizeRange(
      providerDocument.hostDocument,
      target.shape === 'location' ? target.range : target.targetSelectionRange,
    );
    const originSelectionRange =
      target.shape === 'locationLink' && target.originSelectionRange !== null
        ? normalizeRange(requested.hostDocument, target.originSelectionRange)
        : null;
    if (
      targetRange === null ||
      targetSelectionRange === null ||
      !rangeContains(targetRange, targetSelectionRange) ||
      (target.shape === 'locationLink' &&
        target.originSelectionRange !== null &&
        originSelectionRange === null)
    ) {
      warnings.addUnsupported(1);
      return null;
    }
    return {
      canonicalPath: providerDocument.authorization.canonicalPath,
      result: {
        uri: providerDocument.canonicalUri,
        targetRange,
        targetSelectionRange,
        originSelectionRange,
      },
    };
  }

  private async normalizeReference(
    reference: LanguageHostReference | null,
    identity: WorkspaceIdentity,
    cache: Map<string, ProviderDocument>,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<{
    readonly result: FindReferencesResult['references'][number];
    readonly canonicalPath: string;
  } | null> {
    if (reference === null) {
      warnings.addUnsupported(1);
      return null;
    }
    const providerDocument = await this.resolveProviderDocument(
      identity,
      reference.uri,
      cache,
      warnings,
      signal,
    );
    if (providerDocument === null) {
      return null;
    }
    const range = normalizeRange(providerDocument.hostDocument, reference.range);
    if (range === null) {
      warnings.addUnsupported(1);
      return null;
    }
    return {
      canonicalPath: providerDocument.authorization.canonicalPath,
      result: { uri: providerDocument.canonicalUri, range, context: null },
    };
  }

  private async collectDeclarationKeys(
    requested: RequestedDocument,
    identity: WorkspaceIdentity,
    position: Position,
    cache: Map<string, ProviderDocument>,
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const kind of ['declaration', 'definition'] as const) {
      const batch = await this.runProvider(
        () => this.#host.provideDefinition(kind, requested.authorization.uri, position),
        signal,
      );
      if (batch.state === 'noResult') {
        continue;
      }
      const auxiliaryWarnings = new WarningAccumulator();
      for (const target of boundedProviderItems(
        batch,
        PROVIDER_OUTPUT_LIMITS.definition.itemsMax,
        auxiliaryWarnings,
      )) {
        const normalized = await this.normalizeDefinitionTarget(
          target,
          requested,
          identity,
          cache,
          auxiliaryWarnings,
          signal,
        );
        if (normalized !== null) {
          keys.add(
            referenceKey({
              uri: normalized.result.uri,
              range: normalized.result.targetRange,
              context: null,
            }),
          );
          keys.add(
            referenceKey({
              uri: normalized.result.uri,
              range: normalized.result.targetSelectionRange,
              context: null,
            }),
          );
        }
      }
    }
    return keys;
  }

  private flattenHierarchicalSymbols(
    items: readonly (LanguageHostHierarchicalSymbol | null)[],
    requested: RequestedDocument,
    output: GetDocumentSymbolsResult['symbols'],
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): void {
    const stack: Array<{
      readonly items: readonly (LanguageHostHierarchicalSymbol | null)[];
      readonly parentId: string | null;
      readonly depth: number;
      index: number;
    }> = [{ items, parentId: null, depth: 0, index: 0 }];
    const visited = new WeakSet<object>();
    let visitedNodeCount = 0;
    while (stack.length > 0) {
      throwIfCancelled(signal);
      const frame = stack.at(-1);
      if (frame === undefined) {
        break;
      }
      if (frame.index >= frame.items.length) {
        stack.pop();
        continue;
      }
      if (visitedNodeCount >= PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax) {
        let pendingRoots = 0;
        for (let index = 0; index < stack.length; index += 1) {
          const pendingFrame = stack[index];
          if (pendingFrame !== undefined) {
            pendingRoots = saturatingAddProviderCounts(
              pendingRoots,
              pendingFrame.items.length - pendingFrame.index,
            );
          }
        }
        warnings.addResults(pendingRoots);
        break;
      }

      const item = frame.items[frame.index] ?? null;
      frame.index += 1;
      visitedNodeCount += 1;
      if (item === null) {
        warnings.addUnsupported(1);
        continue;
      }
      if (visited.has(item)) {
        warnings.addUnsupported(1);
        continue;
      }
      visited.add(item);

      const range = normalizeRange(requested.hostDocument, item.range);
      const selectionRange = normalizeRange(
        requested.hostDocument,
        item.selectionRange,
      );
      const valid =
        validBoundedString(item.name, 1, SCHEMA_LIMITS.displayNameCharacters) &&
        validBoundedString(item.detail, 0, SCHEMA_LIMITS.detailTextCharacters) &&
        validBoundedString(item.kind, 1, SCHEMA_LIMITS.symbolKindCharacters) &&
        range !== null &&
        selectionRange !== null &&
        rangeContains(range, selectionRange);
      let parentForChildren = frame.parentId;
      if (valid && range !== null && selectionRange !== null) {
        const id = `s${output.length}`;
        output.push({
          id,
          parentId: frame.parentId,
          name: item.name,
          detail: item.detail.length === 0 ? null : item.detail,
          kind: item.kind,
          range,
          selectionRange,
          deprecated: item.deprecated === true,
          containerName: null,
        });
        parentForChildren = id;
      } else {
        warnings.addUnsupported(1);
      }
      if (!Array.isArray(item.children)) {
        warnings.addUnsupported(1);
        continue;
      }
      if (item.children.length === 0) {
        continue;
      }
      if (frame.depth >= PROVIDER_OUTPUT_LIMITS.documentSymbols.depthMax) {
        warnings.addResults(item.children.length);
        continue;
      }
      stack.push({
        items: item.children,
        parentId: parentForChildren,
        depth: frame.depth + 1,
        index: 0,
      });
    }
  }

  private async flattenFlatSymbols(
    items: readonly (LanguageHostFlatSymbol | null)[],
    requested: RequestedDocument,
    identity: WorkspaceIdentity,
    output: GetDocumentSymbolsResult['symbols'],
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<void> {
    const cache = new Map<string, ProviderDocument>();
    const bounded = snapshotBoundedProviderItems(
      items,
      PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax,
    );
    warnings.addResults(bounded.omittedCount);
    for (const item of bounded.items) {
      throwIfCancelled(signal);
      if (item === null) {
        warnings.addUnsupported(1);
        continue;
      }
      const providerDocument = await this.resolveProviderDocument(
        identity,
        item.uri,
        cache,
        warnings,
        signal,
      );
      if (
        providerDocument === null ||
        !canonicalPathsEqual(
          providerDocument.authorization.canonicalPath,
          requested.authorization.canonicalPath,
          this.#pathStrategy,
        )
      ) {
        if (providerDocument !== null) {
          warnings.addUnsupported(1);
        }
        continue;
      }
      const range = normalizeRange(providerDocument.hostDocument, item.range);
      if (
        range === null ||
        !validBoundedString(item.name, 1, SCHEMA_LIMITS.displayNameCharacters) ||
        !validBoundedString(item.kind, 1, SCHEMA_LIMITS.symbolKindCharacters) ||
        !validBoundedString(item.containerName, 0, SCHEMA_LIMITS.displayNameCharacters)
      ) {
        warnings.addUnsupported(1);
        continue;
      }
      output.push({
        id: `s${output.length}`,
        parentId: null,
        name: item.name,
        detail: null,
        kind: item.kind,
        range,
        selectionRange: range,
        deprecated: item.deprecated === true,
        containerName: item.containerName.length === 0 ? null : item.containerName,
      });
    }
  }

  private async normalizeWorkspaceSymbol(
    item: LanguageHostWorkspaceSymbol | null,
    identity: WorkspaceIdentity,
    cache: Map<string, ProviderDocument>,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<SearchWorkspaceSymbolsResult['symbols'][number] | null> {
    if (item === null) {
      warnings.addUnsupported(1);
      return null;
    }
    const providerDocument = await this.resolveProviderDocument(
      identity,
      item.uri,
      cache,
      warnings,
      signal,
    );
    if (providerDocument === null) {
      return null;
    }
    const range = normalizeRange(providerDocument.hostDocument, item.range);
    if (
      range === null ||
      !validBoundedString(item.name, 1, SCHEMA_LIMITS.displayNameCharacters) ||
      !validBoundedString(item.kind, 1, SCHEMA_LIMITS.symbolKindCharacters) ||
      !validBoundedString(item.containerName, 0, SCHEMA_LIMITS.displayNameCharacters)
    ) {
      warnings.addUnsupported(1);
      return null;
    }
    return {
      name: item.name,
      kind: item.kind,
      containerName: item.containerName.length === 0 ? null : item.containerName,
      uri: providerDocument.canonicalUri,
      range,
    };
  }

  private async normalizeCallItem(
    item: LanguageHostCallItem | null,
    identity: WorkspaceIdentity,
    cache: Map<string, ProviderDocument>,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<InternalCallItem | null> {
    if (item === null) {
      warnings.addUnsupported(1);
      return null;
    }
    const providerDocument = await this.resolveProviderDocument(
      identity,
      item.uri,
      cache,
      warnings,
      signal,
    );
    if (providerDocument === null) {
      return null;
    }
    const range = normalizeRange(providerDocument.hostDocument, item.range);
    const selectionRange = normalizeRange(
      providerDocument.hostDocument,
      item.selectionRange,
    );
    if (
      range === null ||
      selectionRange === null ||
      !rangeContains(range, selectionRange) ||
      !validBoundedString(item.name, 1, SCHEMA_LIMITS.displayNameCharacters) ||
      !validBoundedString(item.detail, 0, SCHEMA_LIMITS.detailTextCharacters) ||
      !validBoundedString(item.kind, 1, SCHEMA_LIMITS.symbolKindCharacters)
    ) {
      warnings.addUnsupported(1);
      return null;
    }
    return {
      providerItem: item,
      document: providerDocument,
      documentVersion: validDocumentVersion(providerDocument.hostDocument.version),
      result: {
        name: item.name,
        detail: item.detail.length === 0 ? null : item.detail,
        kind: item.kind,
        uri: providerDocument.canonicalUri,
        range,
        selectionRange,
      },
    };
  }

  private async normalizeIncomingCalls(
    items: readonly (LanguageHostIncomingCall | null)[],
    identity: WorkspaceIdentity,
    cache: Map<string, ProviderDocument>,
    limit: number,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<NonNullable<GetCallHierarchyResult['incoming']>> {
    const merged = new Map<string, IncomingCallMerge>();
    let remainingRawRangeBudget =
      PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerDirectionMax;
    for (const item of items) {
      throwIfCancelled(signal);
      if (item === null) {
        warnings.addUnsupported(1);
        continue;
      }
      const from = await this.normalizeCallItem(
        item.from,
        identity,
        cache,
        warnings,
        signal,
      );
      if (from === null) {
        continue;
      }
      const normalizedRanges = normalizeCallSiteRanges(
        from.document.hostDocument,
        item.callSiteRanges,
        remainingRawRangeBudget,
        warnings,
      );
      remainingRawRangeBudget -= normalizedRanges.inspectedCount;
      const key = callItemKey(from.result);
      let target = merged.get(key);
      if (target === undefined) {
        target = { from: from.result, ranges: new Map<string, Range>() };
        merged.set(key, target);
      }
      mergeCallSiteRanges(target.ranges, normalizedRanges.ranges);
    }
    const ordered: Array<readonly [string, IncomingCallMerge]> = [];
    for (const entry of merged.entries()) {
      ordered.push(entry);
    }
    ordered.sort(([left], [right]) => compareStrings(left, right));
    if (ordered.length > limit) {
      warnings.addResults(ordered.length - limit);
    }
    const calls: NonNullable<GetCallHierarchyResult['incoming']> = [];
    let remainingPublicRangeBudget =
      TOOL_LIMITS.callHierarchy.callSiteRangesPerDirectionMax;
    const callCount = Math.min(ordered.length, limit);
    for (let index = 0; index < callCount; index += 1) {
      const entry = ordered[index]?.[1];
      if (entry === undefined) {
        continue;
      }
      const boundedRanges = finalizeCallSiteRanges(
        entry.ranges,
        remainingPublicRangeBudget,
        warnings,
      );
      remainingPublicRangeBudget -= boundedRanges.length;
      calls.push({ from: entry.from, callSiteRanges: boundedRanges });
    }
    return calls;
  }

  private async normalizeOutgoingCalls(
    items: readonly (LanguageHostOutgoingCall | null)[],
    selectedRootDocument: ProviderDocument,
    identity: WorkspaceIdentity,
    cache: Map<string, ProviderDocument>,
    limit: number,
    warnings: WarningAccumulator,
    signal: AbortSignal,
  ): Promise<NonNullable<GetCallHierarchyResult['outgoing']>> {
    const merged = new Map<string, OutgoingCallMerge>();
    let remainingRawRangeBudget =
      PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerDirectionMax;
    for (const item of items) {
      throwIfCancelled(signal);
      if (item === null) {
        warnings.addUnsupported(1);
        continue;
      }
      const to = await this.normalizeCallItem(
        item.to,
        identity,
        cache,
        warnings,
        signal,
      );
      if (to === null) {
        continue;
      }
      const normalizedRanges = normalizeCallSiteRanges(
        selectedRootDocument.hostDocument,
        item.callSiteRanges,
        remainingRawRangeBudget,
        warnings,
      );
      remainingRawRangeBudget -= normalizedRanges.inspectedCount;
      const key = callItemKey(to.result);
      let target = merged.get(key);
      if (target === undefined) {
        target = { to: to.result, ranges: new Map<string, Range>() };
        merged.set(key, target);
      }
      mergeCallSiteRanges(target.ranges, normalizedRanges.ranges);
    }
    const ordered: Array<readonly [string, OutgoingCallMerge]> = [];
    for (const entry of merged.entries()) {
      ordered.push(entry);
    }
    ordered.sort(([left], [right]) => compareStrings(left, right));
    if (ordered.length > limit) {
      warnings.addResults(ordered.length - limit);
    }
    const calls: NonNullable<GetCallHierarchyResult['outgoing']> = [];
    let remainingPublicRangeBudget =
      TOOL_LIMITS.callHierarchy.callSiteRangesPerDirectionMax;
    const callCount = Math.min(ordered.length, limit);
    for (let index = 0; index < callCount; index += 1) {
      const entry = ordered[index]?.[1];
      if (entry === undefined) {
        continue;
      }
      const boundedRanges = finalizeCallSiteRanges(
        entry.ranges,
        remainingPublicRangeBudget,
        warnings,
      );
      remainingPublicRangeBudget -= boundedRanges.length;
      calls.push({ to: entry.to, callSiteRanges: boundedRanges });
    }
    return calls;
  }

  private async runProvider<Result>(
    operation: () => Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result> {
    throwIfCancelled(signal);
    try {
      const result = await operation();
      throwIfCancelled(signal);
      return result;
    } catch (error) {
      if (signal.aborted) {
        throwIfCancelled(signal);
      }
      if (error instanceof ToolFailure) {
        throw error;
      }
      if (error instanceof LanguageProviderUnavailableError) {
        throw new ToolFailure(
          failure(
            'PROVIDER_UNAVAILABLE',
            'The language provider is unavailable.',
            false,
          ),
        );
      }
      throw error;
    }
  }

  private async recheckRequest(
    identity: WorkspaceIdentity,
    requested: RequestedDocument,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(signal);
    if (requested.hostDocument.version !== requested.initialVersion) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_CHANGED_DURING_REQUEST',
          'The document changed while the provider request was running.',
          true,
        ),
      );
    }
    await this.requireSameWorkspaceAccess(identity, signal);
    if (requested.hostDocument.version !== requested.initialVersion) {
      throw new ToolFailure(
        failure(
          'DOCUMENT_CHANGED_DURING_REQUEST',
          'The document changed while the provider request was running.',
          true,
        ),
      );
    }
  }

  private authorize(
    identity: WorkspaceIdentity,
    reference: DocumentRef | string,
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
  ): Promise<Extract<LanguageLocationWorkspaceAccess, { eligible: true }>> {
    let access: LanguageLocationWorkspaceAccess;
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

function validDocument(document: LanguageHostDocument): void {
  validDocumentVersion(document.version);
  if (!Number.isSafeInteger(document.lineCount) || document.lineCount <= 0) {
    throw new ToolFailure(internalFailure());
  }
  if (
    !validBoundedString(document.uri, 1, SCHEMA_LIMITS.uriCharacters) ||
    !validBoundedString(document.languageId, 1, SCHEMA_LIMITS.languageIdCharacters)
  ) {
    throw new ToolFailure(internalFailure());
  }
}

function validDocumentVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ToolFailure(internalFailure());
  }
  return value;
}

function createDocumentSnapshot(
  document: LanguageHostDocument,
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

function normalizePosition(
  document: LanguageHostDocument,
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
    const line = document.lineText(position.line);
    return typeof line === 'string' && position.character <= line.length
      ? { line: position.line, character: position.character }
      : null;
  } catch {
    return null;
  }
}

function normalizeRange(
  document: LanguageHostDocument,
  range: LanguageHostRange,
): Range | null {
  if (typeof range !== 'object' || range === null) {
    return null;
  }
  const start = normalizePosition(document, range.start);
  const end = normalizePosition(document, range.end);
  if (start === null || end === null || comparePositions(start, end) > 0) {
    return null;
  }
  return { start, end };
}

function createReferenceContext(
  document: LanguageHostDocument,
  highlightRange: Range,
  contextLines: number,
  warnings: WarningAccumulator,
  signal: AbortSignal,
): FindReferencesResult['references'][number]['context'] {
  const initialVersion = validDocumentVersion(document.version);
  const startLine = Math.max(0, highlightRange.start.line - contextLines);
  const endLine = Math.min(
    document.lineCount - 1,
    highlightRange.end.line + contextLines,
  );
  const eol = document.eol === 'CRLF' ? '\r\n' : '\n';
  const pieces: string[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    throwIfCancelled(signal);
    const lineText = document.lineText(line);
    if (typeof lineText !== 'string') {
      warnings.addUnsupported(1);
      return null;
    }
    pieces.push(lineText);
  }
  if (document.version !== initialVersion) {
    throw new ToolFailure(
      failure(
        'DOCUMENT_CHANGED_DURING_REQUEST',
        'A reference document changed while context was being captured.',
        true,
      ),
    );
  }
  const text = pieces.join(eol);
  if (Buffer.byteLength(text, 'utf8') > TOOL_LIMITS.references.contextSnippetBytes) {
    warnings.addContent();
    return null;
  }
  const lastLine = pieces.at(-1);
  if (lastLine === undefined) {
    warnings.addUnsupported(1);
    return null;
  }
  return {
    range: {
      start: { line: startLine, character: 0 },
      end: { line: endLine, character: lastLine.length },
    },
    text,
    highlightRange,
    documentVersion: initialVersion,
    isDirty: document.isDirty,
  };
}

function dedupeAndSortDefinitions(
  items: readonly InternalDefinitionLocation[],
): InternalDefinitionLocation[] {
  const seen = new Set<string>();
  const unique: InternalDefinitionLocation[] = [];
  for (const item of items) {
    const key = definitionKey(item.result);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  unique.sort((left, right) =>
    compareStrings(definitionKey(left.result), definitionKey(right.result)),
  );
  return unique;
}

function dedupeAndSortReferences(
  items: readonly {
    readonly result: FindReferencesResult['references'][number];
    readonly canonicalPath: string;
  }[],
): Array<{
  readonly result: FindReferencesResult['references'][number];
  readonly canonicalPath: string;
}> {
  const seen = new Set<string>();
  const unique = [];
  for (const item of items) {
    const key = referenceKey(item.result);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  unique.sort((left, right) =>
    compareStrings(referenceKey(left.result), referenceKey(right.result)),
  );
  return unique;
}

function takeBudgetedPrefix<Item>(
  items: readonly Item[],
  itemLimit: number,
  warnings: WarningAccumulator,
): Item[] {
  const hardLimited = items.slice(0, itemLimit);
  if (items.length > hardLimited.length) {
    warnings.addResults(items.length - hardLimited.length);
  }
  const output: Item[] = [];
  let bytes = 2;
  for (const item of hardLimited) {
    const itemBytes = serializedBytes(item) + (output.length === 0 ? 0 : 1);
    if (bytes + itemBytes > OUTPUT_COLLECTION_BUDGET_BYTES) {
      break;
    }
    output.push(item);
    bytes += itemBytes;
  }
  if (hardLimited.length > output.length) {
    warnings.addResults(hardLimited.length - output.length);
  }
  return output;
}

function boundedProviderItems<Item>(
  batch: BoundedProviderItems<Item>,
  maximum: number,
  warnings: WarningAccumulator,
): readonly Item[] {
  const bounded = limitBoundedProviderItems(batch, maximum);
  warnings.addResults(bounded.omittedCount);
  return bounded.items;
}

function budgetReferences(
  references: FindReferencesResult['references'],
  warnings: WarningAccumulator,
): FindReferencesResult['references'] {
  const output = references.map((reference) => ({ ...reference }));
  let bytes = serializedBytes(output);
  if (bytes > OUTPUT_COLLECTION_BUDGET_BYTES) {
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const reference = output[index];
      if (reference !== undefined && reference.context !== null) {
        const withoutContext = { ...reference, context: null };
        bytes -= serializedBytes(reference) - serializedBytes(withoutContext);
        output[index] = withoutContext;
        warnings.addContent();
        if (bytes <= OUTPUT_COLLECTION_BUDGET_BYTES) {
          break;
        }
      }
    }
  }
  while (bytes > OUTPUT_COLLECTION_BUDGET_BYTES && output.length > 0) {
    output.pop();
    warnings.addResults(1);
    bytes = serializedBytes(output);
  }
  return output;
}

function normalizeCallSiteRanges(
  document: LanguageHostDocument,
  ranges: readonly (LanguageHostRange | null)[],
  remainingDirectionBudget: number,
  warnings: WarningAccumulator,
): { readonly ranges: readonly Range[]; readonly inspectedCount: number } {
  if (!Array.isArray(ranges)) {
    warnings.addUnsupported(1);
    return { ranges: [], inspectedCount: 0 };
  }
  const maximum = Math.min(
    PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
    remainingDirectionBudget,
  );
  const bounded = snapshotBoundedProviderItems(ranges, maximum);
  warnings.addResults(bounded.omittedCount);
  const normalized: Range[] = [];
  const seen = new Set<string>();
  for (const range of bounded.items) {
    if (range === null) {
      warnings.addUnsupported(1);
      continue;
    }
    const value = normalizeRange(document, range);
    if (value === null) {
      warnings.addUnsupported(1);
      continue;
    }
    const key = rangeKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(value);
    }
  }
  normalized.sort((left, right) => compareStrings(rangeKey(left), rangeKey(right)));
  return { ranges: normalized, inspectedCount: bounded.items.length };
}

function mergeCallSiteRanges(
  destination: Map<string, Range>,
  ranges: readonly Range[],
): void {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (range !== undefined) {
      const key = rangeKey(range);
      if (!destination.has(key)) {
        destination.set(key, range);
      }
    }
  }
}

function finalizeCallSiteRanges(
  ranges: ReadonlyMap<string, Range>,
  remainingDirectionBudget: number,
  warnings: WarningAccumulator,
): Range[] {
  const ordered: Array<readonly [string, Range]> = [];
  for (const entry of ranges.entries()) {
    ordered.push(entry);
  }
  ordered.sort(([left], [right]) => compareStrings(left, right));
  const maximum = Math.min(
    TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax,
    remainingDirectionBudget,
  );
  const output: Range[] = [];
  const count = Math.min(ordered.length, maximum);
  for (let index = 0; index < count; index += 1) {
    const range = ordered[index]?.[1];
    if (range !== undefined) {
      output.push(range);
    }
  }
  warnings.addResults(ordered.length - output.length);
  return output;
}

function budgetCallHierarchy(
  roots: GetCallHierarchyResult['roots'],
  selectedRootIndex: number,
  incoming: GetCallHierarchyResult['incoming'],
  outgoing: GetCallHierarchyResult['outgoing'],
  warnings: WarningAccumulator,
): Pick<
  GetCallHierarchyResult,
  'roots' | 'selectedRootIndex' | 'incoming' | 'outgoing'
> {
  const rootBytes = serializedBytes(roots);
  let remaining = Math.max(0, OUTPUT_COLLECTION_BUDGET_BYTES - rootBytes);
  const boundedIncoming: NonNullable<GetCallHierarchyResult['incoming']> = [];
  const boundedOutgoing: NonNullable<GetCallHierarchyResult['outgoing']> = [];
  const inputIncoming = incoming ?? [];
  const inputOutgoing = outgoing ?? [];
  let incomingIndex = 0;
  let outgoingIndex = 0;
  while (incomingIndex < inputIncoming.length || outgoingIndex < inputOutgoing.length) {
    let progressed = false;
    if (incomingIndex < inputIncoming.length) {
      const item = inputIncoming[incomingIndex];
      const bytes = item === undefined ? 0 : serializedBytes(item) + 1;
      if (item !== undefined && bytes <= remaining) {
        boundedIncoming.push(item);
        remaining -= bytes;
        progressed = true;
      }
      incomingIndex += 1;
    }
    if (outgoingIndex < inputOutgoing.length) {
      const item = inputOutgoing[outgoingIndex];
      const bytes = item === undefined ? 0 : serializedBytes(item) + 1;
      if (item !== undefined && bytes <= remaining) {
        boundedOutgoing.push(item);
        remaining -= bytes;
        progressed = true;
      }
      outgoingIndex += 1;
    }
    if (!progressed && remaining === 0) {
      break;
    }
  }
  if (boundedIncoming.length < inputIncoming.length) {
    warnings.addResults(inputIncoming.length - boundedIncoming.length);
  }
  if (boundedOutgoing.length < inputOutgoing.length) {
    warnings.addResults(inputOutgoing.length - boundedOutgoing.length);
  }
  return {
    roots,
    selectedRootIndex,
    incoming: incoming === null ? null : boundedIncoming,
    outgoing: outgoing === null ? null : boundedOutgoing,
  };
}

function definitionKey(value: GetDefinitionResult['locations'][number]): string {
  return stableKey([
    value.uri,
    rangeKey(value.targetRange),
    rangeKey(value.targetSelectionRange),
    value.originSelectionRange === null ? '' : rangeKey(value.originSelectionRange),
  ]);
}

function referenceKey(value: FindReferencesResult['references'][number]): string {
  return stableKey([value.uri, rangeKey(value.range)]);
}

function workspaceSymbolKey(
  value: SearchWorkspaceSymbolsResult['symbols'][number],
): string {
  return stableKey([
    value.name,
    value.kind,
    value.containerName ?? '',
    value.uri,
    rangeKey(value.range),
  ]);
}

function callItemKey(value: GetCallHierarchyResult['roots'][number]): string {
  return stableKey([
    value.uri,
    rangeKey(value.range),
    rangeKey(value.selectionRange),
    value.kind,
    value.name,
    value.detail ?? '',
  ]);
}

function stableKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function rangeKey(range: Range): string {
  return `${positionKey(range.start)}-${positionKey(range.end)}`;
}

function positionKey(position: Position): string {
  return `${position.line.toString().padStart(10, '0')}:${position.character
    .toString()
    .padStart(10, '0')}`;
}

function comparePositions(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function rangeContains(outer: Range, inner: Range): boolean {
  return (
    comparePositions(outer.start, inner.start) <= 0 &&
    comparePositions(inner.end, outer.end) <= 0
  );
}

function recheckProviderDocumentVersion(item: InternalCallItem): void {
  if (item.document.hostDocument.version !== item.documentVersion) {
    throw new ToolFailure(
      failure(
        'DOCUMENT_CHANGED_DURING_REQUEST',
        'The selected call-hierarchy document changed during the request.',
        true,
      ),
    );
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validBoundedString(
  value: string,
  minimumCharacters: number,
  maximumCharacters: number,
): boolean {
  return (
    typeof value === 'string' &&
    value.length >= minimumCharacters &&
    value.length <= maximumCharacters
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function canonicalUri(
  canonicalPath: string,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): string {
  try {
    return pathStrategy.pathToFileUri(canonicalPath);
  } catch {
    throw new ToolFailure(internalFailure());
  }
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

function recognizeTool(
  value: unknown,
): (typeof LANGUAGE_LOCATION_EXTENSION_TOOL_NAMES)[number] | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tool' in value) ||
    typeof value.tool !== 'string'
  ) {
    return null;
  }
  for (const tool of LANGUAGE_LOCATION_EXTENSION_TOOL_NAMES) {
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
  return failure(
    'INTERNAL_ERROR',
    'The language intelligence request failed internally.',
    false,
  );
}

function toolError(tool: ExtensionToolName, error: ToolFailureData): IpcCallToolResult {
  return IpcCallToolResultSchema.parse({ outcome: 'toolError', tool, error });
}

function success(
  tool: (typeof LANGUAGE_LOCATION_EXTENSION_TOOL_NAMES)[number],
  result: unknown,
  warnings: WarningAccumulator,
  now: () => Date,
): IpcCallToolResult {
  const value = IpcCallToolResultSchema.parse({
    outcome: 'success',
    observedAt: now().toISOString(),
    truncated: warnings.truncated,
    warnings: warnings.toArray(),
    payload: { tool, result },
  });
  if (serializedBytes(value) > PROTOCOL_LIMITS.mcpResultBytes) {
    throw new ToolFailure(internalFailure());
  }
  return value;
}

class WarningAccumulator {
  #results = 0;
  #content = false;
  #external = 0;
  #unsupported = 0;
  #noResult = false;

  public get truncated(): boolean {
    return (
      this.#results > 0 || this.#content || this.#external > 0 || this.#unsupported > 0
    );
  }

  public addResults(count: number): void {
    if (Number.isSafeInteger(count) && count > 0) {
      this.#results = saturatingAddProviderCounts(this.#results, count);
    }
  }

  public addContent(): void {
    this.#content = true;
  }

  public addUnsupported(count: number): void {
    if (Number.isSafeInteger(count) && count > 0) {
      this.#unsupported = saturatingAddProviderCounts(this.#unsupported, count);
    }
  }

  public addNoResult(): void {
    this.#noResult = true;
  }

  public addAuthorization(code: WorkspaceAuthorizationErrorCode): void {
    if (code === 'DOCUMENT_OUTSIDE_WORKSPACE') {
      this.#external = saturatingAddProviderCounts(this.#external, 1);
    } else {
      this.addUnsupported(1);
    }
  }

  public toArray(): Warning[] {
    const warnings: Warning[] = [];
    if (this.#results > 0) {
      warnings.push({
        code: 'RESULTS_TRUNCATED',
        message: 'Some provider results were omitted to enforce safe limits.',
        omittedCount: this.#results,
      });
    }
    if (this.#content) {
      warnings.push({
        code: 'CONTENT_TRUNCATED',
        message: 'Optional reference context was omitted at a content limit.',
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
    if (this.#noResult) {
      warnings.push({
        code: 'PROVIDER_RETURNED_NO_RESULT',
        message: 'A language provider returned no result.',
      });
    }
    return warnings;
  }
}
