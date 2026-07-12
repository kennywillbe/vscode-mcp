import { Buffer } from 'node:buffer';

import * as z from 'zod/v4';

import {
  PROTOCOL_LIMITS,
  SCHEMA_LIMITS,
  TOOL_CONTRACT_VERSION,
  TOOL_LIMITS,
} from './constants.js';
import {
  DocumentRefSchema,
  DocumentSnapshotSchema,
  FileUriSchema,
  InstanceDescriptorSchema,
  InstanceIdSchema,
  PositionSchema,
  RangeSchema,
  UtcTimestampSchema,
  WorkspaceFolderDescriptorSchema,
} from './schemas.js';

const DocumentVersionSchema = z.number().int().nonnegative();
const LimitSchema = (maximum: number) => z.number().int().positive().max(maximum);

function utf8TextSchema(maximumBytes: number) {
  return z
    .string()
    .max(maximumBytes)
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );
}

function isSingleUnicodeScalar(value: string): boolean {
  const codePoints = Array.from(value);
  if (codePoints.length !== 1) {
    return false;
  }

  const codePoint = codePoints[0]?.codePointAt(0);
  return (
    codePoint !== undefined &&
    (codePoint < 0xd800 || codePoint > 0xdfff) &&
    codePoint <= 0x10ffff
  );
}

export const ALL_TOOL_NAMES = [
  'list_instances',
  'get_editor_context',
  'read_document',
  'get_diagnostics',
  'get_hover',
  'get_definition',
  'find_references',
  'get_document_symbols',
  'search_workspace_symbols',
  'get_signature_help',
  'get_call_hierarchy',
] as const;

export const EXTENSION_TOOL_NAMES = [
  'get_editor_context',
  'read_document',
  'get_diagnostics',
  'get_hover',
  'get_definition',
  'find_references',
  'get_document_symbols',
  'search_workspace_symbols',
  'get_signature_help',
  'get_call_hierarchy',
] as const;

export const AllToolNameSchema = z.enum(ALL_TOOL_NAMES);
export const ExtensionToolNameSchema = z.enum(EXTENSION_TOOL_NAMES);

export const WarningCodeSchema = z.enum([
  'RESULTS_TRUNCATED',
  'CONTENT_TRUNCATED',
  'EXTERNAL_LOCATIONS_OMITTED',
  'UNSUPPORTED_ITEMS_OMITTED',
  'PROVIDER_RETURNED_NO_RESULT',
]);

export const WarningSchema = z
  .object({
    code: WarningCodeSchema,
    message: z.string().min(1).max(SCHEMA_LIMITS.errorMessageCharacters),
    omittedCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

export const WarningsSchema = z
  .array(WarningSchema)
  .max(TOOL_LIMITS.warnings)
  .superRefine((warnings, context) => {
    const codes = new Set<string>();
    let previousIndex = -1;

    for (const [index, warning] of warnings.entries()) {
      const warningIndex = WarningCodeSchema.options.indexOf(warning.code);
      if (codes.has(warning.code)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'code'],
          message: 'Warning codes must be unique.',
        });
      }
      if (warningIndex <= previousIndex) {
        context.addIssue({
          code: 'custom',
          path: [index, 'code'],
          message: 'Warnings must use canonical warning-code order.',
        });
      }
      codes.add(warning.code);
      previousIndex = warningIndex;
    }
  });

export function createSuccessSchema<ResultSchema extends z.ZodType>(
  resultSchema: ResultSchema,
) {
  return z
    .object({
      contractVersion: z.literal(TOOL_CONTRACT_VERSION),
      instanceId: InstanceIdSchema.nullable(),
      observedAt: UtcTimestampSchema,
      truncated: z.boolean(),
      warnings: WarningsSchema,
      result: resultSchema,
    })
    .strict();
}

const InstanceSelectorShape = {
  instanceId: InstanceIdSchema.optional(),
};

const ExpectedVersionShape = {
  expectedDocumentVersion: DocumentVersionSchema.optional(),
};

export const ListInstancesInputSchema = z.object({}).strict();

