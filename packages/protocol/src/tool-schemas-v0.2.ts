import { Buffer } from 'node:buffer';

import * as z from 'zod/v4';

import {
  SCHEMA_LIMITS,
  TOOL_LIMITS,
  V02_READ_TOOL_LIMITS,
  V02_TOOL_CONTRACT_VERSION,
} from './constants.js';
import {
  DocumentRefSchema,
  ErrorCodeSchema,
  InstanceIdSchema,
  RangeSchema,
  SafeErrorDetailsSchema,
  UtcTimestampSchema,
  WorkspaceFolderIdSchema,
  WorkspaceRelativePathSchema,
  type Position,
} from './schemas.js';

const DocumentVersionSchema = z.number().int().nonnegative();
const SafeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function utf8TextSchema(maximumBytes: number) {
  return z
    .string()
    .max(maximumBytes)
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );
}

function limitSchema(maximum: number) {
  return z.number().int().positive().max(maximum);
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

function comparePositions(left: Position, right: Position) {
  return left.line - right.line || left.character - right.character;
}

function compareRanges(
  left: z.infer<typeof RangeSchema>,
  right: z.infer<typeof RangeSchema>,
) {
  return (
    comparePositions(left.start, right.start) || comparePositions(left.end, right.end)
  );
}

function validateOrderedUniqueStrings(
  values: readonly string[],
  context: z.core.$RefinementCtx,
): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareCodePoints(previous, current) >= 0
    ) {
      context.addIssue({
        code: 'custom',
        path: [index],
        message: 'Values must be unique and use Unicode code-point ordinal order.',
      });
      return;
    }
  }
}

const GlobSchema = utf8TextSchema(V02_READ_TOOL_LIMITS.globBytes)
  .min(1)
  .refine((value) => value === value.trim(), 'Glob must already be trimmed.')
  .refine((value) => !value.startsWith('/'), 'Glob must be relative.')
  .refine((value) => !/^[A-Za-z]:/.test(value), 'Glob cannot use a drive prefix.')
  .refine((value) => !value.includes('\\'), 'Glob must use forward slashes.')
  .refine((value) => !value.includes('\0'), 'Glob cannot contain NUL.')
  .refine(
    (value) => !value.split('/').includes('..'),
    'Glob cannot traverse outside the workspace.',
  );

const CursorSchema = z
  .string()
  .min(3)
  .max(V02_READ_TOOL_LIMITS.cursorCharacters)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

const InstanceSelectorShape = { instanceId: InstanceIdSchema.optional() };
const WorkspaceSelectorShape = { workspaceFolderId: WorkspaceFolderIdSchema };
const DiscoveryPolicyShape = {
  include: GlobSchema.optional(),
  exclude: GlobSchema.nullable().optional(),
};

export const V02_READ_TOOL_NAMES = [
  'list_workspace_files',
  'read_documents',
  'search_workspace_text',
] as const;

export const V02ReadToolNameSchema = z.enum(V02_READ_TOOL_NAMES);

export const V02WarningCodeSchema = z.enum([
  'RESULTS_TRUNCATED',
  'CONTENT_TRUNCATED',
  'EXTERNAL_LOCATIONS_OMITTED',
  'UNSUPPORTED_ITEMS_OMITTED',
  'PROVIDER_RETURNED_NO_RESULT',
  'RESOURCE_LIMIT_REACHED',
  'FILES_CHANGED_DURING_REQUEST',
]);

export const V02WarningSchema = z
  .object({
    code: V02WarningCodeSchema,
    message: z.string().min(1).max(SCHEMA_LIMITS.errorMessageCharacters),
    omittedCount: SafeCountSchema.optional(),
  })
  .strict();

export const V02WarningsSchema = z
  .array(V02WarningSchema)
  .max(V02_READ_TOOL_LIMITS.warnings)
  .superRefine((warnings, context) => {
    let previousIndex = -1;
    for (const [index, warning] of warnings.entries()) {
      const warningIndex = V02WarningCodeSchema.options.indexOf(warning.code);
      if (warningIndex <= previousIndex) {
        context.addIssue({
          code: 'custom',
          path: [index, 'code'],
          message: 'Warnings must be unique and use canonical warning-code order.',
        });
      }
      previousIndex = warningIndex;
    }
  });

export const V02ErrorCodeSchema = z.union([
  ErrorCodeSchema,
  z.enum(['INVALID_CURSOR', 'BATCH_BUDGET_EXHAUSTED']),
]);

