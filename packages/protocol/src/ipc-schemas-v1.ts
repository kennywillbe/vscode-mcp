import * as z from 'zod/v4';

import { IPC_METHODS, JSON_RPC_VERSION } from './constants.js';
import { IpcCallToolResultSchema, type IpcCallToolResult } from './ipc-schemas.js';
import {
  V02IpcReadCallToolResultSchema,
  type V02IpcReadCallToolResult,
} from './ipc-schemas-v0.2.js';
import { RequestIdSchema, ToolExecutionErrorSchema } from './schemas.js';
import { EXTENSION_TOOL_NAMES } from './tool-schemas.js';
import {
  V02ReadToolInvocationSchema,
  V02_READ_TOOL_NAMES,
} from './tool-schemas-v0.2.js';
import {
  V1AdditionalToolInvocationSchema,
  V1AdditionalToolNameSchema,
  V1AdditionalToolResultSchema,
  V1_ADDITIONAL_TOOL_NAMES,
  type V1AdditionalToolInvocation,
  type V1AdditionalToolName,
  type V1AdditionalToolResult,
} from './tool-schemas-v1.js';
import { ExtensionToolInvocationSchema } from './tool-schemas.js';

export const V1_EXTENSION_TOOL_NAMES = [
  ...EXTENSION_TOOL_NAMES,
  ...V02_READ_TOOL_NAMES,
  ...V1_ADDITIONAL_TOOL_NAMES,
] as const;

export const V1ExtensionToolNameSchema = z.enum(V1_EXTENSION_TOOL_NAMES);
export const V1ExtensionToolInvocationSchema = z.union([
  ExtensionToolInvocationSchema,
  V02ReadToolInvocationSchema,
  V1AdditionalToolInvocationSchema,
]);

export const V1AdditionalToolFailureSchema = z
  .object({
    outcome: z.literal('toolError'),
    tool: V1AdditionalToolNameSchema,
    error: ToolExecutionErrorSchema,
  })
  .strict();

export const V1AdditionalIpcResultSchema = z.union([
  V1AdditionalToolResultSchema,
  V1AdditionalToolFailureSchema,
]);

export const V1IpcCallToolResultSchema = z.union([
  IpcCallToolResultSchema,
  V02IpcReadCallToolResultSchema,
  V1AdditionalIpcResultSchema,
]);

const V1CapabilitiesSchema = z
  .array(V1ExtensionToolNameSchema)
  .max(V1_EXTENSION_TOOL_NAMES.length)
  .superRefine((tools, context) => {
    let previous = -1;
    for (const [index, tool] of tools.entries()) {
      const position = V1_EXTENSION_TOOL_NAMES.indexOf(tool);
      if (position <= previous) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Capabilities must be unique and use canonical 1.0 order.',
        });
      }
      previous = position;
    }
  });

export const V1IpcCapabilitiesSchema = z
  .object({ extensionTools: V1CapabilitiesSchema, cancellation: z.literal(true) })
  .strict();

export const V1CallToolRequestMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    method: z.literal(IPC_METHODS.callTool),
    params: V1ExtensionToolInvocationSchema,
  })
  .strict();

export const V1CallToolResponseMessageSchema = z
  .object({
    jsonrpc: z.literal(JSON_RPC_VERSION),
    id: RequestIdSchema,
    result: V1IpcCallToolResultSchema,
  })
  .strict();

export type V1ExtensionToolName = z.infer<typeof V1ExtensionToolNameSchema>;
export type V1ExtensionToolInvocation = z.infer<typeof V1ExtensionToolInvocationSchema>;
export type V1AdditionalIpcResult =
  V1AdditionalToolResult | z.infer<typeof V1AdditionalToolFailureSchema>;
export type V1IpcCallToolResult =
  IpcCallToolResult | V02IpcReadCallToolResult | V1AdditionalIpcResult;
export type { V1AdditionalToolInvocation, V1AdditionalToolName };
