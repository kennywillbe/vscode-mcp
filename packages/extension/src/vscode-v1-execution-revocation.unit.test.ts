import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  const taskEndListeners: Array<(event: unknown) => void> = [];
  const workspacePath = process.cwd();
  const uri = {
    scheme: 'file',
    fsPath: workspacePath,
    toString: () => `file://${workspacePath}`,
  };
  interface DebugSession {
    id: string;
    name: string;
    type: string;
    workspaceFolder: typeof folder;
  }
  const folder = { name: 'workspace', uri, index: 0 };
  const debugStartListeners: Array<(session: DebugSession) => void> = [];
  const debugEndListeners: Array<(session: DebugSession) => void> = [];
  return {
    taskEndListeners,
    debugStartListeners,
    debugEndListeners,
    folder,
    task: {
      name: 'build',
      source: 'workspace',
      scope: folder,
      definition: { type: 'shell' },
      group: undefined,
      isBackground: false,
      problemMatchers: [],
      execution: undefined,
    },
    executeTask: vi.fn(),
    startDebugging: vi.fn(),
    stopDebugging: vi.fn(async () => true),
    activeDebugSession: undefined as DebugSession | undefined,
  };
});

vi.mock('vscode', () => ({
  UIKind: { Desktop: 1 },
  TaskScope: { Workspace: 1 },
  ShellExecution: class ShellExecution {},
  ProcessExecution: class ProcessExecution {},
  CustomExecution: class CustomExecution {},
  env: { remoteName: undefined, uiKind: 1 },
  workspace: {
    isTrusted: true,
    name: 'workspace',
    workspaceFile: undefined,
    workspaceFolders: [vscodeMock.folder],
    getConfiguration: () => ({
      get: (key: string) =>
        key === 'configurations'
          ? [{ name: 'Launch app', type: 'node', request: 'launch' }]
          : undefined,
    }),
  },
  tasks: {
    fetchTasks: vi.fn(async () => [vscodeMock.task]),
    executeTask: vscodeMock.executeTask,
    onDidEndTaskProcess: (listener: (event: unknown) => void) => {
      vscodeMock.taskEndListeners.push(listener);
      return { dispose: vi.fn() };
    },
  },
  debug: {
    get activeDebugSession() {
      return vscodeMock.activeDebugSession;
    },
    startDebugging: vscodeMock.startDebugging,
    stopDebugging: vscodeMock.stopDebugging,
    onDidStartDebugSession: (
      listener: (
        session: Parameters<(typeof vscodeMock.debugStartListeners)[number]>[0],
      ) => void,
    ) => {
      vscodeMock.debugStartListeners.push(listener);
      return { dispose: vi.fn() };
    },
    onDidTerminateDebugSession: (
      listener: (
        session: Parameters<(typeof vscodeMock.debugEndListeners)[number]>[0],
      ) => void,
    ) => {
      vscodeMock.debugEndListeners.push(listener);
      return { dispose: vi.fn() };
    },
  },
  languages: { getDiagnostics: () => [] },
}));

import { CapabilityGrantController } from './capability-grant-controller.js';
import { VisualChangeController } from './visual-change-controller.js';
import { VsCodeV1IdeToolService } from './vscode-v1-ide-tool-service.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createService(grants: CapabilityGrantController): VsCodeV1IdeToolService {
  const visualChanges: VisualChangeController = Object.create(
    VisualChangeController.prototype,
  );
  return new VsCodeV1IdeToolService({
    grants,
    isWorkspaceEnabled: () => true,
    visualChanges,
  });
}