export const GetEditorContextArgumentsSchema = z
  .object({
    documentLimit: LimitSchema(TOOL_LIMITS.editorContext.documentsMax).optional(),
    tabLimit: LimitSchema(TOOL_LIMITS.editorContext.tabsMax).optional(),
  })
  .strict();

export const GetEditorContextInputSchema =
  GetEditorContextArgumentsSchema.extend(InstanceSelectorShape).strict();

export const ReadDocumentArgumentsSchema = z
  .object({
    document: DocumentRefSchema,
    ...ExpectedVersionShape,
    startLine: z.number().int().nonnegative().optional(),
    lineCount: LimitSchema(TOOL_LIMITS.readDocument.lineCountMax).optional(),
  })
  .strict();

export const ReadDocumentInputSchema =
  ReadDocumentArgumentsSchema.extend(InstanceSelectorShape).strict();

export const DiagnosticSeveritySchema = z.enum([
  'error',
  'warning',
  'information',
  'hint',
]);

const DiagnosticSeverityFilterSchema = z
  .array(DiagnosticSeveritySchema)
  .max(4)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        message: 'Diagnostic severities must be unique.',
      });
    }
  });

export const GetDiagnosticsArgumentsSchema = z
  .object({
    document: DocumentRefSchema.optional(),
    ...ExpectedVersionShape,
    severities: DiagnosticSeverityFilterSchema.optional(),
    includeRelatedInformation: z.boolean().optional(),
    limit: LimitSchema(TOOL_LIMITS.diagnostics.itemsMax).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expectedDocumentVersion !== undefined && value.document === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDocumentVersion'],
        message: 'expectedDocumentVersion requires a document.',
      });
    }
  });

export const GetDiagnosticsInputSchema =
  GetDiagnosticsArgumentsSchema.safeExtend(InstanceSelectorShape).strict();

export const GetHoverArgumentsSchema = z
  .object({
    document: DocumentRefSchema,
    position: PositionSchema,
    ...ExpectedVersionShape,
  })
  .strict();

export const GetHoverInputSchema =
  GetHoverArgumentsSchema.extend(InstanceSelectorShape).strict();

export const DefinitionKindSchema = z.enum([
  'definition',
  'declaration',
  'typeDefinition',
  'implementation',
]);

export const GetDefinitionArgumentsSchema = z
  .object({
    document: DocumentRefSchema,
    position: PositionSchema,
    ...ExpectedVersionShape,
    kind: DefinitionKindSchema.optional(),
    limit: LimitSchema(TOOL_LIMITS.definition.itemsMax).optional(),
  })
  .strict();

export const GetDefinitionInputSchema =
  GetDefinitionArgumentsSchema.extend(InstanceSelectorShape).strict();

export const FindReferencesArgumentsSchema = z
  .object({
    document: DocumentRefSchema,
    position: PositionSchema,
    ...ExpectedVersionShape,
    includeDeclaration: z.boolean().optional(),
    contextLines: z
      .number()
      .int()
      .nonnegative()
      .max(TOOL_LIMITS.references.contextLinesMax)
      .optional(),
    limit: LimitSchema(TOOL_LIMITS.references.itemsMax).optional(),
  })
  .strict();

export const FindReferencesInputSchema =
  FindReferencesArgumentsSchema.extend(InstanceSelectorShape).strict();

export const GetDocumentSymbolsArgumentsSchema = z
  .object({
    document: DocumentRefSchema,
    ...ExpectedVersionShape,
    limit: LimitSchema(TOOL_LIMITS.documentSymbols.itemsMax).optional(),
  })
  .strict();

export const GetDocumentSymbolsInputSchema =
  GetDocumentSymbolsArgumentsSchema.extend(InstanceSelectorShape).strict();

const WorkspaceSymbolQuerySchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'Query must already be trimmed.')
  .refine(
    (value) =>
      Array.from(value).length <= TOOL_LIMITS.workspaceSymbols.queryCharactersMax,
    `Query must not exceed ${TOOL_LIMITS.workspaceSymbols.queryCharactersMax} Unicode characters.`,
  );