export const V02ToolExecutionErrorSchema = z
  .object({
    code: V02ErrorCodeSchema,
    message: z.string().min(1).max(SCHEMA_LIMITS.errorMessageCharacters),
    retryable: z.boolean(),
    details: SafeErrorDetailsSchema.optional(),
  })
  .strict();

export const V02FailureSchema = z
  .object({
    contractVersion: z.literal(V02_TOOL_CONTRACT_VERSION),
    error: V02ToolExecutionErrorSchema,
  })
  .strict();

export const V02WorkspaceDocumentSchema = z
  .object({
    workspaceFolderId: WorkspaceFolderIdSchema,
    relativePath: WorkspaceRelativePathSchema,
  })
  .strict();

export const V02CompactDocumentSnapshotSchema = V02WorkspaceDocumentSchema.extend({
  languageId: z.string().min(1).max(SCHEMA_LIMITS.languageIdCharacters),
  documentVersion: DocumentVersionSchema,
  isDirty: z.boolean(),
}).strict();

export function createV02SuccessSchema<ResultSchema extends z.ZodType>(
  resultSchema: ResultSchema,
) {
  return z
    .object({
      contractVersion: z.literal(V02_TOOL_CONTRACT_VERSION),
      instanceId: InstanceIdSchema,
      observedAt: UtcTimestampSchema,
      truncated: z.boolean(),
      warnings: V02WarningsSchema,
      result: resultSchema,
    })
    .strict()
    .refine(
      (value) =>
        Buffer.byteLength(JSON.stringify(value), 'utf8') <=
        V02_READ_TOOL_LIMITS.serializedResultBytes,
      `Serialized success must not exceed ${V02_READ_TOOL_LIMITS.serializedResultBytes} UTF-8 bytes.`,
    );
}

export const V02ListWorkspaceFilesArgumentsSchema = z
  .object({
    ...WorkspaceSelectorShape,
    ...DiscoveryPolicyShape,
    limit: limitSchema(V02_READ_TOOL_LIMITS.listWorkspaceFiles.itemsMax).optional(),
    cursor: CursorSchema.optional(),
  })
  .strict();

export const V02ListWorkspaceFilesInputSchema =
  V02ListWorkspaceFilesArgumentsSchema.extend(InstanceSelectorShape).strict();

export const V02ReadDocumentsItemSchema = z
  .object({
    document: DocumentRefSchema,
    expectedDocumentVersion: DocumentVersionSchema.optional(),
    startLine: z.number().int().nonnegative().optional(),
    lineCount: limitSchema(TOOL_LIMITS.readDocument.lineCountMax).optional(),
  })
  .strict();

export const V02ReadDocumentsArgumentsSchema = z
  .object({
    ...WorkspaceSelectorShape,
    documents: z
      .array(V02ReadDocumentsItemSchema)
      .min(1)
      .max(V02_READ_TOOL_LIMITS.readDocuments.itemsMax),
    contentByteLimit: limitSchema(
      V02_READ_TOOL_LIMITS.readDocuments.contentBytesMax,
    ).optional(),
  })
  .strict();

export const V02ReadDocumentsInputSchema =
  V02ReadDocumentsArgumentsSchema.extend(InstanceSelectorShape).strict();

const SearchQuerySchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'Query must already be trimmed.')
  .refine((value) => !value.includes('\0'), 'Query cannot contain NUL.')
  .refine(
    (value) =>
      Array.from(value).length <=
      V02_READ_TOOL_LIMITS.searchWorkspaceText.queryScalarsMax,
    `Query must not exceed ${V02_READ_TOOL_LIMITS.searchWorkspaceText.queryScalarsMax} Unicode scalar values.`,
  );

export const V02SearchWorkspaceTextArgumentsSchema = z
  .object({
    ...WorkspaceSelectorShape,
    query: SearchQuerySchema,
    caseSensitive: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    ...DiscoveryPolicyShape,
    contextLines: z
      .number()
      .int()
      .nonnegative()
      .max(V02_READ_TOOL_LIMITS.searchWorkspaceText.contextLinesMax)
      .optional(),
    limit: limitSchema(V02_READ_TOOL_LIMITS.searchWorkspaceText.matchesMax).optional(),
    cursor: CursorSchema.optional(),
  })
  .strict();

export const V02SearchWorkspaceTextInputSchema =
  V02SearchWorkspaceTextArgumentsSchema.extend(InstanceSelectorShape).strict();

function pageRefinement(
  value: { readonly hasMore: boolean; readonly nextCursor: string | null },
  context: z.core.$RefinementCtx,
): void {
  if (value.hasMore !== (value.nextCursor !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['nextCursor'],
      message: 'nextCursor must be present exactly when hasMore is true.',
    });
  }
}