async function call(
  service: VsCodeV1IdeToolService,
  tool: string,
  args: Record<string, unknown>,
) {
  return service.callTool({ tool, arguments: args }, new AbortController().signal);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected an object result.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('execution revocation during VS Code startup', () => {
  beforeEach(() => {
    vscodeMock.executeTask.mockReset();
    vscodeMock.startDebugging.mockReset();
    vscodeMock.stopDebugging.mockClear();
    vscodeMock.activeDebugSession = undefined;
    vscodeMock.taskEndListeners.length = 0;
    vscodeMock.debugStartListeners.length = 0;
    vscodeMock.debugEndListeners.length = 0;
  });

  it('terminates a task whose execution handle arrives after revocation', async () => {
    const grants = new CapabilityGrantController();
    grants.grant('execution');
    const service = createService(grants);
    const listed = await call(service, 'list_tasks', {});
    expect(listed.outcome).toBe('success');
    if (listed.outcome !== 'success') throw new Error('Task listing failed.');
    const tasks = record(listed.result)['tasks'];
    if (!Array.isArray(tasks)) throw new Error('Expected listed tasks.');
    const taskId = record(tasks[0])['id'];
    expect(taskId).toBeTypeOf('string');

    const pending = deferred<{ terminate: ReturnType<typeof vi.fn> }>();
    const terminate = vi.fn();
    vscodeMock.executeTask.mockReturnValueOnce(pending.promise);
    const result = call(service, 'run_task', { taskId });
    await vi.waitFor(() => expect(vscodeMock.executeTask).toHaveBeenCalledOnce());
    grants.revoke('execution');
    service.handleCapabilityRevoked('execution');
    pending.resolve({ terminate });

    await expect(result).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'EXECUTION_GRANT_CHANGED' },
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('terminates a task whose execution handle arrives after service disposal', async () => {
    const grants = new CapabilityGrantController();
    grants.grant('execution');
    const service = createService(grants);
    const listed = await call(service, 'list_tasks', {});
    if (listed.outcome !== 'success') throw new Error('Task listing failed.');
    const tasks = record(listed.result)['tasks'];
    if (!Array.isArray(tasks)) throw new Error('Expected listed tasks.');
    const taskId = record(tasks[0])['id'];
    if (typeof taskId !== 'string') throw new Error('Expected a task ID.');

    const pending = deferred<{ terminate: ReturnType<typeof vi.fn> }>();
    const terminate = vi.fn();
    vscodeMock.executeTask.mockReturnValueOnce(pending.promise);
    const result = call(service, 'run_task', { taskId });
    await vi.waitFor(() => expect(vscodeMock.executeTask).toHaveBeenCalledOnce());
    service.dispose();
    pending.resolve({ terminate });

    await expect(result).resolves.toMatchObject({ outcome: 'toolError' });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('stops a debug session reported after revocation while startup is pending', async () => {
    const grants = new CapabilityGrantController();
    grants.grant('execution');
    const service = createService(grants);
    const state = await call(service, 'get_debug_state', {});
    expect(state.outcome).toBe('success');
    if (state.outcome !== 'success') throw new Error('Debug state failed.');
    const configurations = record(state.result)['configurations'];
    if (!Array.isArray(configurations))
      throw new Error('Expected debug configurations.');
    const workspaceFolderId = record(configurations[0])['workspaceFolderId'];
    expect(workspaceFolderId).toBeTypeOf('string');

    const pending = deferred<boolean>();
    vscodeMock.startDebugging.mockReturnValueOnce(pending.promise);
    const result = call(service, 'start_debugging', {
      workspaceFolderId,
      configurationName: 'Launch app',
    });
    await vi.waitFor(() => expect(vscodeMock.startDebugging).toHaveBeenCalledOnce());
    grants.revoke('execution');
    service.handleCapabilityRevoked('execution');
    const session = {
      id: 'late-session',
      name: 'Launch app',
      type: 'node',
      workspaceFolder: vscodeMock.folder,
    };
    vscodeMock.debugStartListeners[0]?.(session);
    pending.resolve(true);

    await expect(result).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'EXECUTION_GRANT_CHANGED' },
    });
    expect(vscodeMock.stopDebugging).toHaveBeenCalledOnce();
    expect(vscodeMock.stopDebugging).toHaveBeenCalledWith(session);
  });

  it('rechecks revocation while waiting for the debug-session event', async () => {
    const grants = new CapabilityGrantController();
    grants.grant('execution');
    const service = createService(grants);
    const state = await call(service, 'get_debug_state', {});
    if (state.outcome !== 'success') throw new Error('Debug state failed.');
    const configurations = record(state.result)['configurations'];
    if (!Array.isArray(configurations))
      throw new Error('Expected debug configurations.');
    const workspaceFolderId = record(configurations[0])['workspaceFolderId'];
    if (typeof workspaceFolderId !== 'string')
      throw new Error('Expected a workspace folder ID.');

    const pending = deferred<boolean>();
    vscodeMock.startDebugging.mockReturnValueOnce(pending.promise);
    const result = call(service, 'start_debugging', {
      workspaceFolderId,
      configurationName: 'Launch app',
    });
    await vi.waitFor(() => expect(vscodeMock.startDebugging).toHaveBeenCalledOnce());
    pending.resolve(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    grants.revoke('execution');
    service.handleCapabilityRevoked('execution');
    const session = {
      id: 'observed-after-revocation',
      name: 'Launch app',
      type: 'node',
      workspaceFolder: vscodeMock.folder,
    };
    vscodeMock.debugStartListeners[0]?.(session);

    await expect(result).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'EXECUTION_GRANT_CHANGED' },
    });
    expect(vscodeMock.stopDebugging).toHaveBeenCalledWith(session);
  });

  it('stops a late debug session after service disposal', async () => {
    const grants = new CapabilityGrantController();
    grants.grant('execution');
    const service = createService(grants);
    const state = await call(service, 'get_debug_state', {});
    if (state.outcome !== 'success') throw new Error('Debug state failed.');
    const configurations = record(state.result)['configurations'];
    if (!Array.isArray(configurations))
      throw new Error('Expected debug configurations.');
    const workspaceFolderId = record(configurations[0])['workspaceFolderId'];
    if (typeof workspaceFolderId !== 'string')
      throw new Error('Expected a workspace folder ID.');

    const pending = deferred<boolean>();
    vscodeMock.startDebugging.mockReturnValueOnce(pending.promise);
    const result = call(service, 'start_debugging', {
      workspaceFolderId,
      configurationName: 'Launch app',
    });
    await vi.waitFor(() => expect(vscodeMock.startDebugging).toHaveBeenCalledOnce());
    service.dispose();
    const session = {
      id: 'observed-after-disposal',
      name: 'Launch app',
      type: 'node',
      workspaceFolder: vscodeMock.folder,
    };
    vscodeMock.debugStartListeners[0]?.(session);
    pending.resolve(true);

    await expect(result).resolves.toMatchObject({ outcome: 'toolError' });
    expect(vscodeMock.stopDebugging).toHaveBeenCalledWith(session);
  });

  it('stops a session that arrives after the observation deadline', async () => {
    const grants = new CapabilityGrantController();
    grants.grant('execution');
    const service = createService(grants);
    const state = await call(service, 'get_debug_state', {});
    if (state.outcome !== 'success') throw new Error('Debug state failed.');
    const configurations = record(state.result)['configurations'];
    if (!Array.isArray(configurations))
      throw new Error('Expected debug configurations.');
    const workspaceFolderId = record(configurations[0])['workspaceFolderId'];
    if (typeof workspaceFolderId !== 'string')
      throw new Error('Expected a workspace folder ID.');

    vscodeMock.startDebugging.mockResolvedValueOnce(true);
    await expect(
      call(service, 'start_debugging', {
        workspaceFolderId,
        configurationName: 'Launch app',
      }),
    ).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'DEBUG_CONFIGURATION_NOT_FOUND' },
    });
    const session = {
      id: 'observed-after-deadline',
      name: 'Launch app',
      type: 'node',
      workspaceFolder: vscodeMock.folder,
    };
    vscodeMock.debugStartListeners[0]?.(session);

    expect(vscodeMock.stopDebugging).toHaveBeenCalledWith(session);
    service.dispose();
  });
});
