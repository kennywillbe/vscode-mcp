import { realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BoundedJsonRpcMessageReader,
  BoundedJsonRpcMessageWriter,
} from '@vscode-mcp/protocol/bounded-jsonrpc';
import {
  IPC_PROTOCOL_VERSION,
  PROTOCOL_LIMITS,
  TOOL_CONTRACT_VERSION,
} from '@vscode-mcp/protocol/constants';
import { registryMatchesHello } from '@vscode-mcp/protocol/handshake';
import {
  CloseSessionResultSchema,
  HelloResultSchema,
  IpcTransportErrorDataSchema,
  type IpcCapabilities,
} from '@vscode-mcp/protocol/ipc-schemas';
import {
  V1IpcCallToolResultSchema,
  type V1IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas-v1';
import type { RegistryRecordSnapshot } from '@vscode-mcp/protocol/runtime-registry';
import {
  CallToolRequestType,
  CloseSessionRequestType,
  HelloRequestType,
} from '@vscode-mcp/protocol/rpc-methods';
import type { InstanceDescriptor } from '@vscode-mcp/protocol/schemas';
import type { V1AllExtensionToolInvocation } from '@vscode-mcp/protocol/tool-schemas-v1';
import {
  CancellationTokenSource,
  createMessageConnection,
  NullLogger,
  ResponseError,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

import { SERVER_VERSION } from './version.js';

export interface AuthenticatedInstance {
  readonly safeDescriptor: InstanceDescriptor;
  readonly canonicalWorkspaceRoots: readonly string[];
  readonly capabilities: IpcCapabilities;
}

export type InstanceProbeResult =
  | { readonly status: 'authenticated'; readonly instance: AuthenticatedInstance }
  | { readonly status: 'incompatible' | 'rejected' };

export interface InstanceProbeOptions {
  readonly bridgeVersion?: string;
  readonly timeoutMs?: number;
  readonly connect?: (path: string) => Socket;
}

export type InstanceToolCallResult =
  | {
      readonly status: 'completed';
      readonly instance: AuthenticatedInstance;
      readonly result: V1IpcCallToolResult;
    }
  | {
      readonly status:
        'incompatible' | 'rejected' | 'disconnected' | 'capabilityUnavailable';
    };

export interface InstanceToolCallOptions extends InstanceProbeOptions {
  readonly signal?: AbortSignal;
}

export async function probeRegistryRecord(
  snapshot: RegistryRecordSnapshot,
  options: InstanceProbeOptions = {},
): Promise<InstanceProbeResult> {
  let session: OpenSession | undefined;
  let authenticatedSession = false;

  try {
    session = openSession(snapshot, options);
    const authenticated = await authenticateSession(snapshot, session, options);
    if (authenticated.status !== 'authenticated') {
      return authenticated;
    }
    authenticatedSession = true;

    return authenticated;
  } catch (error: unknown) {
    return isAuthenticatedProtocolMismatch(error)
      ? { status: 'incompatible' }
      : { status: 'rejected' };
  } finally {
    if (session !== undefined) {
      await closeConnection(session.connection, session.socket, authenticatedSession);
    }
  }
}

export async function callRegistryRecord(
  snapshot: RegistryRecordSnapshot,
  invocation: V1AllExtensionToolInvocation,
  options: InstanceToolCallOptions = {},
): Promise<InstanceToolCallResult> {
  let session: OpenSession | undefined;
  const cancellation = new CancellationTokenSource();
  let authenticatedSession = false;
  const abort = (): void => cancellation.cancel();
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    session = openSession(snapshot, options);
    if (options.signal?.aborted === true) {
      cancellation.cancel();
    }

    const authenticated = await authenticateSession(snapshot, session, options);
    if (authenticated.status !== 'authenticated') {
      return authenticated;
    }
    authenticatedSession = true;
    if (!authenticated.instance.capabilities.extensionTools.includes(invocation.tool)) {
      return { status: 'capabilityUnavailable' };
    }
    const connection = session.connection;
    if (connection === undefined) {
      return { status: 'disconnected' };
    }

    const rawResult = await awaitToolResponse(
      connection.sendRequest(CallToolRequestType, invocation, cancellation.token),
      session.socket,
      options.signal,
    );
    const parsed = V1IpcCallToolResultSchema.safeParse(rawResult);
    if (!parsed.success) {
      return { status: 'rejected' };
    }
    const responseTool =
      parsed.data.outcome === 'toolError' || !('payload' in parsed.data)
        ? parsed.data.tool
        : parsed.data.payload.tool;
    if (responseTool !== invocation.tool) {
      return { status: 'rejected' };
    }

    return {
      status: 'completed',
      instance: authenticated.instance,
      result: parsed.data,
    };
  } catch (error: unknown) {
    if (isAuthenticatedProtocolMismatch(error)) {
      return { status: 'incompatible' };
    }
    return { status: 'disconnected' };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    cancellation.dispose();
    if (session !== undefined) {
      await closeConnection(session.connection, session.socket, authenticatedSession);
    }
  }
}

function sessionReleaseDelay(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, PROTOCOL_LIMITS.sessionReleaseSettleMs),
  );
}

