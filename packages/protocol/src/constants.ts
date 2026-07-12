export const REGISTRY_SCHEMA_VERSION = 1 as const;
export const IPC_PROTOCOL_VERSION = 1 as const;
export const TOOL_CONTRACT_VERSION = '1.0.0' as const;
/** Accepted post-1.0 read contract. Not the active runtime contract until promotion. */
export const V02_TOOL_CONTRACT_VERSION = '0.2.0' as const;
export const JSON_RPC_VERSION = '2.0' as const;
export const IPC_APPLICATION_ERROR_CODE = -31_000 as const;

export const IPC_METHODS = {
  hello: 'vscode-mcp/hello',
  callTool: 'vscode-mcp/callTool',
  closeSession: 'vscode-mcp/closeSession',
  cancelRequest: '$/cancelRequest',
} as const;

/**
 * Fixed protocol limits. They are deliberately not negotiated in IPC protocol v1.
 * Byte limits are UTF-8 serialized sizes unless a field says otherwise.
 */
export const PROTOCOL_LIMITS = {
  framingHeaderBytes: 8 * 1024,
  mcpInboundMessageBytes: 256 * 1024,
  mcpToolArgumentsBytes: 256 * 1024,
  registryRecordBytes: 64 * 1024,
  bridgeToExtensionFrameBytes: 256 * 1024,
  extensionToBridgeFrameBytes: 2 * 1024 * 1024,
  mcpResultBytes: 512 * 1024,
  authTokenBytes: 32,
  authTokenBase64UrlCharacters: 43,
  endpointEntropyBytes: 16,
  handshakeTimeoutMs: 3_000,
  endpointProbeTimeoutMs: 3_000,
  sessionCloseTimeoutMs: 3_000,
  sessionReleaseSettleMs: 50,
  registryHeartbeatIntervalMs: 5_000,
  registryStaleAfterMs: 60_000,
  simpleOperationTimeoutMs: 5_000,
  providerOperationTimeoutMs: 15_000,
  connectionsPerWindow: 4,
  activeCallsPerConnection: 4,
  activeCallsPerWindow: 8,
  queuedCallsPerWindow: 16,
  registryInstances: 64,
  workspaceFoldersPerInstance: 64,
  errorDetailEntries: 16,
  errorDetailsBytes: 16 * 1024,
} as const;

export const SCHEMA_LIMITS = {
  workspaceFolderIdCharacters: 256,
  relativePathCharacters: 4_096,
  canonicalPathCharacters: 32_768,
  uriCharacters: 16_384,
  displayNameCharacters: 512,
  detailTextCharacters: 16_384,
  symbolKindCharacters: 128,
  symbolIdCharacters: 256,
  diagnosticCodeCharacters: 1_024,
  languageIdCharacters: 256,
  clientVersionCharacters: 64,
  errorMessageCharacters: 4_096,
  transportErrorMessageCharacters: 512,
  safeDetailKeyCharacters: 64,
  safeDetailStringCharacters: 1_024,
} as const;

/**
 * Raw language-provider traversal limits. These are applied before provider-owned
 * arrays are normalized or materialized into public tool results.
 */
export const PROVIDER_OUTPUT_LIMITS = {
  openDocuments: {
    itemsMax: 8_000,
  },
  diagnostics: {
    itemsPerRequestMax: 8_000,
    tagsPerItemMax: 8,
    relatedInformationPerItemMax: 128,
    relatedInformationPerRequestMax: 8_000,
  },
  hover: {
    entriesMax: 20,
    contentsPerEntryMax: 256,
    contentsPerRequestMax: 1_024,
  },
  signatureHelp: {
    signaturesMax: 20,
    parametersPerSignatureMax: 100,
  },
  definition: {
    itemsMax: 800,
  },
  references: {
    itemsMax: 4_000,
  },
  documentSymbols: {
    nodesMax: 8_000,
    depthMax: 128,
  },
  workspaceSymbols: {
    itemsMax: 2_000,
  },
  callHierarchy: {
    rootsMax: 40,
    callsPerDirectionMax: 1_000,
    callSiteRangesPerItemMax: 1_000,
    callSiteRangesPerDirectionMax: 4_000,
  },
} as const;

