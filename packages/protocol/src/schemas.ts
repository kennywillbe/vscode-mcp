import * as z from 'zod/v4';

import {
  IPC_PROTOCOL_VERSION,
  PROTOCOL_LIMITS,
  SCHEMA_LIMITS,
  TOOL_CONTRACT_VERSION,
} from './constants.js';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const WORKSPACE_FOLDER_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
const BASE64URL_256_BIT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const AnyIpcProtocolVersionSchema = z.number().int().min(1).max(65_535);
export const CurrentIpcProtocolVersionSchema = z.literal(IPC_PROTOCOL_VERSION);
export const AnyToolContractVersionSchema = z
  .string()
  .min(1)
  .max(SCHEMA_LIMITS.clientVersionCharacters)
  .regex(SEMVER_PATTERN);
export const CurrentToolContractVersionSchema = z.literal(TOOL_CONTRACT_VERSION);
export const InstanceIdSchema = z.uuidv4();
export const RequestIdSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const WorkspaceFolderIdSchema = z
  .string()
  .min(1)
  .max(SCHEMA_LIMITS.workspaceFolderIdCharacters)
  .regex(WORKSPACE_FOLDER_ID_PATTERN);
export const WorkspaceFingerprintSchema = z.string().regex(SHA256_PATTERN);
export const AuthTokenSchema = z.string().regex(BASE64URL_256_BIT_PATTERN);
export const UtcTimestampSchema = z.iso
  .datetime()
  .refine((value) => value.endsWith('Z'), {
    message: 'Timestamp must be UTC and end in Z.',
  });
export const ProcessIdSchema = z.number().int().min(1).max(0xffff_ffff);
export const FileUriSchema = z
  .url()
  .max(SCHEMA_LIMITS.uriCharacters)
  .refine((value) => new URL(value).protocol === 'file:', {
    message: 'URI must use the file scheme.',
  });
export const CanonicalPathSchema = z
  .string()
  .min(1)
  .max(SCHEMA_LIMITS.canonicalPathCharacters)
  .refine((value) => !value.includes('\0'), 'Path cannot contain NUL.');

export const PositionSchema = z
  .object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
  })
  .strict();

export const RangeSchema = z
  .object({
    start: PositionSchema,
    end: PositionSchema,
  })
  .strict();

export const WorkspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(SCHEMA_LIMITS.relativePathCharacters)
  .refine((value) => !value.startsWith('/'), 'Path must be relative.')
  .refine((value) => !/^[A-Za-z]:/.test(value), 'Path cannot use a drive prefix.')
  .refine((value) => !value.includes('\\'), 'Path must use forward slashes.')
  .refine((value) => !value.includes('\0'), 'Path cannot contain NUL.')
  .refine(
    (value) => value.split('/').every((segment) => segment !== '' && segment !== '.'),
    'Path cannot contain empty or current-directory segments.',
  )
  .refine(
    (value) => !value.split('/').includes('..'),
    'Path cannot traverse outside the workspace.',
  );

export const WorkspacePathDocumentRefSchema = z
  .object({
    kind: z.literal('workspacePath'),
    workspaceFolderId: WorkspaceFolderIdSchema,
    relativePath: WorkspaceRelativePathSchema,
  })
  .strict();

export const UriDocumentRefSchema = z
  .object({
    kind: z.literal('uri'),
    uri: z.url().max(SCHEMA_LIMITS.uriCharacters),
  })
  .strict();

export const DocumentRefSchema = z.discriminatedUnion('kind', [
  UriDocumentRefSchema,
  WorkspacePathDocumentRefSchema,
]);

export const DocumentSnapshotSchema = z
  .object({
    uri: FileUriSchema,
    workspaceFolderId: WorkspaceFolderIdSchema,
    relativePath: z.string().min(1).max(SCHEMA_LIMITS.relativePathCharacters),
    languageId: z.string().min(1).max(SCHEMA_LIMITS.languageIdCharacters),
    documentVersion: z.number().int().nonnegative(),
    isDirty: z.boolean(),
  })
  .strict();

export const WorkspaceFolderDescriptorSchema = z
  .object({
    workspaceFolderId: WorkspaceFolderIdSchema,
    name: z.string().min(1).max(SCHEMA_LIMITS.displayNameCharacters),
    uri: FileUriSchema,
  })
  .strict();

