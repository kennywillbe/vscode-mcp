import * as z from 'zod/v4';

import {
  IPC_APPLICATION_ERROR_CODE,
  IPC_METHODS,
  JSON_RPC_VERSION,
  PROTOCOL_LIMITS,
  SCHEMA_LIMITS,
} from './constants.js';
import {
  AnyIpcProtocolVersionSchema,
  AnyToolContractVersionSchema,
  AuthTokenSchema,
  CurrentIpcProtocolVersionSchema,
  CurrentToolContractVersionSchema,
  InstanceDescriptorSchema,
  InstanceIdSchema,
  RequestIdSchema,
  SafeErrorDetailsSchema,
  ToolExecutionErrorSchema,
  UtcTimestampSchema,
  WorkspaceFingerprintSchema,
} from './schemas.js';
import {
  ExtensionToolNameSchema,
  ExtensionToolResultPayloadSchema,
  WarningsSchema,
} from './tool-schemas.js';
import {
  V1AllExtensionToolInvocationSchema,
  V1AllExtensionToolNameSchema,
  V1_ALL_EXTENSION_TOOL_NAMES,
} from './tool-schemas-v1.js';

const ExtensionCapabilitiesSchema = z
  .array(V1AllExtensionToolNameSchema)
  .max(V1_ALL_EXTENSION_TOOL_NAMES.length)
  .superRefine((tools, context) => {
    const seen = new Set<string>();
    let previousIndex = -1;

    for (const [index, tool] of tools.entries()) {
      const toolIndex = V1_ALL_EXTENSION_TOOL_NAMES.indexOf(tool);
      if (seen.has(tool)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Capability names must be unique.',
        });
      }
      if (toolIndex <= previousIndex) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Capabilities must use canonical tool order.',
        });
      }
      seen.add(tool);
      previousIndex = toolIndex;
    }
  });

export const IpcCapabilitiesSchema = z
  .object({
    extensionTools: ExtensionCapabilitiesSchema,
    cancellation: z.literal(true),
  })
  .strict();

export const HelloParamsSchema = z
  .object({
    protocolVersion: AnyIpcProtocolVersionSchema,
    toolContractVersion: AnyToolContractVersionSchema,
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

export const HelloResultSchema = z
  .object({
    protocolVersion: CurrentIpcProtocolVersionSchema,
    toolContractVersion: CurrentToolContractVersionSchema,
    workspaceFingerprint: WorkspaceFingerprintSchema,
    instance: InstanceDescriptorSchema,
    capabilities: IpcCapabilitiesSchema,
  })
  .strict();

export const HelloRequestMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    method: z.literal(IPC_METHODS.hello),
    params: HelloParamsSchema,
  })
  .strict();

export const CallToolRequestMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    method: z.literal(IPC_METHODS.callTool),
    params: V1AllExtensionToolInvocationSchema,
  })
  .strict();

export const CloseSessionParamsSchema = z.object({}).strict();

export const CloseSessionResultSchema = z
  .object({
    closed: z.literal(true),
  })
  .strict();

export const CloseSessionRequestMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    method: z.literal(IPC_METHODS.closeSession),
    params: CloseSessionParamsSchema,
  })
  .strict();

export const CancelRequestNotificationSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    method: z.literal(IPC_METHODS.cancelRequest),
    params: z.object({ id: RequestIdSchema }).strict(),
  })
  .strict();

export const BridgeToExtensionMessageSchema = z.union([
  HelloRequestMessageSchema,
  CallToolRequestMessageSchema,
  CloseSessionRequestMessageSchema,
  CancelRequestNotificationSchema,
]);

export const IpcToolSuccessSchema = z
  .object({
    outcome: z.literal('success'),
    observedAt: UtcTimestampSchema,
    truncated: z.boolean(),
    warnings: WarningsSchema,
    payload: ExtensionToolResultPayloadSchema,
  })
  .strict();

