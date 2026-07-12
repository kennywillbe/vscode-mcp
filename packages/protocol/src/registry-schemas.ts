import * as z from 'zod/v4';

import {
  PROTOCOL_LIMITS,
  REGISTRY_SCHEMA_VERSION,
  SCHEMA_LIMITS,
} from './constants.js';
import {
  AnyIpcProtocolVersionSchema,
  AnyToolContractVersionSchema,
  AuthTokenSchema,
  CanonicalPathSchema,
  FileUriSchema,
  InstanceIdSchema,
  ProcessIdSchema,
  UtcTimestampSchema,
  WorkspaceFingerprintSchema,
  WorkspaceFolderIdSchema,
} from './schemas.js';

const UnixSocketPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.startsWith('/'), 'Unix socket path must be absolute.')
  .refine((value) => !value.includes('\0'), 'Unix socket path cannot contain NUL.');

const WindowsNamedPipePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.startsWith('\\\\.\\pipe\\vscode-mcp-'),
    'Named pipe must be local and use the vscode-mcp prefix.',
  )
  .refine((value) => !value.includes('\0'), 'Named-pipe path cannot contain NUL.');

export const UnixSocketEndpointSchema = z
  .object({
    kind: z.literal('unix'),
    path: UnixSocketPathSchema,
  })
  .strict();

export const WindowsNamedPipeEndpointSchema = z
  .object({
    kind: z.literal('windowsNamedPipe'),
    path: WindowsNamedPipePathSchema,
  })
  .strict();

export const IpcEndpointSchema = z.discriminatedUnion('kind', [
  UnixSocketEndpointSchema,
  WindowsNamedPipeEndpointSchema,
]);

export const RegistryWorkspaceFolderSchema = z
  .object({
    workspaceFolderId: WorkspaceFolderIdSchema,
    name: z.string().min(1).max(SCHEMA_LIMITS.displayNameCharacters),
    uri: FileUriSchema,
    canonicalPath: CanonicalPathSchema,
  })
  .strict();

const RegistryWorkspaceFoldersSchema = z
  .array(RegistryWorkspaceFolderSchema)
  .min(1)
  .max(PROTOCOL_LIMITS.workspaceFoldersPerInstance)
  .superRefine((folders, context) => {
    const ids = new Set<string>();
    const uris = new Set<string>();
    const canonicalPaths = new Set<string>();

    for (const [index, folder] of folders.entries()) {
      if (ids.has(folder.workspaceFolderId)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'workspaceFolderId'],
          message: 'Workspace-folder IDs must be unique.',
        });
      }
      if (uris.has(folder.uri)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'uri'],
          message: 'Workspace-folder URIs must be unique.',
        });
      }
      if (canonicalPaths.has(folder.canonicalPath)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'canonicalPath'],
          message: 'Canonical workspace paths must be unique.',
        });
      }

      ids.add(folder.workspaceFolderId);
      uris.add(folder.uri);
      canonicalPaths.add(folder.canonicalPath);
    }
  });

export const RegistryRecordSchema = z
  .object({
    schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
    protocolVersion: AnyIpcProtocolVersionSchema,
    toolContractVersion: AnyToolContractVersionSchema,
    instanceId: InstanceIdSchema,
    extensionVersion: AnyToolContractVersionSchema,
    pid: ProcessIdSchema,
    publishedAt: UtcTimestampSchema,
    heartbeatAt: UtcTimestampSchema,
    endpoint: IpcEndpointSchema,
    authToken: AuthTokenSchema,
    displayName: z.string().min(1).max(SCHEMA_LIMITS.displayNameCharacters),
    workspaceFingerprint: WorkspaceFingerprintSchema,
    workspaceFileUri: FileUriSchema.nullable(),
    workspaceFolders: RegistryWorkspaceFoldersSchema,
  })
  .strict();

export type IpcEndpoint = z.infer<typeof IpcEndpointSchema>;
export type RegistryWorkspaceFolder = z.infer<typeof RegistryWorkspaceFolderSchema>;
export type RegistryRecord = z.infer<typeof RegistryRecordSchema>;