export const SearchWorkspaceSymbolsArgumentsSchema = z
  .object({
    query: WorkspaceSymbolQuerySchema,
    limit: LimitSchema(TOOL_LIMITS.workspaceSymbols.itemsMax).optional(),
  })
  .strict();

export const SearchWorkspaceSymbolsInputSchema =
  SearchWorkspaceSymbolsArgumentsSchema.extend(InstanceSelectorShape).strict();

const TriggerCharacterSchema = z
  .string()
  .refine(isSingleUnicodeScalar, 'Trigger character must be one Unicode scalar value.');

export const GetSignatureHelpArgumentsSchema = z
  .object({
    document: DocumentRefSchema,
    position: PositionSchema,
    ...ExpectedVersionShape,
    triggerCharacter: TriggerCharacterSchema.optional(),
  })
  .strict();

export const GetSignatureHelpInputSchema =
  GetSignatureHelpArgumentsSchema.extend(InstanceSelectorShape).strict();

export const CallHierarchyDirectionSchema = z.enum(['incoming', 'outgoing', 'both']);

export const GetCallHierarchyArgumentsSchema = z
  .object({
    document: DocumentRefSchema,
    position: PositionSchema,
    ...ExpectedVersionShape,
    rootIndex: z.number().int().nonnegative().optional(),
    direction: CallHierarchyDirectionSchema.optional(),
    limitPerDirection: LimitSchema(
      TOOL_LIMITS.callHierarchy.itemsPerDirectionMax,
    ).optional(),
  })
  .strict();

export const GetCallHierarchyInputSchema =
  GetCallHierarchyArgumentsSchema.extend(InstanceSelectorShape).strict();

export const WorkspaceFolderResultSchema = WorkspaceFolderDescriptorSchema;
export const ListedInstanceSchema = InstanceDescriptorSchema;

const CandidateInstanceIdsSchema = z
  .array(InstanceIdSchema)
  .max(PROTOCOL_LIMITS.registryInstances)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate instance IDs must be unique.',
      });
    }
  });

export const ListInstancesResultSchema = z
  .object({
    instances: z.array(ListedInstanceSchema).max(PROTOCOL_LIMITS.registryInstances),
    resolution: z
      .object({
        selectedInstanceId: InstanceIdSchema.nullable(),
        method: z.enum(['explicit', 'cwd', 'single', 'none', 'ambiguous']),
        candidateInstanceIds: CandidateInstanceIdsSchema,
      })
      .strict(),
  })
  .strict();

export const SelectionSchema = z
  .object({
    anchor: PositionSchema,
    active: PositionSchema,
    start: PositionSchema,
    end: PositionSchema,
  })
  .strict();

export const EditorStateSchema = z
  .object({
    document: DocumentSnapshotSchema,
    selections: z
      .array(SelectionSchema)
      .max(TOOL_LIMITS.editorContext.selectionsPerEditor),
    visibleRanges: z
      .array(RangeSchema)
      .max(TOOL_LIMITS.editorContext.visibleRangesPerEditor),
  })
  .strict();

export const EditorTabSchema = z
  .object({
    groupIndex: z.number().int().nonnegative(),
    active: z.boolean(),
    pinned: z.boolean(),
    preview: z.boolean(),
    dirty: z.boolean(),
    document: DocumentSnapshotSchema,
  })
  .strict();

