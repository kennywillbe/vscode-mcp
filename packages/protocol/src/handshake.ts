import { IPC_PROTOCOL_VERSION, TOOL_CONTRACT_VERSION } from './constants.js';
import { credentialsMatch } from './credentials.js';
import {
  type HelloResult,
  HelloParamsSchema,
  HelloResultSchema,
  type IpcCapabilities,
} from './ipc-schemas.js';
import type { RegistryRecord } from './registry-schemas.js';
import type { InstanceDescriptor, SafeErrorDetails } from './schemas.js';

export interface HandshakeExpectation {
  instance: InstanceDescriptor;
  workspaceFingerprint: string;
  authToken: string;
  capabilities: IpcCapabilities;
}

export type HandshakeDecision =
  | { ok: true; result: HelloResult }
  | {
      ok: false;
      failure: {
        kind: 'authentication' | 'protocol';
        message: 'Authentication failed' | 'Protocol version mismatch';
        code?: 'PROTOCOL_VERSION_MISMATCH' | 'TOOL_CONTRACT_VERSION_MISMATCH';
        details?: SafeErrorDetails;
      };
    };

export function evaluateHello(
  untrustedParams: unknown,
  expectation: HandshakeExpectation,
): HandshakeDecision {
  const parsed = HelloParamsSchema.safeParse(untrustedParams);
  if (!parsed.success) {
    return authenticationFailure();
  }

  const authenticated = credentialsMatch(
    expectation.instance.instanceId,
    expectation.authToken,
    parsed.data.instanceId,
    parsed.data.authToken,
  );
  if (!authenticated) {
    return authenticationFailure();
  }

  if (parsed.data.protocolVersion !== IPC_PROTOCOL_VERSION) {
    return {
      ok: false,
      failure: {
        kind: 'protocol',
        message: 'Protocol version mismatch',
        code: 'PROTOCOL_VERSION_MISMATCH',
        details: {
          received: parsed.data.protocolVersion,
          supported: IPC_PROTOCOL_VERSION,
        },
      },
    };
  }

  if (parsed.data.toolContractVersion !== TOOL_CONTRACT_VERSION) {
    return {
      ok: false,
      failure: {
        kind: 'protocol',
        message: 'Protocol version mismatch',
        code: 'TOOL_CONTRACT_VERSION_MISMATCH',
        details: {
          received: parsed.data.toolContractVersion,
          supported: TOOL_CONTRACT_VERSION,
        },
      },
    };
  }

  return {
    ok: true,
    result: HelloResultSchema.parse({
      protocolVersion: IPC_PROTOCOL_VERSION,
      toolContractVersion: TOOL_CONTRACT_VERSION,
      workspaceFingerprint: expectation.workspaceFingerprint,
      instance: expectation.instance,
      capabilities: expectation.capabilities,
    }),
  };
}

export function registryMatchesHello(
  record: RegistryRecord,
  result: HelloResult,
): boolean {
  if (
    record.protocolVersion !== result.protocolVersion ||
    record.toolContractVersion !== result.toolContractVersion ||
    record.instanceId !== result.instance.instanceId ||
    record.workspaceFingerprint !== result.workspaceFingerprint ||
    record.displayName !== result.instance.displayName ||
    record.publishedAt !== result.instance.publishedAt ||
    record.workspaceFileUri !== result.instance.workspaceFileUri ||
    record.workspaceFolders.length !== result.instance.workspaceFolders.length
  ) {
    return false;
  }

  return record.workspaceFolders.every((folder, index) => {
    const authenticatedFolder = result.instance.workspaceFolders[index];
    return (
      authenticatedFolder !== undefined &&
      folder.workspaceFolderId === authenticatedFolder.workspaceFolderId &&
      folder.name === authenticatedFolder.name &&
      folder.uri === authenticatedFolder.uri
    );
  });
}

function authenticationFailure(): HandshakeDecision {
  return {
    ok: false,
    failure: {
      kind: 'authentication',
      message: 'Authentication failed',
    },
  };
}
