import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { PROTOCOL_LIMITS } from '@vscode-mcp/protocol/constants';
import {
  discoverRegistryRecords,
  resolveRuntimeRegistryPaths,
  type RegistryRecordSnapshot,
  type RuntimeRegistryEnvironment,
} from '@vscode-mcp/protocol/runtime-registry';
import type { ReadDocumentResult } from '@vscode-mcp/protocol/tool-schemas';
import type { V1AllExtensionToolInvocation } from '@vscode-mcp/protocol/tool-schemas-v1';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IpcInstanceService, type IpcCallToolHandler } from './ipc-instance-service.js';

const fixtures: string[] = [];
const services: IpcInstanceService[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    await stopChild(child);
  }
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })),
  );
});

type JsonRpcResponse = {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
};

type GuardEvent = {
  readonly source: 'vscode-mcp-runtime-security-guard';
  readonly api: string;
  readonly classification:
    'forbidden' | 'instrumentation' | 'local-ipc' | 'runtime-infrastructure';
};

type PendingToolCall = {
  readonly started: Promise<void>;
  readonly aborted: Promise<void>;
  start(): void;
  abort(): void;
  release(): void;
  waitForRelease(): Promise<unknown>;
};

class JsonLineRpcClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (response: JsonRpcResponse) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  #buffer = '';
  readonly messages: JsonRpcResponse[] = [];

  public constructor(child: ChildProcess) {
    this.#child = child;
    const stdout = child.stdout;
    if (stdout === null) {
      throw new Error('The instrumented bridge stdout pipe is unavailable.');
    }
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.accept(chunk));
    child.once('exit', () => {
      const error = new Error('The instrumented bridge exited.');
      for (const pending of this.#pending.values()) {
        pending.reject(error);
      }
      this.#pending.clear();
    });
  }

  public request(
    id: number,
    method: string,
    params: unknown,
  ): Promise<JsonRpcResponse> {
    if (this.#pending.has(id)) {
      throw new Error('The JSON-RPC test client cannot reuse an outstanding ID.');
    }
    const operation = new Promise<JsonRpcResponse>((resolveResponse, reject) => {
      this.#pending.set(id, { resolve: resolveResponse, reject });
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return withDeadline(operation, 12_000, `JSON-RPC request ${id}`);
  }

  public notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: object): void {
    const stdin = this.#child.stdin;
    if (stdin === null || stdin.destroyed) {
      throw new Error(
        `The instrumented bridge stdin pipe is unavailable (exit=${String(
          this.#child.exitCode,
        )}, signal=${String(this.#child.signalCode)}).`,
      );
    }
    stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  private accept(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      const response = parseJsonRpcResponse(line);
      this.messages.push(response);
      const pending = this.#pending.get(response.id);
      if (pending !== undefined) {
        this.#pending.delete(response.id);
        pending.resolve(response);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRpcResponse(line: string): JsonRpcResponse {
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    value['jsonrpc'] !== '2.0' ||
    typeof value['id'] !== 'number' ||
    !Number.isSafeInteger(value['id']) ||
    value['id'] < 0
  ) {
    throw new Error('Bridge stdout contained a non-JSON-RPC response line.');
  }
  return {
    jsonrpc: '2.0',
    id: value['id'],
    ...('result' in value ? { result: value['result'] } : {}),
    ...('error' in value ? { error: value['error'] } : {}),
  };
}

function parseGuardEvent(value: unknown): GuardEvent | undefined {
  if (
    !isRecord(value) ||
    value['source'] !== 'vscode-mcp-runtime-security-guard' ||
    typeof value['api'] !== 'string' ||
    (value['classification'] !== 'forbidden' &&
      value['classification'] !== 'instrumentation' &&
      value['classification'] !== 'local-ipc' &&
      value['classification'] !== 'runtime-infrastructure')
  ) {
    return undefined;
  }
  return {
    source: 'vscode-mcp-runtime-security-guard',
    api: value['api'],
    classification: value['classification'],
  };
}

function createPendingToolCall(): PendingToolCall {
  let resolveStarted: (() => void) | undefined;
  let resolveAborted: (() => void) | undefined;
  let resolveReleased: ((value: unknown) => void) | undefined;
  const started = new Promise<void>((resolvePromise) => {
    resolveStarted = resolvePromise;
  });
  const aborted = new Promise<void>((resolvePromise) => {
    resolveAborted = resolvePromise;
  });
  const released = new Promise<unknown>((resolvePromise) => {
    resolveReleased = resolvePromise;
  });
  return {
    started,
    aborted,
    start: () => resolveStarted?.(),
    abort: () => resolveAborted?.(),
    release: () => resolveReleased?.(editorContextSuccess()),
    waitForRelease: () => released,
  };
}

function editorContextSuccess(): unknown {
  return {
    outcome: 'success',
    observedAt: '2026-07-10T00:00:00.000Z',
    truncated: false,
    warnings: [],
    payload: {
      tool: 'get_editor_context',
      result: {
        activeEditor: null,
        visibleEditors: [],
        openDocuments: [],
        tabs: [],
        omitted: { editors: 0, documents: 0, tabs: 0 },
      },
    },
  };
}

function readDocumentSuccess(
  invocation: V1AllExtensionToolInvocation,
  workspacePath: string,
  sourceCanary: string,
): unknown {
  if (invocation.tool !== 'read_document') {
    throw new Error('The success fixture expected read_document.');
  }
  const result: ReadDocumentResult = {
    document: {
      uri: pathToFileURL(join(workspacePath, 'REQUEST_BODY_CANARY.ts')).href,
      workspaceFolderId: 'root',
      relativePath: 'REQUEST_BODY_CANARY.ts',
      languageId: 'typescript',
      documentVersion: 1,
      isDirty: true,
    },
    eol: 'LF',
    totalLineCount: 1,
    returnedRange: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: sourceCanary.length },
    },
    text: sourceCanary,
    hasMore: false,
    nextStartLine: null,
  };
  return {
    outcome: 'success',
    observedAt: '2026-07-10T00:00:00.000Z',
    truncated: false,
    warnings: [],
    payload: { tool: invocation.tool, result },
  };
}

async function onlyRegistrySnapshot(
  runtimeEnvironment: RuntimeRegistryEnvironment,
): Promise<RegistryRecordSnapshot> {
  const resolution = await resolveRuntimeRegistryPaths(runtimeEnvironment);
  if (resolution.status !== 'ready') {
    throw new Error('The runtime instrumentation registry is unavailable.');
  }
  const discovery = await discoverRegistryRecords(resolution.paths);
  if (discovery.status !== 'ready' || discovery.records.length !== 1) {
    throw new Error('Expected one runtime instrumentation registry record.');
  }
  const snapshot = discovery.records[0];
  if (snapshot === undefined) {
    throw new Error('The runtime instrumentation registry record is missing.');
  }
  return snapshot;
}

async function buildBridgeBundle(buildDirectory: string): Promise<string> {
  const repositoryRoot = resolve(process.cwd());
  const output = join(buildDirectory, 'instrumented-cli.mjs');
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ['packages/server/src/cli.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: output,
    logLevel: 'silent',
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
  });
  return output;
}