export const GetEditorContextResultSchema = z
  .object({
    activeEditor: EditorStateSchema.nullable(),
    visibleEditors: z
      .array(EditorStateSchema)
      .max(TOOL_LIMITS.editorContext.documentsMax),
    openDocuments: z
      .array(DocumentSnapshotSchema)
      .max(TOOL_LIMITS.editorContext.documentsMax),
    tabs: z.array(EditorTabSchema).max(TOOL_LIMITS.editorContext.tabsMax),
    omitted: z
      .object({
        editors: z.number().int().nonnegative(),
        documents: z.number().int().nonnegative(),
        tabs: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const ReadDocumentResultSchema = z
  .object({
    document: DocumentSnapshotSchema,
    eol: z.enum(['LF', 'CRLF']),
    totalLineCount: z.number().int().positive(),
    returnedRange: RangeSchema,
    text: utf8TextSchema(TOOL_LIMITS.readDocument.returnedTextBytes),
    hasMore: z.boolean(),
    nextStartLine: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hasMore !== (value.nextStartLine !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['nextStartLine'],
        message: 'nextStartLine must be present exactly when hasMore is true.',
      });
    }
  });

export const DiagnosticTagSchema = z.enum(['unnecessary', 'deprecated']);

export const DiagnosticSchema = z
  .object({
    range: RangeSchema,
    severity: DiagnosticSeveritySchema,
    message: utf8TextSchema(TOOL_LIMITS.diagnostics.messageBytes),
    source: z.string().max(SCHEMA_LIMITS.displayNameCharacters).nullable(),
    code: z
      .object({
        value: z.string().max(SCHEMA_LIMITS.diagnosticCodeCharacters),
        targetUri: FileUriSchema.nullable(),
      })
      .strict()
      .nullable(),
    tags: z
      .array(DiagnosticTagSchema)
      .max(TOOL_LIMITS.diagnostics.tagsPerItemMax)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: 'custom',
            message: 'Diagnostic tags must be unique.',
          });
        }
      }),
    relatedInformation: z
      .array(
        z
          .object({
            uri: FileUriSchema,
            range: RangeSchema,
            message: utf8TextSchema(TOOL_LIMITS.diagnostics.messageBytes),
          })
          .strict(),
      )
      .max(TOOL_LIMITS.diagnostics.relatedInformationPerItemMax),
  })
  .strict();

export const GetDiagnosticsResultSchema = z
  .object({
    coverage: z.enum(['requested_document', 'open_documents']),
    freshness: z
      .object({
        state: z.enum(['settled', 'changing', 'unknown']),
        heuristic: z.literal(true),
        quietPeriodMs: z.literal(TOOL_LIMITS.diagnostics.quietPeriodMs),
        waitedMs: z
          .number()
          .int()
          .nonnegative()
          .max(TOOL_LIMITS.diagnostics.maximumWaitMs),
        lastChangeAt: UtcTimestampSchema.nullable(),
      })
      .strict(),
    documents: z
      .array(
        z
          .object({
            document: DocumentSnapshotSchema,
            diagnostics: z
              .array(DiagnosticSchema)
              .max(TOOL_LIMITS.diagnostics.itemsMax),
          })
          .strict(),
      )
      .max(TOOL_LIMITS.diagnostics.documentsMax),
  })
  .strict()
  .superRefine((value, context) => {
    let diagnosticCount = 0;
    let relatedInformationCount = 0;
    for (const document of value.documents) {
      diagnosticCount += document.diagnostics.length;
      for (const diagnostic of document.diagnostics) {
        relatedInformationCount += diagnostic.relatedInformation.length;
      }
    }
    if (diagnosticCount > TOOL_LIMITS.diagnostics.itemsMax) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: `The total diagnostic count must not exceed ${TOOL_LIMITS.diagnostics.itemsMax}.`,
      });
    }
    if (
      relatedInformationCount > TOOL_LIMITS.diagnostics.relatedInformationPerRequestMax
    ) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: `The total related-information count must not exceed ${TOOL_LIMITS.diagnostics.relatedInformationPerRequestMax}.`,
      });
    }
  });

export const MarkupContentSchema = z
  .object({
    kind: z.enum(['markdown', 'plaintext']),
    value: utf8TextSchema(TOOL_LIMITS.hover.combinedTextBytes),
  })
  .strict();