export const IpcToolFailureSchema = z
  .object({
    outcome: z.literal('toolError'),
    tool: ExtensionToolNameSchema,
    error: ToolExecutionErrorSchema,
  })
  .strict();

export const IpcCallToolResultSchema = z.discriminatedUnion('outcome', [
  IpcToolSuccessSchema,
  IpcToolFailureSchema,
]);

export const HelloSuccessResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    result: HelloResultSchema,
  })
  .strict();

export const CallToolResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    result: IpcCallToolResultSchema,
  })
  .strict();

export const CloseSessionSuccessResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    result: CloseSessionResultSchema,
  })
  .strict();

export const IpcTransportErrorCodeSchema = z.enum([
  'MALFORMED_FRAME',
  'FRAME_TOO_LARGE',
  'HANDSHAKE_REQUIRED',
  'HANDSHAKE_TIMEOUT',
  'PROTOCOL_VERSION_MISMATCH',
  'TOOL_CONTRACT_VERSION_MISMATCH',
  'UNEXPECTED_MESSAGE',
  'DUPLICATE_REQUEST_ID',
  'CONNECTION_LIMIT_EXCEEDED',
  'INTERNAL_TRANSPORT_ERROR',
]);

export const IpcTransportErrorDataSchema = z
  .object({
    code: IpcTransportErrorCodeSchema,
    fatal: z.boolean(),
    details: SafeErrorDetailsSchema.optional(),
  })
  .strict();

export const AuthenticationErrorResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema.nullable(),
    error: z
      .object({
        code: z.literal(IPC_APPLICATION_ERROR_CODE),
        message: z.literal('Authentication failed'),
      })
      .strict(),
  })
  .strict();

export const IpcApplicationErrorResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema.nullable(),
    error: z
      .object({
        code: z.literal(IPC_APPLICATION_ERROR_CODE),
        message: z.string().min(1).max(SCHEMA_LIMITS.transportErrorMessageCharacters),
        data: IpcTransportErrorDataSchema,
      })
      .strict(),
  })
  .strict();

export const StandardJsonRpcErrorResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema.nullable(),
    error: z
      .object({
        code: z.union([
          z.literal(-32_700),
          z.literal(-32_600),
          z.literal(-32_601),
          z.literal(-32_602),
          z.literal(-32_603),
        ]),
        message: z.string().min(1).max(SCHEMA_LIMITS.transportErrorMessageCharacters),
      })
      .strict(),
  })
  .strict();

export const IpcErrorResponseMessageSchema = z.union([
  AuthenticationErrorResponseMessageSchema,
  IpcApplicationErrorResponseMessageSchema,
  StandardJsonRpcErrorResponseMessageSchema,
]);

export const ExtensionToBridgeMessageSchema = z.union([
  HelloSuccessResponseMessageSchema,
  CallToolResponseMessageSchema,
  CloseSessionSuccessResponseMessageSchema,
  IpcErrorResponseMessageSchema,
]);

export type IpcCapabilities = z.infer<typeof IpcCapabilitiesSchema>;
export type HelloParams = z.infer<typeof HelloParamsSchema>;
export type HelloResult = z.infer<typeof HelloResultSchema>;
export type BridgeToExtensionMessage = z.infer<typeof BridgeToExtensionMessageSchema>;
export type IpcCallToolResult = z.infer<typeof IpcCallToolResultSchema>;
export type CloseSessionParams = z.infer<typeof CloseSessionParamsSchema>;
export type CloseSessionResult = z.infer<typeof CloseSessionResultSchema>;
export type IpcTransportErrorCode = z.infer<typeof IpcTransportErrorCodeSchema>;
export type IpcTransportErrorData = z.infer<typeof IpcTransportErrorDataSchema>;
export type ExtensionToBridgeMessage = z.infer<typeof ExtensionToBridgeMessageSchema>;

export const IPC_FRAME_LIMITS = {
  bridgeToExtension: PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
  extensionToBridge: PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
} as const;