function spawnInstrumentedBridge(
  bundlePath: string,
  workspacePath: string,
  xdgRuntimeDirectory: string,
  environmentCanary: string,
): {
  readonly child: ChildProcess;
  readonly guardEvents: GuardEvent[];
  readonly guardReady: Promise<void>;
  readonly stderr: () => string;
} {
  const preloadPath = resolve(
    process.cwd(),
    'packages/extension/src/test-support/runtime-security-preload.mjs',
  );
  const child = spawn(process.execPath, ['--import', preloadPath, bundlePath], {
    cwd: workspacePath,
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: xdgRuntimeDirectory,
      VSCODE_MCP_RUNTIME_ENV_CANARY: environmentCanary,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  const guardEvents: GuardEvent[] = [];
  let markReady: (() => void) | undefined;
  const guardReady = new Promise<void>((resolvePromise) => {
    markReady = resolvePromise;
  });
  child.on('message', (message: unknown) => {
    const event = parseGuardEvent(message);
    if (event === undefined) {
      return;
    }
    guardEvents.push(event);
    if (event.api === 'guard.ready') {
      markReady?.();
    }
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    guardEvents,
    guardReady: withDeadline(guardReady, 5_000, 'runtime guard startup'),
    stderr: () => stderr,
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, 'exit').then(() => undefined);
  child.kill('SIGTERM');
  await withDeadline(exited, 5_000, 'instrumented bridge shutdown').catch(() => {
    child.kill('SIGKILL');
  });
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolvePromise, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not complete before its test deadline.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(path) : [path];
    }),
  );
  return nested.flat().sort();
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('The POSIX runtime instrumentation requires a current uid.');
  }
  return process.getuid();
}

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