export const GetHoverResultSchema = z
  .object({
    document: DocumentSnapshotSchema,
    hovers: z
      .array(
        z
          .object({
            range: RangeSchema.nullable(),
            contents: z
              .array(MarkupContentSchema)
              .max(TOOL_LIMITS.hover.contentsPerEntryMax),
          })
          .strict(),
      )
      .max(TOOL_LIMITS.hover.entriesMax),
  })
  .strict()
  .superRefine((value, context) => {
    let contentBytes = 0;
    let contentCount = 0;
    for (const hover of value.hovers) {
      contentCount += hover.contents.length;
      for (const content of hover.contents) {
        contentBytes += Buffer.byteLength(content.value, 'utf8');
      }
    }
    if (contentBytes > TOOL_LIMITS.hover.combinedTextBytes) {
      context.addIssue({
        code: 'custom',
        path: ['hovers'],
        message: `Combined hover content must not exceed ${TOOL_LIMITS.hover.combinedTextBytes} UTF-8 bytes.`,
      });
    }
    if (contentCount > TOOL_LIMITS.hover.contentsPerRequestMax) {
      context.addIssue({
        code: 'custom',
        path: ['hovers'],
        message: `The total hover-content count must not exceed ${TOOL_LIMITS.hover.contentsPerRequestMax}.`,
      });
    }
  });

export const DefinitionLocationSchema = z
  .object({
    uri: FileUriSchema,
    targetRange: RangeSchema,
    targetSelectionRange: RangeSchema,
    originSelectionRange: RangeSchema.nullable(),
  })
  .strict();

export const GetDefinitionResultSchema = z
  .object({
    document: DocumentSnapshotSchema,
    kind: DefinitionKindSchema,
    locations: z.array(DefinitionLocationSchema).max(TOOL_LIMITS.definition.itemsMax),
  })
  .strict();

export const ReferenceContextSchema = z
  .object({
    range: RangeSchema,
    text: utf8TextSchema(TOOL_LIMITS.references.contextSnippetBytes),
    highlightRange: RangeSchema,
    documentVersion: DocumentVersionSchema,
    isDirty: z.boolean(),
  })
  .strict();

export const FindReferencesResultSchema = z
  .object({
    document: DocumentSnapshotSchema,
    references: z
      .array(
        z
          .object({
            uri: FileUriSchema,
            range: RangeSchema,
            context: ReferenceContextSchema.nullable(),
          })
          .strict(),
      )
      .max(TOOL_LIMITS.references.itemsMax),
  })
  .strict();

export const DocumentSymbolSchema = z
  .object({
    id: z.string().min(1).max(SCHEMA_LIMITS.symbolIdCharacters),
    parentId: z.string().min(1).max(SCHEMA_LIMITS.symbolIdCharacters).nullable(),
    name: z.string().min(1).max(SCHEMA_LIMITS.displayNameCharacters),
    detail: z.string().max(SCHEMA_LIMITS.detailTextCharacters).nullable(),
    kind: z.string().min(1).max(SCHEMA_LIMITS.symbolKindCharacters),
    range: RangeSchema,
    selectionRange: RangeSchema,
    deprecated: z.boolean(),
    containerName: z.string().max(SCHEMA_LIMITS.displayNameCharacters).nullable(),
  })
  .strict();

export const GetDocumentSymbolsResultSchema = z
  .object({
    document: DocumentSnapshotSchema,
    providerShape: z.enum(['hierarchical', 'flat']),
    symbols: z.array(DocumentSymbolSchema).max(TOOL_LIMITS.documentSymbols.itemsMax),
  })
  .strict()
  .superRefine((value, context) => {
    const seenIds = new Set<string>();
    for (const [index, symbol] of value.symbols.entries()) {
      if (seenIds.has(symbol.id)) {
        context.addIssue({
          code: 'custom',
          path: ['symbols', index, 'id'],
          message: 'Document symbol IDs must be unique.',
        });
      }
      if (symbol.parentId !== null && !seenIds.has(symbol.parentId)) {
        context.addIssue({
          code: 'custom',
          path: ['symbols', index, 'parentId'],
          message: 'A parentId must refer to an earlier symbol in preorder.',
        });
      }
      seenIds.add(symbol.id);
    }
  });

export const SearchWorkspaceSymbolsResultSchema = z
  .object({
    query: WorkspaceSymbolQuerySchema,
    symbols: z
      .array(
        z
          .object({
            name: z.string().min(1).max(SCHEMA_LIMITS.displayNameCharacters),
            kind: z.string().min(1).max(SCHEMA_LIMITS.symbolKindCharacters),
            containerName: z
              .string()
              .max(SCHEMA_LIMITS.displayNameCharacters)
              .nullable(),
            uri: FileUriSchema,
            range: RangeSchema,
          })
          .strict(),
      )
      .max(TOOL_LIMITS.workspaceSymbols.itemsMax),
  })
  .strict();

