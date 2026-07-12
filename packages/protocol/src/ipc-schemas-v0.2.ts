import * as z from 'zod/v4';

import {
  IPC_METHODS,
  IPC_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  V02_TOOL_CONTRACT_VERSION,
} from './constants.js';
import { IpcCallToolResultSchema } from './ipc-schemas.js';
import {
  AnyToolContractVersionSchema,
  AuthTokenSchema,
  InstanceDescriptorSchema,
  InstanceIdSchema,
  RequestIdSchema,
  WorkspaceFingerprintSchema,
} from './schemas.js';
import { EXTENSION_TOOL_NAMES, ExtensionToolInvocationSchema } from './tool-schemas.js';
import {
  V02ListWorkspaceFilesSuccessSchema,
  V02ReadDocumentsSuccessSchema,
  V02ReadToolInvocationSchema,
  V02ReadToolNameSchema,
  V02SearchWorkspaceTextSuccessSchema,
  V02ToolExecutionErrorSchema,
  V02_READ_TOOL_NAMES,
} from './tool-schemas-v0.2.js';

export const V02_EXTENSION_TOOL_NAMES = [
  ...EXTENSION_TOOL_NAMES,
  ...V02_READ_TOOL_NAMES,
] as const;

export const V02ExtensionToolNameSchema = z.enum(V02_EXTENSION_TOOL_NAMES);

const V02ExtensionCapabilitiesSchema = z
  .array(V02ExtensionToolNameSchema)
  .max(V02_EXTENSION_TOOL_NAMES.length)
  .superRefine((tools, context) => {
    let previous = -1;
    const seen = new Set<string>();
    for (const [index, tool] of tools.entries()) {
      const position = V02_EXTENSION_TOOL_NAMES.indexOf(tool);
      if (seen.has(tool)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Capability names must be unique.',
        });
      }
      if (position <= previous) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Capabilities must use canonical v0.2 tool order.',
        });
      }
      seen.add(tool);
      previous = position;
    }
  });

export const V02IpcCapabilitiesSchema = z
  .object({
    extensionTools: V02ExtensionCapabilitiesSchema,
    cancellation: z.literal(true),
  })
  .strict();

export const V02InstanceDescriptorSchema = InstanceDescriptorSchema.omit({
  toolContractVersion: true,
})
  .extend({ toolContractVersion: z.literal(V02_TOOL_CONTRACT_VERSION) })
  .strict();

export const V02HelloParamsSchema = z
  .object({
    protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
    toolContractVersion: z.literal(V02_TOOL_CONTRACT_VERSION),
    instanceId: InstanceIdSchema,
    authToken: AuthTokenSchema,
    client: z
      .object({
        name: z.literal('vscode-mcp-bridge'),
        version: AnyToolContractVersionSchema,
      })
      .strict(),
  })
  .strict();

export const V02HelloResultSchema = z
  .object({
    protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
    toolContractVersion: z.literal(V02_TOOL_CONTRACT_VERSION),
    workspaceFingerprint: WorkspaceFingerprintSchema,
    instance: V02InstanceDescriptorSchema,
    capabilities: V02IpcCapabilitiesSchema,
  })
  .strict();

export const V02ExtensionToolInvocationSchema = z.union([
  ExtensionToolInvocationSchema,
  V02ReadToolInvocationSchema,
]);

const V02ReadToolSuccessSchema = z.discriminatedUnion('tool', [
  z
    .object({
      outcome: z.literal('success'),
      tool: z.literal('list_workspace_files'),
      response: V02ListWorkspaceFilesSuccessSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('success'),
      tool: z.literal('read_documents'),
      response: V02ReadDocumentsSuccessSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('success'),
      tool: z.literal('search_workspace_text'),
      response: V02SearchWorkspaceTextSuccessSchema,
    })
    .strict(),
]);

export const V02ReadToolFailureSchema = z
  .object({
    outcome: z.literal('toolError'),
    tool: V02ReadToolNameSchema,
    error: V02ToolExecutionErrorSchema,
  })
  .strict();

export const V02IpcReadCallToolResultSchema = z.union([
  V02ReadToolSuccessSchema,
  V02ReadToolFailureSchema,
]);

export const V02IpcCallToolResultSchema = z.union([
  IpcCallToolResultSchema,
  V02IpcReadCallToolResultSchema,
]);

export const V02HelloRequestMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    method: z.literal(IPC_METHODS.hello),
    params: V02HelloParamsSchema,
  })
  .strict();

export const V02CallToolRequestMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    method: z.literal(IPC_METHODS.callTool),
    params: V02ExtensionToolInvocationSchema,
  })
  .strict();

export const V02HelloSuccessResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    result: V02HelloResultSchema,
  })
  .strict();

export const V02CallToolResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    result: V02IpcCallToolResultSchema,
  })
  .strict();

export type V02ExtensionToolName = z.infer<typeof V02ExtensionToolNameSchema>;
export type V02IpcCapabilities = z.infer<typeof V02IpcCapabilitiesSchema>;
export type V02InstanceDescriptor = z.infer<typeof V02InstanceDescriptorSchema>;
export type V02HelloParams = z.infer<typeof V02HelloParamsSchema>;
export type V02HelloResult = z.infer<typeof V02HelloResultSchema>;
export type V02ExtensionToolInvocation = z.infer<
  typeof V02ExtensionToolInvocationSchema
>;
export type V02IpcReadCallToolResult = z.infer<typeof V02IpcReadCallToolResultSchema>;
export type V02IpcCallToolResult = z.infer<typeof V02IpcCallToolResultSchema>;