export const TOOL_LIMITS = {
  warnings: 5,
  editorContext: {
    documentsDefault: 100,
    documentsMax: 200,
    tabsDefault: 100,
    tabsMax: 200,
    selectionsPerEditor: 32,
    visibleRangesPerEditor: 32,
  },
  readDocument: {
    startLineDefault: 0,
    lineCountDefault: 500,
    lineCountMax: 2_000,
    returnedTextBytes: 256 * 1024,
    closedFileBytes: 10 * 1024 * 1024,
  },
  diagnostics: {
    documentsMax: 200,
    itemsDefault: 500,
    itemsMax: 2_000,
    tagsPerItemMax: 2,
    relatedInformationPerItemMax: 32,
    relatedInformationPerRequestMax: 2_000,
    messageBytes: 16 * 1024,
    quietPeriodMs: 300,
    maximumWaitMs: 1_500,
  },
  hover: {
    entriesMax: 20,
    contentsPerEntryMax: 64,
    contentsPerRequestMax: 256,
    combinedTextBytes: 64 * 1024,
  },
  definition: {
    itemsDefault: 50,
    itemsMax: 200,
  },
  references: {
    itemsDefault: 200,
    itemsMax: 1_000,
    contextLinesDefault: 0,
    contextLinesMax: 2,
    contextSnippetBytes: 4 * 1024,
  },
  documentSymbols: {
    itemsDefault: 500,
    itemsMax: 2_000,
  },
  workspaceSymbols: {
    itemsDefault: 100,
    itemsMax: 500,
    queryCharactersMax: 256,
  },
  signatureHelp: {
    signaturesMax: 20,
    parametersPerSignatureMax: 100,
    combinedTextBytes: 64 * 1024,
  },
  callHierarchy: {
    rootsMax: 10,
    itemsPerDirectionDefault: 100,
    itemsPerDirectionMax: 250,
    callSiteRangesPerItemMax: 250,
    callSiteRangesPerDirectionMax: 1_000,
  },
} as const;

export const V02_READ_DEFAULT_EXCLUDE =
  '**/{.git,node_modules,dist,out,build,coverage,artifacts,.vscode-test,.next,.open-next,.sst,.wrangler,.turbo,.cache,.parcel-cache,.nuxt,.output,.tmp,__pycache__,.venv}/**' as const;

/** Accepted v0.2 read/discovery limits. The v0.1 runtime does not consume them. */
export const V02_READ_TOOL_LIMITS = {
  globBytes: 1_024,
  cursorCharacters: 2_048,
  discoveryCandidates: 10_000,
  discoveryDetectionSlots: 1,
  listWorkspaceFiles: {
    itemsDefault: 500,
    itemsMax: 2_000,
  },
  readDocuments: {
    itemsMax: 32,
    contentBytesDefault: 256 * 1024,
    contentBytesMax: 320 * 1024,
    serializedResultBytes: 448 * 1024,
    itemErrorMessageCharacters: 512,
  },
  searchWorkspaceText: {
    queryScalarsMax: 256,
    closedFileBytes: 2 * 1024 * 1024,
    aggregateInspectedBytes: 64 * 1024 * 1024,
    concurrentClosedFileReadsPerWindow: 2,
    matchesDefault: 100,
    matchesMax: 1_000,
    contextLinesDefault: 0,
    contextLinesMax: 2,
    contextSnippetBytes: 4 * 1024,
    aggregateContextBytes: 256 * 1024,
    serializedResultBytes: 448 * 1024,
    timeoutMs: 5_000,
  },
  serializedResultBytes: 448 * 1024,
  warnings: 7,
} as const;

export const V1_IDE_TOOL_LIMITS = {
  structuredResultBytes: 448 * 1024,
  documentsPerWrite: 32,
  editsTotal: 2_048,
  editsPerDocument: 512,
  replacementBytesTotal: 2 * 1024 * 1024,
  replacementBytesPerEdit: 256 * 1024,
  createdFileBytes: 2 * 1024 * 1024,
  completions: 200,
  codeActions: 100,
  providerItems: 500,
  previewHandles: 32,
  previewLifetimeMs: 60_000,
  listedTasks: 200,
  trackedTasks: 4,
  trackedDebugSessions: 4,
  taskLifetimeMs: 30 * 60_000,
} as const;