export const ParameterLabelRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => start <= end, 'Parameter label range must be ordered.');

export const SignatureParameterSchema = z
  .object({
    label: z.string().max(SCHEMA_LIMITS.detailTextCharacters).nullable(),
    labelRange: ParameterLabelRangeSchema.nullable(),
    documentation: MarkupContentSchema.nullable(),
  })
  .strict();

export const SignatureInformationSchema = z
  .object({
    label: z.string().max(TOOL_LIMITS.signatureHelp.combinedTextBytes),
    documentation: MarkupContentSchema.nullable(),
    parameters: z
      .array(SignatureParameterSchema)
      .max(TOOL_LIMITS.signatureHelp.parametersPerSignatureMax),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, parameter] of value.parameters.entries()) {
      if (
        parameter.labelRange !== null &&
        parameter.labelRange[1] > value.label.length
      ) {
        context.addIssue({
          code: 'custom',
          path: ['parameters', index, 'labelRange'],
          message: 'Parameter label range must be within the signature label.',
        });
      }
    }
  });

export const GetSignatureHelpResultSchema = z
  .object({
    document: DocumentSnapshotSchema,
    activeSignature: z.number().int().nonnegative().nullable(),
    activeParameter: z.number().int().nonnegative().nullable(),
    signatures: z
      .array(SignatureInformationSchema)
      .max(TOOL_LIMITS.signatureHelp.signaturesMax),
  })
  .strict()
  .superRefine((value, context) => {
    let contentBytes = 0;
    for (const signature of value.signatures) {
      contentBytes += Buffer.byteLength(signature.label, 'utf8');
      if (signature.documentation !== null) {
        contentBytes += Buffer.byteLength(signature.documentation.value, 'utf8');
      }
      for (const parameter of signature.parameters) {
        if (parameter.label !== null) {
          contentBytes += Buffer.byteLength(parameter.label, 'utf8');
        }
        if (parameter.documentation !== null) {
          contentBytes += Buffer.byteLength(parameter.documentation.value, 'utf8');
        }
      }
    }

    if (contentBytes > TOOL_LIMITS.signatureHelp.combinedTextBytes) {
      context.addIssue({
        code: 'custom',
        path: ['signatures'],
        message: `Combined signature content must not exceed ${TOOL_LIMITS.signatureHelp.combinedTextBytes} UTF-8 bytes.`,
      });
    }

    if (
      value.activeSignature !== null &&
      value.activeSignature >= value.signatures.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activeSignature'],
        message: 'activeSignature must identify a returned signature.',
      });
      return;
    }

    if (value.activeParameter !== null && value.activeSignature !== null) {
      const activeSignature = value.signatures[value.activeSignature];
      if (
        activeSignature !== undefined &&
        value.activeParameter >= activeSignature.parameters.length
      ) {
        context.addIssue({
          code: 'custom',
          path: ['activeParameter'],
          message: 'activeParameter must identify a parameter of the active signature.',
        });
      }
    }
  });

export const CallItemSchema = z
  .object({
    name: z.string().min(1).max(SCHEMA_LIMITS.displayNameCharacters),
    detail: z.string().max(SCHEMA_LIMITS.detailTextCharacters).nullable(),
    kind: z.string().min(1).max(SCHEMA_LIMITS.symbolKindCharacters),
    uri: FileUriSchema,
    range: RangeSchema,
    selectionRange: RangeSchema,
  })
  .strict();