export const InstanceDescriptorSchema = z
  .object({
    instanceId: InstanceIdSchema,
    displayName: z.string().min(1).max(SCHEMA_LIMITS.displayNameCharacters),
    trusted: z.literal(true),
    publishedAt: UtcTimestampSchema,
    workspaceFileUri: FileUriSchema.nullable(),
    workspaceFolders: z
      .array(WorkspaceFolderDescriptorSchema)
      .min(1)
      .max(PROTOCOL_LIMITS.workspaceFoldersPerInstance),
    protocolVersion: CurrentIpcProtocolVersionSchema,
    toolContractVersion: CurrentToolContractVersionSchema,
  })
  .strict();

export const ErrorCodeSchema = z.enum([
  'INVALID_ARGUMENT',
  'INSTANCE_NOT_FOUND',
  'INSTANCE_AMBIGUOUS',
  'INSTANCE_DISCONNECTED',
  'SERVER_BUSY',
  'WORKSPACE_UNTRUSTED',
  'WORKSPACE_FOLDER_NOT_FOUND',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_OUTSIDE_WORKSPACE',
  'UNSUPPORTED_URI_SCHEME',
  'UNSUPPORTED_DOCUMENT',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_VERSION_MISMATCH',
  'DOCUMENT_CHANGED_DURING_REQUEST',
  'POSITION_OUT_OF_RANGE',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
  'INTERNAL_ERROR',
  'INVALID_CURSOR',
  'BATCH_BUDGET_EXHAUSTED',
  'WRITE_NOT_ENABLED',
  'EXECUTION_NOT_ENABLED',
  'WRITE_GRANT_CHANGED',
  'EXECUTION_GRANT_CHANGED',
  'EDIT_CONFLICT',
  'EDIT_LIMIT_REACHED',
  'PREVIEW_REQUIRED',
  'PREVIEW_EXPIRED',
  'PREVIEW_ALREADY_USED',
  'OPAQUE_PROVIDER_EDIT',
  'FILE_ALREADY_EXISTS',
  'PARENT_NOT_FOUND',
  'DIRECTORY_OPERATION_UNSUPPORTED',
  'TASK_NOT_FOUND',
  'TASK_AMBIGUOUS',
  'TASK_LIMIT_REACHED',
  'EXECUTION_NOT_FOUND',
  'DEBUG_CONFIGURATION_NOT_FOUND',
  'DEBUG_SESSION_NOT_FOUND',
]);

export const SafeErrorDetailValueSchema = z.union([
  z.string().max(SCHEMA_LIMITS.safeDetailStringCharacters),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const SafeErrorDetailsSchema = z
  .record(
    z.string().min(1).max(SCHEMA_LIMITS.safeDetailKeyCharacters),
    SafeErrorDetailValueSchema,
  )
  .refine(
    (details) => Object.keys(details).length <= PROTOCOL_LIMITS.errorDetailEntries,
    `Error details cannot contain more than ${PROTOCOL_LIMITS.errorDetailEntries} entries.`,
  )
  .refine(
    (details) =>
      new TextEncoder().encode(JSON.stringify(details)).byteLength <=
      PROTOCOL_LIMITS.errorDetailsBytes,
    `Serialized error details cannot exceed ${PROTOCOL_LIMITS.errorDetailsBytes} bytes.`,
  );

export const ToolExecutionErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(SCHEMA_LIMITS.errorMessageCharacters),
    retryable: z.boolean(),
    details: SafeErrorDetailsSchema.optional(),
  })
  .strict();

export const FailureSchema = z
  .object({
    contractVersion: CurrentToolContractVersionSchema,
    error: ToolExecutionErrorSchema,
  })
  .strict();

export type Position = z.infer<typeof PositionSchema>;
export type Range = z.infer<typeof RangeSchema>;
export type DocumentRef = z.infer<typeof DocumentRefSchema>;
export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;
export type InstanceDescriptor = z.infer<typeof InstanceDescriptorSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type SafeErrorDetails = z.infer<typeof SafeErrorDetailsSchema>;
export type ToolExecutionError = z.infer<typeof ToolExecutionErrorSchema>;
export type Failure = z.infer<typeof FailureSchema>;