interface OpenSession {
  readonly socket: Socket;
  connection: MessageConnection | undefined;
}

function openSession(
  snapshot: RegistryRecordSnapshot,
  options: InstanceProbeOptions,
): OpenSession {
  const connect = options.connect ?? ((path: string) => createConnection(path));
  const socket = connect(snapshot.record.endpoint.path);
  return { socket, connection: undefined };
}

function startMessageConnection(socket: Socket): MessageConnection {
  const reader = new BoundedJsonRpcMessageReader(
    socket,
    PROTOCOL_LIMITS.extensionToBridgeFrameBytes,
  );
  const writer = new BoundedJsonRpcMessageWriter(
    socket,
    PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
  );
  const connection = createMessageConnection(reader, writer, NullLogger);
  connection.listen();
  return connection;
}

async function authenticateSession(
  snapshot: RegistryRecordSnapshot,
  session: OpenSession,
  options: InstanceProbeOptions,
): Promise<InstanceProbeResult> {
  const rawResult = await withTimeout(
    (async () => {
      await waitForSocketConnect(session.socket);
      const connection = startMessageConnection(session.socket);
      session.connection = connection;
      return connection.sendRequest(HelloRequestType, {
        protocolVersion: IPC_PROTOCOL_VERSION,
        toolContractVersion: TOOL_CONTRACT_VERSION,
        instanceId: snapshot.record.instanceId,
        authToken: snapshot.record.authToken,
        client: {
          name: 'vscode-mcp-bridge',
          version: options.bridgeVersion ?? SERVER_VERSION,
        },
      });
    })(),
    options.timeoutMs ?? PROTOCOL_LIMITS.endpointProbeTimeoutMs,
    session.socket,
  );
  const hello = HelloResultSchema.safeParse(rawResult);
  if (!hello.success || !registryMatchesHello(snapshot.record, hello.data)) {
    return { status: 'rejected' };
  }
  const canonicalWorkspaceRoots = await verifiedCanonicalWorkspaceRoots(
    snapshot,
    hello.data.instance.workspaceFolders.map((folder) => folder.uri),
  );
  if (canonicalWorkspaceRoots === null) {
    return { status: 'rejected' };
  }

  return {
    status: 'authenticated',
    instance: {
      safeDescriptor: hello.data.instance,
      canonicalWorkspaceRoots,
      capabilities: hello.data.capabilities,
    },
  };
}

async function waitForSocketConnect(socket: Socket): Promise<void> {
  if (socket.readyState === 'open') {
    return;
  }
  if (socket.destroyed || socket.closed) {
    throw new Error('The local IPC endpoint is unavailable.');
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.removeListener('connect', handleConnect);
      socket.removeListener('error', handleFailure);
      socket.removeListener('close', handleFailure);
    };
    const finish = (failure: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (failure) {
        socket.destroy();
        reject(new Error('The local IPC endpoint is unavailable.'));
      } else {
        resolve();
      }
    };
    const handleConnect = (): void => finish(false);
    const handleFailure = (): void => finish(true);

    socket.once('connect', handleConnect);
    socket.once('error', handleFailure);
    socket.once('close', handleFailure);
    if (socket.readyState === 'open') {
      finish(false);
    } else if (socket.destroyed || socket.closed) {
      finish(true);
    }
  });
}