export const V02ListWorkspaceFilesResultSchema = z
  .object({
    workspaceFolderId: WorkspaceFolderIdSchema,
    files: z
      .array(WorkspaceRelativePathSchema)
      .max(V02_READ_TOOL_LIMITS.listWorkspaceFiles.itemsMax)
      .superRefine(validateOrderedUniqueStrings),
    hasMore: z.boolean(),
    nextCursor: CursorSchema.nullable(),
  })
  .strict()
  .superRefine(pageRefinement);

export const V02ReadDocumentsItemSuccessSchema = z
  .object({
    outcome: z.literal('success'),
    document: V02CompactDocumentSnapshotSchema,
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

export const V02ReadDocumentsItemErrorSchema = z
  .object({
    outcome: z.literal('error'),
    error: z
      .object({
        code: V02ErrorCodeSchema,
        message: z
          .string()
          .min(1)
          .max(V02_READ_TOOL_LIMITS.readDocuments.itemErrorMessageCharacters),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const V02ReadDocumentsItemResultSchema = z.discriminatedUnion('outcome', [
  V02ReadDocumentsItemSuccessSchema,
  V02ReadDocumentsItemErrorSchema,
]);

export const V02ReadDocumentsResultSchema = z
  .object({
    workspaceFolderId: WorkspaceFolderIdSchema,
    items: z
      .array(V02ReadDocumentsItemResultSchema)
      .min(1)
      .max(V02_READ_TOOL_LIMITS.readDocuments.itemsMax),
  })
  .strict()
  .superRefine((value, context) => {
    const contentBytes = value.items.reduce(
      (total, item) =>
        total + (item.outcome === 'success' ? Buffer.byteLength(item.text, 'utf8') : 0),
      0,
    );
    if (contentBytes > V02_READ_TOOL_LIMITS.readDocuments.contentBytesMax) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: `Combined document text must not exceed ${V02_READ_TOOL_LIMITS.readDocuments.contentBytesMax} UTF-8 bytes.`,
      });
    }
  });

export const V02SearchDocumentStateSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('live'),
      documentVersion: DocumentVersionSchema,
      isDirty: z.boolean(),
    })
    .strict(),
  z
    .object({
      source: z.literal('disk'),
      sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .max(V02_READ_TOOL_LIMITS.searchWorkspaceText.closedFileBytes),
      modifiedAt: UtcTimestampSchema,
    })
    .strict(),
]);

export const V02SearchContextSchema = z
  .object({
    range: RangeSchema,
    text: utf8TextSchema(V02_READ_TOOL_LIMITS.searchWorkspaceText.contextSnippetBytes),
    highlightRange: RangeSchema,
  })
  .strict();

export const V02SearchMatchSchema = z
  .object({
    range: RangeSchema,
    context: V02SearchContextSchema.nullable(),
  })
  .strict();

export const V02SearchDocumentResultSchema = z
  .object({
    document: V02WorkspaceDocumentSchema,
    state: V02SearchDocumentStateSchema,
    matches: z
      .array(V02SearchMatchSchema)
      .min(1)
      .max(V02_READ_TOOL_LIMITS.searchWorkspaceText.matchesMax)
      .superRefine((matches, context) => {
        for (let index = 1; index < matches.length; index += 1) {
          const previous = matches[index - 1];
          const current = matches[index];
          if (
            previous !== undefined &&
            current !== undefined &&
            compareRanges(previous.range, current.range) >= 0
          ) {
            context.addIssue({
              code: 'custom',
              path: [index, 'range'],
              message: 'Matches must be unique and sorted by range.',
            });
            return;
          }
        }
      }),
  })
  .strict();