export const GetCallHierarchyResultSchema = z
  .object({
    document: DocumentSnapshotSchema,
    roots: z.array(CallItemSchema).max(TOOL_LIMITS.callHierarchy.rootsMax),
    selectedRootIndex: z.number().int().nonnegative(),
    incoming: z
      .array(
        z
          .object({
            from: CallItemSchema,
            callSiteRanges: z
              .array(RangeSchema)
              .max(TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax),
          })
          .strict(),
      )
      .max(TOOL_LIMITS.callHierarchy.itemsPerDirectionMax)
      .nullable(),
    outgoing: z
      .array(
        z
          .object({
            to: CallItemSchema,
            callSiteRanges: z
              .array(RangeSchema)
              .max(TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax),
          })
          .strict(),
      )
      .max(TOOL_LIMITS.callHierarchy.itemsPerDirectionMax)
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [direction, calls] of [
      ['incoming', value.incoming],
      ['outgoing', value.outgoing],
    ] as const) {
      let rangeCount = 0;
      for (const call of calls ?? []) {
        rangeCount += call.callSiteRanges.length;
      }
      if (rangeCount > TOOL_LIMITS.callHierarchy.callSiteRangesPerDirectionMax) {
        context.addIssue({
          code: 'custom',
          path: [direction],
          message: `The total ${direction} call-site range count must not exceed ${TOOL_LIMITS.callHierarchy.callSiteRangesPerDirectionMax}.`,
        });
      }
    }
    if (
      (value.roots.length === 0 && value.selectedRootIndex !== 0) ||
      (value.roots.length > 0 && value.selectedRootIndex >= value.roots.length)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['selectedRootIndex'],
        message: 'selectedRootIndex must identify a returned root.',
      });
    }
  });

export const ListInstancesSuccessSchema = createSuccessSchema(
  ListInstancesResultSchema,
);
export const GetEditorContextSuccessSchema = createSuccessSchema(
  GetEditorContextResultSchema,
);
export const ReadDocumentSuccessSchema = createSuccessSchema(ReadDocumentResultSchema);
export const GetDiagnosticsSuccessSchema = createSuccessSchema(
  GetDiagnosticsResultSchema,
);
export const GetHoverSuccessSchema = createSuccessSchema(GetHoverResultSchema);
export const GetDefinitionSuccessSchema = createSuccessSchema(
  GetDefinitionResultSchema,
);
export const FindReferencesSuccessSchema = createSuccessSchema(
  FindReferencesResultSchema,
);
export const GetDocumentSymbolsSuccessSchema = createSuccessSchema(
  GetDocumentSymbolsResultSchema,
);
export const SearchWorkspaceSymbolsSuccessSchema = createSuccessSchema(
  SearchWorkspaceSymbolsResultSchema,
);
export const GetSignatureHelpSuccessSchema = createSuccessSchema(
  GetSignatureHelpResultSchema,
);
export const GetCallHierarchySuccessSchema = createSuccessSchema(
  GetCallHierarchyResultSchema,
);

export const ExtensionToolInvocationSchema = z.discriminatedUnion('tool', [
  z
    .object({
      tool: z.literal('get_editor_context'),
      arguments: GetEditorContextArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('read_document'),
      arguments: ReadDocumentArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('get_diagnostics'),
      arguments: GetDiagnosticsArgumentsSchema,
    })
    .strict(),
  z
    .object({ tool: z.literal('get_hover'), arguments: GetHoverArgumentsSchema })
    .strict(),
  z
    .object({
      tool: z.literal('get_definition'),
      arguments: GetDefinitionArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('find_references'),
      arguments: FindReferencesArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('get_document_symbols'),
      arguments: GetDocumentSymbolsArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('search_workspace_symbols'),
      arguments: SearchWorkspaceSymbolsArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('get_signature_help'),
      arguments: GetSignatureHelpArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('get_call_hierarchy'),
      arguments: GetCallHierarchyArgumentsSchema,
    })
    .strict(),
]);

export const ExtensionToolResultPayloadSchema = z.discriminatedUnion('tool', [
  z
    .object({
      tool: z.literal('get_editor_context'),
      result: GetEditorContextResultSchema,
    })
    .strict(),
  z
    .object({ tool: z.literal('read_document'), result: ReadDocumentResultSchema })
    .strict(),
  z
    .object({ tool: z.literal('get_diagnostics'), result: GetDiagnosticsResultSchema })
    .strict(),
  z.object({ tool: z.literal('get_hover'), result: GetHoverResultSchema }).strict(),
  z
    .object({ tool: z.literal('get_definition'), result: GetDefinitionResultSchema })
    .strict(),
  z
    .object({ tool: z.literal('find_references'), result: FindReferencesResultSchema })
    .strict(),
  z
    .object({
      tool: z.literal('get_document_symbols'),
      result: GetDocumentSymbolsResultSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('search_workspace_symbols'),
      result: SearchWorkspaceSymbolsResultSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('get_signature_help'),
      result: GetSignatureHelpResultSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('get_call_hierarchy'),
      result: GetCallHierarchyResultSchema,
    })
    .strict(),
]);

