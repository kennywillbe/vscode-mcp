import { Buffer } from 'node:buffer';

import * as z from 'zod/v4';

import {
  SCHEMA_LIMITS,
  TOOL_CONTRACT_VERSION,
  V1_IDE_TOOL_LIMITS,
} from './constants.js';
import {
  DocumentRefSchema,
  InstanceIdSchema,
  PositionSchema,
  RangeSchema,
  UtcTimestampSchema,
  WorkspaceFolderIdSchema,
  WorkspaceRelativePathSchema,
} from './schemas.js';
import { EXTENSION_TOOL_NAMES, ExtensionToolInvocationSchema } from './tool-schemas.js';
import {
  V02ReadToolInvocationSchema,
  V02_READ_TOOL_NAMES,
} from './tool-schemas-v0.2.js';

const VersionSchema = z.number().int().nonnegative();
const LimitSchema = z.number().int().positive().max(V1_IDE_TOOL_LIMITS.providerItems);
const InstanceShape = { instanceId: InstanceIdSchema.optional() };
const DocumentShape = {
  document: DocumentRefSchema,
  expectedDocumentVersion: VersionSchema.optional(),
};
const PositionedDocumentShape = { ...DocumentShape, position: PositionSchema };
const WorkspacePathSchema = z
  .object({
    workspaceFolderId: WorkspaceFolderIdSchema,
    relativePath: WorkspaceRelativePathSchema,
  })
  .strict();