async function verifiedCanonicalWorkspaceRoots(
  snapshot: RegistryRecordSnapshot,
  authenticatedUris: readonly string[],
): Promise<readonly string[] | null> {
  if (snapshot.record.workspaceFolders.length !== authenticatedUris.length) {
    return null;
  }

  const verified: string[] = [];
  for (const [index, folder] of snapshot.record.workspaceFolders.entries()) {
    const authenticatedUri = authenticatedUris[index];
    if (authenticatedUri === undefined) {
      return null;
    }

    try {
      const canonicalPath = await realpath(fileURLToPath(authenticatedUri));
      if (!canonicalPathsEqual(canonicalPath, folder.canonicalPath)) {
        return null;
      }
      verified.push(canonicalPath);
    } catch {
      return null;
    }
  }

  return verified;
}

export function canonicalPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathImplementation = platform === 'win32' ? win32 : posix;
  const normalizedLeft = pathImplementation.normalize(left);
  const normalizedRight = pathImplementation.normalize(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isAuthenticatedProtocolMismatch(error: unknown): boolean {
  if (!(error instanceof ResponseError)) {
    return false;
  }

  const data = IpcTransportErrorDataSchema.safeParse(error.data);
  return (
    data.success &&
    (data.data.code === 'PROTOCOL_VERSION_MISMATCH' ||
      data.data.code === 'TOOL_CONTRACT_VERSION_MISMATCH')
  );
}

async function awaitToolResponse<T>(
  operation: Promise<T>,
  socket: Socket,
  signal: AbortSignal | undefined,
): Promise<T> {
  let settled = false;
  let rejectTermination: ((reason: Error) => void) | undefined;
  const termination = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const terminate = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    rejectTermination?.(new Error('IPC tool session terminated.'));
  };

  socket.once('close', terminate);
  socket.once('error', terminate);
  signal?.addEventListener('abort', terminate, { once: true });

  try {
    if (socket.closed || socket.destroyed || signal?.aborted === true) {
      terminate();
    }
    return await Promise.race([operation, termination]);
  } finally {
    settled = true;
    socket.removeListener('close', terminate);
    socket.removeListener('error', terminate);
    signal?.removeEventListener('abort', terminate);
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  socket: Socket,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('IPC probe timed out.'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function closeConnection(
  connection: MessageConnection | undefined,
  socket: Socket,
  authenticatedSession: boolean,
): Promise<void> {
  // Disposing vscode-jsonrpc removes its stream error listeners even when a queued
  // write is still settling. Install the teardown-only listener before every early
  // branch, then retain it through the next event-loop turn after peer close.
  const ignoreTeardownError = (): void => undefined;
  socket.on('error', ignoreTeardownError);

  try {
    if (connection === undefined || socket.closed) {
      return;
    }

    if (authenticatedSession) {
      try {
        await withTimeout(
          closeAuthenticatedSession(connection, socket),
          PROTOCOL_LIMITS.sessionCloseTimeoutMs,
          socket,
        );
        return;
      } catch {
        // A failed authenticated close falls through to the transport-level fallback.
      }
    }

    await forceCloseConnection(connection, socket);
  } finally {
    connection?.dispose();
    if (!socket.closed) {
      socket.destroy();
      await waitForSocketClose(socket);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The extension host removes the accepted socket before closing its peer, but
    // Electron can deliver that bookkeeping on the following host turn. A tiny
    // bounded settle prevents rapid one-shot MCP calls from transiently exhausting
    // the four authenticated-session slots.
    await sessionReleaseDelay();
    socket.removeListener('error', ignoreTeardownError);
  }
}

async function closeAuthenticatedSession(
  connection: MessageConnection,
  socket: Socket,
): Promise<void> {
  const rawAck = await connection.sendRequest(CloseSessionRequestType, {});
  if (!CloseSessionResultSchema.safeParse(rawAck).success) {
    throw new Error('The IPC close acknowledgement was invalid.');
  }
  await waitForSocketClose(socket);
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.closed) {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once('close', resolve);
    if (socket.closed) {
      socket.removeListener('close', resolve);
      resolve();
    }
  });
}

async function forceCloseConnection(
  connection: MessageConnection,
  socket: Socket,
): Promise<void> {
  if (socket.closed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish();
    }, PROTOCOL_LIMITS.sessionCloseTimeoutMs);

    socket.once('close', finish);
    try {
      connection.dispose();
      socket.end();
      if (socket.closed) {
        finish();
      }
    } catch {
      socket.destroy();
      finish();
    }
  });
}