export type AllToolName = z.infer<typeof AllToolNameSchema>;
export type ExtensionToolName = z.infer<typeof ExtensionToolNameSchema>;
export type Warning = z.infer<typeof WarningSchema>;

export type ListInstancesInput = z.infer<typeof ListInstancesInputSchema>;
export type ListInstancesResult = z.infer<typeof ListInstancesResultSchema>;
export type GetEditorContextArguments = z.infer<typeof GetEditorContextArgumentsSchema>;
export type GetEditorContextInput = z.infer<typeof GetEditorContextInputSchema>;
export type GetEditorContextResult = z.infer<typeof GetEditorContextResultSchema>;
export type ReadDocumentArguments = z.infer<typeof ReadDocumentArgumentsSchema>;
export type ReadDocumentInput = z.infer<typeof ReadDocumentInputSchema>;
export type ReadDocumentResult = z.infer<typeof ReadDocumentResultSchema>;
export type GetDiagnosticsArguments = z.infer<typeof GetDiagnosticsArgumentsSchema>;
export type GetDiagnosticsInput = z.infer<typeof GetDiagnosticsInputSchema>;
export type GetDiagnosticsResult = z.infer<typeof GetDiagnosticsResultSchema>;
export type GetHoverArguments = z.infer<typeof GetHoverArgumentsSchema>;
export type GetHoverInput = z.infer<typeof GetHoverInputSchema>;
export type GetHoverResult = z.infer<typeof GetHoverResultSchema>;
export type GetDefinitionArguments = z.infer<typeof GetDefinitionArgumentsSchema>;
export type GetDefinitionInput = z.infer<typeof GetDefinitionInputSchema>;
export type GetDefinitionResult = z.infer<typeof GetDefinitionResultSchema>;
export type FindReferencesArguments = z.infer<typeof FindReferencesArgumentsSchema>;
export type FindReferencesInput = z.infer<typeof FindReferencesInputSchema>;
export type FindReferencesResult = z.infer<typeof FindReferencesResultSchema>;
export type GetDocumentSymbolsArguments = z.infer<
  typeof GetDocumentSymbolsArgumentsSchema
>;
export type GetDocumentSymbolsInput = z.infer<typeof GetDocumentSymbolsInputSchema>;
export type GetDocumentSymbolsResult = z.infer<typeof GetDocumentSymbolsResultSchema>;
export type SearchWorkspaceSymbolsArguments = z.infer<
  typeof SearchWorkspaceSymbolsArgumentsSchema
>;
export type SearchWorkspaceSymbolsInput = z.infer<
  typeof SearchWorkspaceSymbolsInputSchema
>;
export type SearchWorkspaceSymbolsResult = z.infer<
  typeof SearchWorkspaceSymbolsResultSchema
>;
export type GetSignatureHelpArguments = z.infer<typeof GetSignatureHelpArgumentsSchema>;
export type GetSignatureHelpInput = z.infer<typeof GetSignatureHelpInputSchema>;
export type GetSignatureHelpResult = z.infer<typeof GetSignatureHelpResultSchema>;
export type GetCallHierarchyArguments = z.infer<typeof GetCallHierarchyArgumentsSchema>;
export type GetCallHierarchyInput = z.infer<typeof GetCallHierarchyInputSchema>;
export type GetCallHierarchyResult = z.infer<typeof GetCallHierarchyResultSchema>;
export type ExtensionToolInvocation = z.infer<typeof ExtensionToolInvocationSchema>;
export type ExtensionToolResultPayload = z.infer<
  typeof ExtensionToolResultPayloadSchema
>;