function utf8String(maximumBytes: number) {
  return z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= maximumBytes,
      `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
    );
}

export const V1_ADDITIONAL_TOOL_NAMES = [
  'get_capability_status',
  'get_completions',
  'get_code_actions',
  'get_document_highlights',
  'get_type_hierarchy',
  'get_inlay_hints',
  'get_folding_ranges',
  'get_selection_ranges',
  'get_document_links',
  'apply_text_edits',
  'create_workspace_file',
  'move_workspace_file',
  'delete_workspace_file',
  'save_documents',
  'revert_documents',
  'rename_symbol',
  'format_document',
  'apply_code_action',
  'list_tasks',
  'run_task',
  'get_task_execution',
  'terminate_task',
  'get_debug_state',
  'start_debugging',
  'stop_debugging',
] as const;

export const V1AdditionalToolNameSchema = z.enum(V1_ADDITIONAL_TOOL_NAMES);
export const V1_ALL_EXTENSION_TOOL_NAMES = [
  ...EXTENSION_TOOL_NAMES,
  ...V02_READ_TOOL_NAMES,
  ...V1_ADDITIONAL_TOOL_NAMES,
] as const;
export const V1AllExtensionToolNameSchema = z.enum(V1_ALL_EXTENSION_TOOL_NAMES);

const StatusArgumentsSchema = z.object({}).strict();
const CompletionArgumentsSchema = z
  .object({ ...PositionedDocumentShape, limit: LimitSchema.optional() })
  .strict();
const CodeActionArgumentsSchema = z
  .object({
    ...DocumentShape,
    range: RangeSchema,
    kinds: z.array(z.string().min(1).max(256)).max(32).optional(),
    limit: z.number().int().positive().max(V1_IDE_TOOL_LIMITS.codeActions).optional(),
  })
  .strict();
const HighlightArgumentsSchema = z.object(PositionedDocumentShape).strict();
const TypeHierarchyArgumentsSchema = z
  .object({
    ...PositionedDocumentShape,
    direction: z.enum(['supertypes', 'subtypes', 'both']).optional(),
    limit: LimitSchema.optional(),
  })
  .strict();
const RangeDocumentArgumentsSchema = z
  .object({ ...DocumentShape, range: RangeSchema, limit: LimitSchema.optional() })
  .strict();
const DocumentArgumentsSchema = z
  .object({ ...DocumentShape, limit: LimitSchema.optional() })
  .strict();
const SelectionArgumentsSchema = z
  .object({
    ...DocumentShape,
    positions: z.array(PositionSchema).min(1).max(128),
  })
  .strict();
const TextEditSchema = z
  .object({
    range: RangeSchema,
    newText: utf8String(V1_IDE_TOOL_LIMITS.replacementBytesPerEdit),
  })
  .strict();
const DocumentEditSchema = z
  .object({
    document: DocumentRefSchema,
    expectedDocumentVersion: VersionSchema,
    edits: z.array(TextEditSchema).min(1).max(V1_IDE_TOOL_LIMITS.editsPerDocument),
  })
  .strict();
const ApplyTextEditsArgumentsSchema = z
  .object({
    documents: z
      .array(DocumentEditSchema)
      .min(1)
      .max(V1_IDE_TOOL_LIMITS.documentsPerWrite),
  })
  .strict()
  .superRefine((value, context) => {
    let count = 0;
    let bytes = 0;
    for (const document of value.documents) {
      count += document.edits.length;
      for (const edit of document.edits) {
        bytes += Buffer.byteLength(edit.newText, 'utf8');
      }
    }
    if (count > V1_IDE_TOOL_LIMITS.editsTotal) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: 'Too many edits.',
      });
    }
    if (bytes > V1_IDE_TOOL_LIMITS.replacementBytesTotal) {
      context.addIssue({
        code: 'custom',
        path: ['documents'],
        message: 'Aggregate replacement text is too large.',
      });
    }
  });
const CreateArgumentsSchema = z
  .object({
    destination: WorkspacePathSchema,
    content: utf8String(V1_IDE_TOOL_LIMITS.createdFileBytes),
  })
  .strict();
const MoveArgumentsSchema = z
  .object({ source: DocumentRefSchema, destination: WorkspacePathSchema })
  .strict();
const DeleteArgumentsSchema = z.object({ document: DocumentRefSchema }).strict();
const VersionedDocumentsArgumentsSchema = z
  .object({
    documents: z
      .array(
        z
          .object({
            document: DocumentRefSchema,
            expectedDocumentVersion: VersionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(V1_IDE_TOOL_LIMITS.documentsPerWrite),
  })
  .strict();
const RenameArgumentsSchema = z
  .object({
    ...PositionedDocumentShape,
    expectedDocumentVersion: VersionSchema,
    newName: z.string().min(1).max(1_024),
  })
  .strict();
const FormatArgumentsSchema = z
  .object({
    ...DocumentShape,
    expectedDocumentVersion: VersionSchema,
    range: RangeSchema.optional(),
    options: z
      .object({
        tabSize: z.number().int().positive().max(32),
        insertSpaces: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
const ApplyCodeActionArgumentsSchema = z
  .object({ previewToken: z.string().min(32).max(512) })
  .strict();
const ListTasksArgumentsSchema = z.object({}).strict();
const RunTaskArgumentsSchema = z
  .object({ taskId: z.string().min(16).max(512) })
  .strict();
const ExecutionArgumentsSchema = z
  .object({ executionId: z.string().min(16).max(512) })
  .strict();
const DebugStateArgumentsSchema = z.object({}).strict();
const StartDebugArgumentsSchema = z
  .object({
    workspaceFolderId: WorkspaceFolderIdSchema,
    configurationName: z.string().min(1).max(256),
    noDebug: z.boolean().optional(),
  })
  .strict();
const StopDebugArgumentsSchema = z
  .object({ debugSessionId: z.string().min(16).max(512) })
  .strict();

const ARGUMENT_SCHEMAS = {
  get_capability_status: StatusArgumentsSchema,
  get_completions: CompletionArgumentsSchema,
  get_code_actions: CodeActionArgumentsSchema,
  get_document_highlights: HighlightArgumentsSchema,
  get_type_hierarchy: TypeHierarchyArgumentsSchema,
  get_inlay_hints: RangeDocumentArgumentsSchema,
  get_folding_ranges: DocumentArgumentsSchema,
  get_selection_ranges: SelectionArgumentsSchema,
  get_document_links: DocumentArgumentsSchema,
  apply_text_edits: ApplyTextEditsArgumentsSchema,
  create_workspace_file: CreateArgumentsSchema,
  move_workspace_file: MoveArgumentsSchema,
  delete_workspace_file: DeleteArgumentsSchema,
  save_documents: VersionedDocumentsArgumentsSchema,
  revert_documents: VersionedDocumentsArgumentsSchema,
  rename_symbol: RenameArgumentsSchema,
  format_document: FormatArgumentsSchema,
  apply_code_action: ApplyCodeActionArgumentsSchema,
  list_tasks: ListTasksArgumentsSchema,
  run_task: RunTaskArgumentsSchema,
  get_task_execution: ExecutionArgumentsSchema,
  terminate_task: ExecutionArgumentsSchema,
  get_debug_state: DebugStateArgumentsSchema,
  start_debugging: StartDebugArgumentsSchema,
  stop_debugging: StopDebugArgumentsSchema,
} as const;

function invocation<Name extends V1AdditionalToolName, Schema extends z.ZodType>(
  tool: Name,
  argumentsSchema: Schema,
) {
  return z.object({ tool: z.literal(tool), arguments: argumentsSchema }).strict();
}

export const V1AdditionalToolInvocationSchema = z.discriminatedUnion('tool', [
  invocation('get_capability_status', StatusArgumentsSchema),
  invocation('get_completions', CompletionArgumentsSchema),
  invocation('get_code_actions', CodeActionArgumentsSchema),
  invocation('get_document_highlights', HighlightArgumentsSchema),
  invocation('get_type_hierarchy', TypeHierarchyArgumentsSchema),
  invocation('get_inlay_hints', RangeDocumentArgumentsSchema),
  invocation('get_folding_ranges', DocumentArgumentsSchema),
  invocation('get_selection_ranges', SelectionArgumentsSchema),
  invocation('get_document_links', DocumentArgumentsSchema),
  invocation('apply_text_edits', ApplyTextEditsArgumentsSchema),
  invocation('create_workspace_file', CreateArgumentsSchema),
  invocation('move_workspace_file', MoveArgumentsSchema),
  invocation('delete_workspace_file', DeleteArgumentsSchema),
  invocation('save_documents', VersionedDocumentsArgumentsSchema),
  invocation('revert_documents', VersionedDocumentsArgumentsSchema),
  invocation('rename_symbol', RenameArgumentsSchema),
  invocation('format_document', FormatArgumentsSchema),
  invocation('apply_code_action', ApplyCodeActionArgumentsSchema),
  invocation('list_tasks', ListTasksArgumentsSchema),
  invocation('run_task', RunTaskArgumentsSchema),
  invocation('get_task_execution', ExecutionArgumentsSchema),
  invocation('terminate_task', ExecutionArgumentsSchema),
  invocation('get_debug_state', DebugStateArgumentsSchema),
  invocation('start_debugging', StartDebugArgumentsSchema),
  invocation('stop_debugging', StopDebugArgumentsSchema),
]);

export const V1AllExtensionToolInvocationSchema = z.union([
  ExtensionToolInvocationSchema,
  V02ReadToolInvocationSchema,
  V1AdditionalToolInvocationSchema,
]);

export const V1AdditionalToolInputSchemas = Object.fromEntries(
  V1_ADDITIONAL_TOOL_NAMES.map((tool) => [
    tool,
    ARGUMENT_SCHEMAS[tool].extend(InstanceShape).strict(),
  ]),
) as unknown as { readonly [Name in V1AdditionalToolName]: z.ZodType };

export const V1BoundedResultSchema = z
  .json()
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8') <=
      V1_IDE_TOOL_LIMITS.structuredResultBytes,
    `Structured result must not exceed ${V1_IDE_TOOL_LIMITS.structuredResultBytes} UTF-8 bytes.`,
  );

export const V1AdditionalToolResultSchema = z
  .object({
    outcome: z.literal('success'),
    tool: V1AdditionalToolNameSchema,
    observedAt: UtcTimestampSchema,
    truncated: z.boolean(),
    warnings: z
      .array(
        z
          .object({
            code: z.string().min(1).max(128),
            message: z.string().min(1).max(SCHEMA_LIMITS.errorMessageCharacters),
            omittedCount: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(8),
    result: V1BoundedResultSchema,
  })
  .strict();

export function createV1AdditionalSuccessSchema() {
  return z
    .object({
      contractVersion: z.literal(TOOL_CONTRACT_VERSION),
      instanceId: InstanceIdSchema,
      observedAt: UtcTimestampSchema,
      truncated: z.boolean(),
      warnings: V1AdditionalToolResultSchema.shape.warnings,
      result: V1BoundedResultSchema,
    })
    .strict();
}

export type V1AdditionalToolName = z.infer<typeof V1AdditionalToolNameSchema>;
export type V1AllExtensionToolName = z.infer<typeof V1AllExtensionToolNameSchema>;
export type V1AllExtensionToolInvocation = z.infer<
  typeof V1AllExtensionToolInvocationSchema
>;
export type V1AdditionalToolInvocation = z.infer<
  typeof V1AdditionalToolInvocationSchema
>;
export type V1AdditionalToolResult = z.infer<typeof V1AdditionalToolResultSchema>;