export const V02SearchWorkspaceTextResultSchema = z
  .object({
    workspaceFolderId: WorkspaceFolderIdSchema,
    query: SearchQuerySchema,
    documents: z
      .array(V02SearchDocumentResultSchema)
      .max(V02_READ_TOOL_LIMITS.searchWorkspaceText.matchesMax),
    returnedMatchCount: z
      .number()
      .int()
      .nonnegative()
      .max(V02_READ_TOOL_LIMITS.searchWorkspaceText.matchesMax),
    hasMore: z.boolean(),
    nextCursor: CursorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    pageRefinement(value, context);
    validateOrderedUniqueStrings(
      value.documents.map((document) => document.document.relativePath),
      context,
    );
    let matches = 0;
    let contextBytes = 0;
    for (const document of value.documents) {
      matches += document.matches.length;
      for (const match of document.matches) {
        if (match.context !== null) {
          contextBytes += Buffer.byteLength(match.context.text, 'utf8');
        }
      }
    }
    if (matches !== value.returnedMatchCount) {
      context.addIssue({
        code: 'custom',
        path: ['returnedMatchCount'],
        message: 'returnedMatchCount must equal the number of returned matches.',
      });
    }
    if (matches > V02_READ_TOOL_LIMITS.searchWorkspaceText.matchesMax) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: `Returned matches must not exceed ${V02_READ_TOOL_LIMITS.searchWorkspaceText.matchesMax}.`,
      });
    }
    if (contextBytes > V02_READ_TOOL_LIMITS.searchWorkspaceText.aggregateContextBytes) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: `Combined context must not exceed ${V02_READ_TOOL_LIMITS.searchWorkspaceText.aggregateContextBytes} UTF-8 bytes.`,
      });
    }
  });

export const V02ListWorkspaceFilesSuccessSchema = createV02SuccessSchema(
  V02ListWorkspaceFilesResultSchema,
);
export const V02ReadDocumentsSuccessSchema = createV02SuccessSchema(
  V02ReadDocumentsResultSchema,
).superRefine((value, context) => {
  const budgetExhausted = value.result.items.some(
    (item) => item.outcome === 'error' && item.error.code === 'BATCH_BUDGET_EXHAUSTED',
  );
  const hasResourceWarning = value.warnings.some(
    (warning) => warning.code === 'RESOURCE_LIMIT_REACHED',
  );
  if (budgetExhausted && (!value.truncated || !hasResourceWarning)) {
    context.addIssue({
      code: 'custom',
      path: ['truncated'],
      message:
        'Batch budget exhaustion requires truncation and RESOURCE_LIMIT_REACHED.',
    });
  }
});
export const V02SearchWorkspaceTextSuccessSchema = createV02SuccessSchema(
  V02SearchWorkspaceTextResultSchema,
);

export const V02ReadToolInvocationSchema = z.discriminatedUnion('tool', [
  z
    .object({
      tool: z.literal('list_workspace_files'),
      arguments: V02ListWorkspaceFilesArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('read_documents'),
      arguments: V02ReadDocumentsArgumentsSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('search_workspace_text'),
      arguments: V02SearchWorkspaceTextArgumentsSchema,
    })
    .strict(),
]);

export const V02ReadToolResultPayloadSchema = z.discriminatedUnion('tool', [
  z
    .object({
      tool: z.literal('list_workspace_files'),
      result: V02ListWorkspaceFilesResultSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('read_documents'),
      result: V02ReadDocumentsResultSchema,
    })
    .strict(),
  z
    .object({
      tool: z.literal('search_workspace_text'),
      result: V02SearchWorkspaceTextResultSchema,
    })
    .strict(),
]);

export type V02ReadToolName = z.infer<typeof V02ReadToolNameSchema>;
export type V02WarningCode = z.infer<typeof V02WarningCodeSchema>;
export type V02ListWorkspaceFilesInput = z.infer<
  typeof V02ListWorkspaceFilesInputSchema
>;
export type V02ReadDocumentsInput = z.infer<typeof V02ReadDocumentsInputSchema>;
export type V02SearchWorkspaceTextInput = z.infer<
  typeof V02SearchWorkspaceTextInputSchema
>;
export type V02ListWorkspaceFilesResult = z.infer<
  typeof V02ListWorkspaceFilesResultSchema
>;
export type V02ListWorkspaceFilesSuccess = z.infer<
  typeof V02ListWorkspaceFilesSuccessSchema
>;
export type V02ReadDocumentsResult = z.infer<typeof V02ReadDocumentsResultSchema>;
export type V02ReadDocumentsSuccess = z.infer<typeof V02ReadDocumentsSuccessSchema>;
export type V02SearchWorkspaceTextResult = z.infer<
  typeof V02SearchWorkspaceTextResultSchema
>;
export type V02SearchWorkspaceTextSuccess = z.infer<
  typeof V02SearchWorkspaceTextSuccessSchema
>;
export type V02ReadToolInvocation = z.infer<typeof V02ReadToolInvocationSchema>;
export type V02ReadToolResultPayload = z.infer<typeof V02ReadToolResultPayloadSchema>;
export type V02ToolExecutionError = z.infer<typeof V02ToolExecutionErrorSchema>;
export type V02Failure = z.infer<typeof V02FailureSchema>;
