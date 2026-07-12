import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  resolveRuntimeRegistryPaths,
  type RuntimeRegistryEnvironment,
} from '@vscode-mcp/protocol/runtime-registry';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let buildFixture = '';
let bundlePath = '';
const children = new Set<ChildProcess>();

beforeAll(async () => {
  buildFixture = await mkdtemp(join('/tmp', 'vmcp-log-build-'));
  bundlePath = join(buildFixture, 'cli.mjs');
  await build({
    entryPoints: [resolve(process.cwd(), 'packages/server/src/cli.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: bundlePath,
    logLevel: 'silent',
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
  });
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  children.clear();
  if (buildFixture.length > 0) {
    await rm(buildFixture, { force: true, recursive: true });
  }
});

const describePosix =
  process.platform === 'darwin' || process.platform === 'linux'
    ? describe
    : describe.skip;

describePosix('M1-LOG-002 bridge process logging', () => {
  it('keeps every stdout line valid JSON-RPC while ignoring malformed registry data', async () => {
    const fixture = await mkdtemp(join('/tmp', 'vmcp-log-run-'));
    const xdgRuntimeDirectory = join(fixture, 'xdg');
    const workspace = join(fixture, 'workspace');
    await Promise.all([
      mkdir(xdgRuntimeDirectory, { mode: 0o700 }),
      mkdir(workspace, { mode: 0o700 }),
    ]);
    await chmod(xdgRuntimeDirectory, 0o700);
    const runtime = await resolveRuntimeRegistryPaths(
      runtimeEnvironment(xdgRuntimeDirectory, fixture),
    );
    if (runtime.status !== 'ready') {
      throw new Error('The process logging registry fixture was unavailable.');
    }
    const malformedCanary = 'MALFORMED_REGISTRY_CANARY_71e4';
    const malformedPath = join(
      runtime.paths.instancesDirectory,
      '00000000-0000-4000-8000-000000000001.json',
    );
    await writeFile(malformedPath, `{${malformedCanary}`, { mode: 0o600 });
    await chmod(malformedPath, 0o600);

    const captured = spawnBridge([], workspace, {
      XDG_RUNTIME_DIR: xdgRuntimeDirectory,
    });
    captured.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'log-test', version: '1.0.0' },
      },
    });
    captured.write({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    captured.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_instances', arguments: {} },
    });

    await captured.waitForLines(2);
    await captured.stop();
    const lines = captured.stdoutLines();
    expect(lines).toHaveLength(2);
    expect(lines.map(parseJsonRpcLine).map((message) => message.id)).toEqual([1, 2]);
    expect(lines.every((line) => line.trim().startsWith('{'))).toBe(true);
    expect(captured.stderr()).toBe('');
    expect(captured.stdout()).not.toContain(malformedCanary);
    expect(captured.stderr()).not.toContain(malformedCanary);

    await rm(fixture, { force: true, recursive: true });
  });

  it('writes a sanitized startup failure only to stderr', async () => {
    const fixture = await mkdtemp(join('/tmp', 'vmcp-log-error-'));
    const pathCanary = join(fixture, 'ABSOLUTE_PATH_CANARY_8c21', 'missing');
    const captured = spawnBridge(['--workspace', pathCanary], fixture);
    const exit = await captured.waitForExit();

    expect(exit.code).toBe(1);
    expect(captured.stdoutLines()).toEqual([]);
    expect(captured.stderr()).toBe(
      'vscode-mcp failed to start: The workspace selector cannot be resolved.\n',
    );
    expect(captured.stderr()).not.toContain(pathCanary);
    expect(captured.stderr()).not.toContain('ABSOLUTE_PATH_CANARY_8c21');

    await rm(fixture, { force: true, recursive: true });
  });
});

interface CapturedBridge {
  readonly child: ChildProcess;
  write(message: object): void;
  stdout(): string;
  stderr(): string;
  stdoutLines(): string[];
  waitForLines(count: number): Promise<void>;
  waitForExit(): Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>;
  stop(): Promise<void>;
}

function spawnBridge(
  arguments_: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): CapturedBridge {
  const child = spawn(process.execPath, [bundlePath, ...arguments_], {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const waitForExit = async (): Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { code: child.exitCode, signal: child.signalCode };
    }
    const [code, signal] = await withDeadline(
      once(child, 'exit'),
      5_000,
      'bridge process exit',
    );
    return {
      code: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
    };
  };

  return {
    child,
    write(message) {
      const input = child.stdin;
      if (input === null || input.destroyed) {
        throw new Error('The bridge stdin was unavailable.');
      }
      input.write(`${JSON.stringify(message)}\n`, 'utf8');
    },
    stdout: () => stdout,
    stderr: () => stderr,
    stdoutLines: () =>
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    async waitForLines(count) {
      await withDeadline(
        new Promise<void>((resolvePromise) => {
          const inspect = (): void => {
            const lineCount = stdout
              .split('\n')
              .filter((line) => line.trim().length > 0).length;
            if (lineCount >= count) {
              child.stdout?.removeListener('data', inspect);
              resolvePromise();
            }
          };
          child.stdout?.on('data', inspect);
          inspect();
        }),
        5_000,
        `${count} bridge stdout lines`,
      );
    },
    waitForExit,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      await waitForExit();
    },
  };
}

function parseJsonRpcLine(line: string): { readonly id: number } {
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    value['jsonrpc'] !== '2.0' ||
    typeof value['id'] !== 'number' ||
    !Number.isSafeInteger(value['id']) ||
    value['id'] < 0 ||
    Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')
  ) {
    throw new Error('Bridge stdout contained a non-JSON-RPC response line.');
  }
  return { id: value['id'] };
}

function runtimeEnvironment(
  xdgRuntimeDirectory: string,
  temporaryDirectory: string,
): RuntimeRegistryEnvironment {
  if (typeof process.getuid !== 'function') {
    throw new Error('The process logging fixture requires a POSIX uid.');
  }
  return {
    platform: process.platform,
    uid: process.getuid(),
    xdgRuntimeDirectory,
    temporaryDirectory,
  };
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not complete before the deadline.`)),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