describePosix('M1-LOG-001/003 and M1-NET-001/002 runtime instrumentation', () => {
  it('serves success and sanitized failures over local IPC without network, telemetry, command, or persistent-log APIs', async () => {
    const sourceCanary = 'SOURCE_CONTENT_CANARY_runtime_8f12';
    const thrownCanary = 'PROVIDER_THROW_CANARY_runtime_452a';
    const selectionCanary = 'SELECTION_TEXT_CANARY_runtime_29f0';
    const hoverCanary = 'HOVER_TEXT_CANARY_runtime_e19b';
    const diagnosticCanary = 'DIAGNOSTIC_TEXT_CANARY_runtime_f79a';
    const requestBodyCanary = 'REQUEST_BODY_CANARY';
    const environmentCanary = 'ENVIRONMENT_CANARY_runtime_91cd';
    const usernameCanary = 'USERNAME_CANARY_runtime_a713';
    const runtimeFixture = await mkdtemp(join('/tmp', 'vscode-mcp-runtime-security-'));
    const buildFixture = await mkdtemp(join('/tmp', 'vscode-mcp-guard-build-'));
    fixtures.push(runtimeFixture, buildFixture);
    const xdgRuntimeDirectory = join(runtimeFixture, 'xdg');
    const workspacePath = join(runtimeFixture, usernameCanary, 'workspace');
    await mkdir(xdgRuntimeDirectory, { mode: 0o700 });
    await mkdir(workspacePath, { mode: 0o700, recursive: true });
    await chmod(xdgRuntimeDirectory, 0o700);
    const canonicalWorkspacePath = await realpath(workspacePath);

    const runtimeEnvironment: RuntimeRegistryEnvironment = {
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      uid: currentUid(),
      xdgRuntimeDirectory,
      temporaryDirectory: runtimeFixture,
    };

    let behavior: 'success' | 'internal-error' | 'pending' = 'success';
    let pendingCall: PendingToolCall | undefined;
    let handlerInvocationCount = 0;
    const callTool: IpcCallToolHandler = async (invocation, signal) => {
      handlerInvocationCount += 1;
      if (behavior === 'success') {
        return readDocumentSuccess(invocation, workspacePath, sourceCanary);
      }
      if (behavior === 'internal-error') {
        throw new Error(
          [
            thrownCanary,
            selectionCanary,
            hoverCanary,
            diagnosticCanary,
            requestBodyCanary,
          ].join('|'),
        );
      }
      const pending = pendingCall;
      if (pending === undefined) {
        throw new Error('The pending runtime fixture was not prepared.');
      }
      pending.start();
      signal.addEventListener('abort', pending.abort, { once: true });
      return pending.waitForRelease();
    };

    const service = new IpcInstanceService({
      identity: {
        extensionVersion: '1.0.0-runtime-test',
        displayName: usernameCanary,
        workspaceFingerprint: 'd'.repeat(64),
        workspaceFileUri: null,
        workspaceFolders: [
          {
            workspaceFolderId: 'root',
            name: usernameCanary,
            uri: pathToFileURL(workspacePath).href,
            canonicalPath: canonicalWorkspacePath,
          },
        ],
      },
      runtimeEnvironment,
      isEligible: () => true,
      extensionTools: ['get_editor_context', 'read_document'],
      callTool,
    });
    services.push(service);
    const start = await service.start();
    expect(start.status).toBe('ready');
    const snapshot = await onlyRegistrySnapshot(runtimeEnvironment);
    expect(snapshot.record.endpoint.kind).toBe('unix');
    const endpointStats = await lstat(snapshot.record.endpoint.path);
    expect(endpointStats.isSocket()).toBe(true);
    expect(endpointStats.mode & 0o777).toBe(0o600);

    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Parent runtime fetch is forbidden.'));

    const bundlePath = await buildBridgeBundle(buildFixture);
    const instrumented = spawnInstrumentedBridge(
      bundlePath,
      workspacePath,
      xdgRuntimeDirectory,
      environmentCanary,
    );
    await instrumented.guardReady;
    const client = new JsonLineRpcClient(instrumented.child);

    const initialize = await client.request(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'runtime-security-test', version: '1.0.0' },
    });
    expect(initialize.error).toBeUndefined();
    client.notify('notifications/initialized', {});

    const instances = await client.request(2, 'tools/call', {
      name: 'list_instances',
      arguments: {},
    });
    if (!JSON.stringify(instances.result).includes(snapshot.record.instanceId)) {
      throw new Error(
        `The instrumented bridge did not authenticate the fixture: ${JSON.stringify({
          guardEvents: instrumented.guardEvents,
          stderr: instrumented.stderr(),
        })}`,
      );
    }
    expect(JSON.stringify(instances.result)).toContain(snapshot.record.instanceId);

    const success = await client.request(3, 'tools/call', {
      name: 'read_document',
      arguments: {
        document: {
          kind: 'workspacePath',
          workspaceFolderId: 'root',
          relativePath: 'REQUEST_BODY_CANARY.ts',
        },
      },
    });
    expect(JSON.stringify(success.result)).toContain(sourceCanary);

    behavior = 'internal-error';
    const internalFailure = await client.request(4, 'tools/call', {
      name: 'read_document',
      arguments: {
        document: {
          kind: 'workspacePath',
          workspaceFolderId: 'root',
          relativePath: 'REQUEST_BODY_CANARY.ts',
        },
      },
    });
    expect(JSON.stringify(internalFailure.result)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(internalFailure)).not.toContain(thrownCanary);

    const invocationsBeforeArbitraryCommand = handlerInvocationCount;
    const arbitraryCommand = await client.request(5, 'tools/call', {
      name: 'vscode.executeCommand',
      arguments: {
        command: 'workbench.action.terminal.new',
        executable: '/bin/sh',
      },
    });
    expect(arbitraryCommand.error).toBeUndefined();
    expect(JSON.stringify(arbitraryCommand.result)).toContain(
      'Tool vscode.executeCommand not found',
    );
    expect(handlerInvocationCount).toBe(invocationsBeforeArbitraryCommand);

    behavior = 'pending';
    pendingCall = createPendingToolCall();
    const timedOut = client.request(6, 'tools/call', {
      name: 'get_editor_context',
      arguments: {},
    });
    await withDeadline(pendingCall.started, 3_000, 'timeout handler startup');
    const timeoutResponse = await timedOut;
    expect(JSON.stringify(timeoutResponse.result)).toContain('TIMEOUT');
    await withDeadline(pendingCall.aborted, 1_000, 'timeout cancellation');
    pendingCall.release();

    pendingCall = createPendingToolCall();
    const cancelled = client
      .request(7, 'tools/call', {
        name: 'get_editor_context',
        arguments: {},
      })
      .catch(() => undefined);
    await withDeadline(pendingCall.started, 3_000, 'cancel handler startup');
    client.notify('notifications/cancelled', {
      requestId: 7,
      reason: 'REQUEST_BODY_CANARY_cancel',
    });
    await withDeadline(pendingCall.aborted, 1_000, 'active request cancellation');
    pendingCall.release();
    const cancelledResponse = await Promise.race([
      cancelled,
      new Promise<undefined>((resolvePromise) => {
        setTimeout(() => resolvePromise(undefined), 100);
      }),
    ]);
    if (cancelledResponse !== undefined) {
      expect(JSON.stringify(cancelledResponse.result)).toContain('CANCELLED');
    }

    const resolution = await resolveRuntimeRegistryPaths(runtimeEnvironment);
    if (resolution.status !== 'ready') {
      throw new Error('The runtime instrumentation paths disappeared.');
    }
    const recordPath = join(
      resolution.paths.instancesDirectory,
      `${snapshot.record.instanceId}.json`,
    );
    const stored: unknown = JSON.parse(await readFile(recordPath, 'utf8'));
    if (!isRecord(stored)) {
      throw new Error('The runtime instrumentation record became invalid.');
    }
    const wrongToken = snapshot.record.authToken.startsWith('A')
      ? `B${snapshot.record.authToken.slice(1)}`
      : `A${snapshot.record.authToken.slice(1)}`;
    await writeFile(recordPath, JSON.stringify({ ...stored, authToken: wrongToken }), {
      mode: 0o600,
    });
    if (instrumented.child.exitCode !== null) {
      const redactedStderr = [
        sourceCanary,
        thrownCanary,
        selectionCanary,
        hoverCanary,
        diagnosticCanary,
        requestBodyCanary,
        environmentCanary,
        usernameCanary,
        snapshot.record.authToken,
        snapshot.record.endpoint.path,
        workspacePath,
        runtimeFixture,
      ].reduce(
        (text, sensitive) => text.replaceAll(sensitive, '[redacted]'),
        instrumented.stderr(),
      );
      throw new Error(
        `The instrumented bridge exited early (${String(
          instrumented.child.exitCode,
        )}): ${redactedStderr}`,
      );
    }
    const authFailure = await client.request(8, 'tools/call', {
      name: 'list_instances',
      arguments: {},
    });
    expect(JSON.stringify(authFailure.result)).not.toContain(
      snapshot.record.instanceId,
    );
    await writeFile(recordPath, JSON.stringify(stored), { mode: 0o600 });

    await stopChild(instrumented.child);
    await service.stop();

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(
      instrumented.guardEvents.filter((event) => event.classification === 'forbidden'),
    ).toEqual([]);
    const localIpcEvents = instrumented.guardEvents.filter(
      (event) => event.classification === 'local-ipc',
    );
    expect(localIpcEvents.length).toBeGreaterThanOrEqual(6);
    expect(new Set(localIpcEvents.map((event) => event.api))).toEqual(
      new Set(['node:net.Socket.connect', 'node:net.createConnection']),
    );

    const stderr = instrumented.stderr();
    expect(stderr).toBe('');
    for (const canary of [
      sourceCanary,
      thrownCanary,
      selectionCanary,
      hoverCanary,
      diagnosticCanary,
      requestBodyCanary,
      environmentCanary,
      usernameCanary,
      snapshot.record.authToken,
      wrongToken,
      snapshot.record.endpoint.path,
      workspacePath,
    ]) {
      expect(stderr).not.toContain(canary);
      expect(JSON.stringify(internalFailure)).not.toContain(canary);
      expect(JSON.stringify(timeoutResponse)).not.toContain(canary);
      expect(JSON.stringify(cancelledResponse ?? {})).not.toContain(canary);
      expect(JSON.stringify(authFailure)).not.toContain(canary);
    }

    expect(client.messages.length).toBeGreaterThanOrEqual(7);
    expect(client.messages.length).toBeLessThanOrEqual(8);
    expect(await collectFiles(runtimeFixture)).toEqual([]);
    expect(PROTOCOL_LIMITS.simpleOperationTimeoutMs).toBe(5_000);
  }, 30_000);
});
