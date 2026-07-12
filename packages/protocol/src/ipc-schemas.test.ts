import { describe, expect, it } from 'vitest';

import { IPC_APPLICATION_ERROR_CODE } from './constants.js';
import {
  AuthenticationErrorResponseMessageSchema,
  BridgeToExtensionMessageSchema,
  CallToolRequestMessageSchema,
  CancelRequestNotificationSchema,
  CloseSessionRequestMessageSchema,
  CloseSessionSuccessResponseMessageSchema,
  HelloRequestMessageSchema,
  HelloSuccessResponseMessageSchema,
  IpcApplicationErrorResponseMessageSchema,
  IpcCapabilitiesSchema,
} from './ipc-schemas.js';

const instanceId = '00000000-0000-4000-8000-000000000000';
const helloParams = {
  protocolVersion: 1,
  toolContractVersion: '1.0.0',
  instanceId,
  authToken: 'A'.repeat(43),
  client: { name: 'vscode-mcp-bridge' as const, version: '0.0.0' },
};

describe('IPC JSON-RPC schemas', () => {
  it('accepts a strict hello as the first request shape', () => {
    const message = {
      jsonrpc: '2.0' as const,
      id: 0,
      method: 'vscode-mcp/hello' as const,
      params: helloParams,
    };

    expect(HelloRequestMessageSchema.parse(message)).toEqual(message);
    expect(BridgeToExtensionMessageSchema.parse(message)).toEqual(message);
    expect(
      HelloRequestMessageSchema.safeParse({ ...message, debug: true }).success,
    ).toBe(false);
  });

  it('keeps unsupported versions parseable for explicit mismatch handling', () => {
    expect(
      HelloRequestMessageSchema.parse({
        jsonrpc: '2.0',
        id: 1,
        method: 'vscode-mcp/hello',
        params: { ...helloParams, protocolVersion: 2 },
      }).params.protocolVersion,
    ).toBe(2);
  });

  it('accepts only non-negative safe-integer request IDs', () => {
    for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(
        HelloRequestMessageSchema.safeParse({
          jsonrpc: '2.0',
          id,
          method: 'vscode-mcp/hello',
          params: helloParams,
        }).success,
      ).toBe(false);
    }
  });

  it('keeps list_instances and instance redirection off the IPC tool method', () => {
    const base = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'vscode-mcp/callTool' as const,
    };

    expect(
      CallToolRequestMessageSchema.safeParse({
        ...base,
        params: { tool: 'list_instances', arguments: {} },
      }).success,
    ).toBe(false);
    expect(
      CallToolRequestMessageSchema.safeParse({
        ...base,
        params: {
          tool: 'get_editor_context',
          arguments: { instanceId, documentLimit: 10 },
        },
      }).success,
    ).toBe(false);
  });

  it('models cancellation as an ID-less notification', () => {
    const notification = {
      jsonrpc: '2.0' as const,
      method: '$/cancelRequest' as const,
      params: { id: 2 },
    };
    expect(CancelRequestNotificationSchema.parse(notification)).toEqual(notification);
    expect(
      CancelRequestNotificationSchema.safeParse({ ...notification, id: 3 }).success,
    ).toBe(false);
  });

  it('models graceful session close as strict empty params and a strict ack', () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 3,
      method: 'vscode-mcp/closeSession' as const,
      params: {},
    };
    const response = {
      jsonrpc: '2.0' as const,
      id: 3,
      result: { closed: true as const },
    };

    expect(CloseSessionRequestMessageSchema.parse(request)).toEqual(request);
    expect(BridgeToExtensionMessageSchema.parse(request)).toEqual(request);
    expect(CloseSessionSuccessResponseMessageSchema.parse(response)).toEqual(response);
    expect(
      CloseSessionRequestMessageSchema.safeParse({
        ...request,
        params: { reason: 'secret' },
      }).success,
    ).toBe(false);
    expect(
      CloseSessionSuccessResponseMessageSchema.safeParse({
        ...response,
        result: { closed: true, endpoint: '/private/socket' },
      }).success,
    ).toBe(false);
  });

  it('allows only unique capabilities in canonical order', () => {
    expect(
      IpcCapabilitiesSchema.safeParse({
        extensionTools: ['read_document', 'get_hover'],
        cancellation: true,
      }).success,
    ).toBe(true);
    expect(
      IpcCapabilitiesSchema.safeParse({
        extensionTools: ['get_hover', 'read_document'],
        cancellation: true,
      }).success,
    ).toBe(false);
    expect(
      IpcCapabilitiesSchema.safeParse({
        extensionTools: ['read_document', 'read_document'],
        cancellation: true,
      }).success,
    ).toBe(false);
  });

  it('returns authenticated instance metadata without registry secrets', () => {
    const response = {
      jsonrpc: '2.0' as const,
      id: 0,
      result: {
        protocolVersion: 1,
        toolContractVersion: '1.0.0' as const,
        workspaceFingerprint: 'a'.repeat(64),
        instance: {
          instanceId,
          displayName: 'fixture',
          trusted: true as const,
          publishedAt: '2026-07-10T00:00:00.000Z',
          workspaceFileUri: null,
          workspaceFolders: [
            {
              workspaceFolderId: 'root',
              name: 'fixture',
              uri: 'file:///workspace',
            },
          ],
          protocolVersion: 1 as const,
          toolContractVersion: '1.0.0' as const,
        },
        capabilities: { extensionTools: [], cancellation: true as const },
      },
    };

    expect(HelloSuccessResponseMessageSchema.parse(response)).toEqual(response);
    expect(JSON.stringify(response)).not.toContain('authToken');
    expect(JSON.stringify(response)).not.toContain('endpoint');
    expect(JSON.stringify(response)).not.toContain('pid');
    expect(JSON.stringify(response)).not.toContain('canonicalPath');
  });

  it('makes authentication failures generic and detail-free', () => {
    const failure = {
      jsonrpc: '2.0' as const,
      id: 0,
      error: {
        code: IPC_APPLICATION_ERROR_CODE,
        message: 'Authentication failed' as const,
      },
    };

    expect(AuthenticationErrorResponseMessageSchema.parse(failure)).toEqual(failure);
    expect(
      AuthenticationErrorResponseMessageSchema.safeParse({
        ...failure,
        error: { ...failure.error, expectedToken: 'secret' },
      }).success,
    ).toBe(false);
  });

  it('keeps post-authentication transport errors bounded and shallow', () => {
    const response = {
      jsonrpc: '2.0' as const,
      id: 0,
      error: {
        code: IPC_APPLICATION_ERROR_CODE,
        message: 'Protocol version mismatch',
        data: {
          code: 'PROTOCOL_VERSION_MISMATCH' as const,
          fatal: true,
          details: { received: 2, supported: 1 },
        },
      },
    };

    expect(IpcApplicationErrorResponseMessageSchema.parse(response)).toEqual(response);
    expect(
      IpcApplicationErrorResponseMessageSchema.safeParse({
        ...response,
        error: {
          ...response.error,
          data: { ...response.error.data, details: { nested: { secret: true } } },
        },
      }).success,
    ).toBe(false);
  });
});
