import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_BUNDLED_SERVER_BYTES = 4 * 1024 * 1024;
const MAX_NODE_CANDIDATES = 64;
const NODE_CHECK_TIMEOUT_MS = 5_000;
const EXPECTED_NODE_ENGINE = '^22.13.0';
const MANAGED_BEGIN = '# >>> vscode-mcp managed configuration >>>';
const MANAGED_END = '# <<< vscode-mcp managed configuration <<<';
const CODEX_TABLE_PATTERN =
  /^\s*\[mcp_servers\.(?:vscode_mcp|vscode-mcp|"vscode-mcp"|'vscode-mcp')\]\s*$/mu;

export interface BundledServerManifest {
  readonly schemaVersion: 1;
  readonly productVersion: string;
  readonly nodeEngine: string;
  readonly cli: {
    readonly file: 'cli.mjs';
    readonly sha256: string;
  };
}

export interface CodexConfigPlan {
  readonly status: 'create' | 'append' | 'replace' | 'remove' | 'unchanged';
  readonly previous: string;
  readonly next: string;
}

export interface CompatibleNode {
  readonly executable: string;
  readonly version: string;
}

export function codexConfigPath(environment: NodeJS.ProcessEnv): string {
  const configured = environment['CODEX_HOME'];
  if (configured !== undefined && !path.isAbsolute(configured)) {
    throw new Error('CODEX_HOME must be an absolute path for automatic setup.');
  }
  const root = configured ?? path.join(homedir(), '.codex');
  return path.join(root, 'config.toml');
}

export function createCodexManagedBlock(
  nodeExecutable: string,
  serverPath: string,
): string {
  return [
    MANAGED_BEGIN,
    '[mcp_servers.vscode_mcp]',
    `command = ${tomlString(nodeExecutable)}`,
    `args = [${tomlString(serverPath)}]`,
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 120',
    'default_tools_approval_mode = "writes"',
    MANAGED_END,
  ].join('\n');
}

export function createGenericMcpConfig(
  nodeExecutable: string,
  serverPath: string,
): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        'vscode-mcp': {
          command: nodeExecutable,
          args: [serverPath],
        },
      },
    },
    undefined,
    2,
  )}\n`;
}

export function planCodexConfigUpdate(
  previous: string,
  managedBlock: string,
): CodexConfigPlan {
  const range = managedRange(previous);
  if (range === 'malformed') {
    throw new Error('Codex config contains malformed vscode-mcp ownership markers.');
  }
  if (range !== undefined) {
    const next = `${previous.slice(0, range.start)}${managedBlock}${previous.slice(range.end)}`;
    return {
      status: next === previous ? 'unchanged' : 'replace',
      previous,
      next,
    };
  }
  if (CODEX_TABLE_PATTERN.test(previous)) {
    throw new Error(
      'Codex config already contains a manually managed vscode-mcp server table.',
    );
  }
  const separator =
    previous.length === 0
      ? ''
      : previous.endsWith('\n\n')
        ? ''
        : previous.endsWith('\n')
          ? '\n'
          : '\n\n';
  return {
    status: previous.length === 0 ? 'create' : 'append',
    previous,
    next: `${previous}${separator}${managedBlock}\n`,
  };
}

export function planCodexConfigRemoval(previous: string): CodexConfigPlan {
  const range = managedRange(previous);
  if (range === 'malformed') {
    throw new Error('Codex config contains malformed vscode-mcp ownership markers.');
  }
  if (range === undefined) {
    return { status: 'unchanged', previous, next: previous };
  }
  const before = previous.slice(0, range.start).trimEnd();
  const after = previous.slice(range.end).trimStart();
  const next =
    before.length === 0
      ? after
      : after.length === 0
        ? `${before}\n`
        : `${before}\n\n${after}`;
  return { status: 'remove', previous, next };
}

export async function readCodexConfig(configPath: string): Promise<string> {
  try {
    return (await readBoundedNoFollow(configPath, MAX_CONFIG_BYTES)).toString('utf8');
  } catch (error) {
    if (isNotFound(error)) return '';
    if (isSymlinkLoop(error)) {
      throw new Error('Codex config must be a regular non-symlink file.');
    }
    throw error;
  }
}

export async function applyCodexConfigPlan(
  configPath: string,
  plan: CodexConfigPlan,
): Promise<string | undefined> {
  if (plan.status === 'unchanged') return undefined;
  const directory = path.dirname(configPath);
  await ensurePrivateDirectory(directory);
  const current = await readCodexConfig(configPath);
  if (current !== plan.previous) {
    throw new Error('Codex config changed after preview; review and retry.');
  }

  let backupPath: string | undefined;
  if (current.length > 0) {
    backupPath = await createExclusiveBackup(configPath, current);
  }

  const temporaryPath = path.join(
    directory,
    `.config.toml.vscode-mcp.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, plan.next, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return backupPath;
}

export async function installBundledServer(options: {
  readonly bundleDirectory: string;
  readonly storageDirectory: string;
  readonly extensionVersion: string;
}): Promise<string> {
  const manifestPath = path.join(options.bundleDirectory, 'manifest.json');
  const cliPath = path.join(options.bundleDirectory, 'cli.mjs');
  const [manifestContents, cliContents] = await Promise.all([
    readBoundedRegularFile(manifestPath, 64 * 1024),
    readBoundedRegularFile(cliPath, MAX_BUNDLED_SERVER_BYTES),
  ]);
  const manifest = parseBundledServerManifest(manifestContents);
  if (manifest.productVersion !== options.extensionVersion) {
    throw new Error('Bundled server version does not match the extension.');
  }
  if (manifest.nodeEngine !== EXPECTED_NODE_ENGINE) {
    throw new Error('Bundled server Node.js contract does not match the extension.');
  }
  if (sha256(cliContents) !== manifest.cli.sha256) {
    throw new Error('Bundled server failed SHA-256 verification.');
  }

  const serverRoot = path.join(options.storageDirectory, 'server');
  const finalDirectory = path.join(serverRoot, options.extensionVersion);
  const finalCliPath = path.join(finalDirectory, manifest.cli.file);
  await ensurePrivateDirectory(options.storageDirectory);
  await ensurePrivateDirectory(serverRoot);

  if (await installedServerMatches(finalDirectory, manifest, cliContents)) {
    return finalCliPath;
  }
  await removeOwnedDirectory(finalDirectory);

  const temporaryDirectory = path.join(
    serverRoot,
    `.${options.extensionVersion}.${randomUUID()}.tmp`,
  );
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    await writeFile(path.join(temporaryDirectory, 'cli.mjs'), cliContents, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(path.join(temporaryDirectory, 'manifest.json'), manifestContents, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryDirectory, finalDirectory);
  } finally {
    await removeOwnedDirectory(temporaryDirectory);
  }
  return finalCliPath;
}

export async function removeInstalledServers(storageDirectory: string): Promise<void> {
  await removeOwnedDirectory(path.join(storageDirectory, 'server'));
}

export async function findCompatibleNodes(
  environment: NodeJS.ProcessEnv,
): Promise<readonly CompatibleNode[]> {
  const candidates = await nodeCandidates(environment);
  const results: CompatibleNode[] = [];
  for (const candidate of candidates.slice(0, MAX_NODE_CANDIDATES)) {
    const inspected = await inspectNodeExecutable(candidate);
    if (inspected !== undefined) results.push(inspected);
  }
  return results;
}

export async function inspectNodeExecutable(
  executable: string,
): Promise<CompatibleNode | undefined> {
  let canonical: string;
  try {
    await access(executable, fsConstants.X_OK);
    canonical = await realpath(executable);
  } catch {
    return undefined;
  }
  const version = await runVersionCommand(canonical);
  if (version === undefined || !isSupportedNodeVersion(version)) return undefined;
  return { executable: canonical, version };
}

function managedRange(
  value: string,
): { start: number; end: number } | 'malformed' | undefined {
  const begin = value.indexOf(MANAGED_BEGIN);
  const end = value.indexOf(MANAGED_END);
  if (begin === -1 && end === -1) return undefined;
  if (begin === -1 || end === -1 || end < begin) return 'malformed';
  if (
    value.indexOf(MANAGED_BEGIN, begin + MANAGED_BEGIN.length) !== -1 ||
    value.indexOf(MANAGED_END, end + MANAGED_END.length) !== -1
  ) {
    return 'malformed';
  }
  let rangeEnd = end + MANAGED_END.length;
  if (value[rangeEnd] === '\r' && value[rangeEnd + 1] === '\n') rangeEnd += 2;
  else if (value[rangeEnd] === '\n') rangeEnd += 1;
  return { start: begin, end: rangeEnd };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      throw new Error('Setup directory must be a regular non-symlink directory.');
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function createExclusiveBackup(
  configPath: string,
  reviewedContents: string,
): Promise<string> {
  const suffix = new Date()
    .toISOString()
    .replace(/[^0-9]/gu, '')
    .slice(0, 17);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const discriminator = attempt === 0 ? '' : `.${String(attempt)}`;
    const candidate = `${configPath}.vscode-mcp.backup.${suffix}${discriminator}`;
    try {
      await writeFile(candidate, reviewedContents, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new Error('Could not create an exclusive Codex config backup.');
}

async function readBoundedRegularFile(
  filePath: string,
  limit: number,
): Promise<Buffer> {
  return await readBoundedNoFollow(filePath, limit);
}

async function readBoundedNoFollow(filePath: string, limit: number): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error('Setup input must be a regular non-symlink file.');
    }
    if (metadata.size > limit) {
      throw new Error(`Setup input exceeds the ${String(limit)} byte limit.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseBundledServerManifest(contents: Buffer): BundledServerManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch {
    throw new Error('Bundled server manifest is invalid JSON.');
  }
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    typeof value['productVersion'] !== 'string' ||
    typeof value['nodeEngine'] !== 'string' ||
    !isRecord(value['cli']) ||
    value['cli']['file'] !== 'cli.mjs' ||
    typeof value['cli']['sha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value['cli']['sha256'])
  ) {
    throw new Error('Bundled server manifest does not match the setup contract.');
  }
  return value as unknown as BundledServerManifest;
}

async function installedServerMatches(
  directory: string,
  manifest: BundledServerManifest,
  expectedCli: Buffer,
): Promise<boolean> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const entries = (await readdir(directory)).sort();
    if (entries.join('\0') !== 'cli.mjs\0manifest.json') return false;
    const cli = await readBoundedRegularFile(
      path.join(directory, 'cli.mjs'),
      MAX_BUNDLED_SERVER_BYTES,
    );
    return cli.equals(expectedCli) && sha256(cli) === manifest.cli.sha256;
  } catch {
    return false;
  }
}

async function removeOwnedDirectory(directory: string): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Refusing to remove a non-directory setup path.');
    }
    const quarantine = `${directory}.remove.${randomUUID()}`;
    await rename(directory, quarantine);
    const quarantinedMetadata = await lstat(quarantine);
    if (!quarantinedMetadata.isDirectory() || quarantinedMetadata.isSymbolicLink()) {
      throw new Error('Refusing to remove a raced setup path.');
    }
    await rm(quarantine, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function nodeCandidates(environment: NodeJS.ProcessEnv): Promise<string[]> {
  const candidates: string[] = [];
  const configured = environment['VSCODE_MCP_NODE'];
  if (configured !== undefined && path.isAbsolute(configured))
    candidates.push(configured);
  for (const directory of (environment['PATH'] ?? '').split(path.delimiter)) {
    if (directory.length > 0 && path.isAbsolute(directory))
      candidates.push(path.join(directory, 'node'));
  }
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  const home = homedir();
  candidates.push(
    path.join(home, '.volta', 'bin', 'node'),
    path.join(home, '.asdf', 'shims', 'node'),
  );
  await appendVersionManagerNodes(
    candidates,
    path.join(home, '.nvm', 'versions', 'node'),
    'bin/node',
  );
  await appendVersionManagerNodes(
    candidates,
    path.join(home, '.local', 'share', 'fnm', 'node-versions'),
    'installation/bin/node',
  );
  return [...new Set(candidates)];
}

async function appendVersionManagerNodes(
  candidates: string[],
  root: string,
  suffix: string,
): Promise<void> {
  try {
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 16);
    for (const entry of entries) candidates.push(path.join(root, entry, suffix));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function runVersionCommand(executable: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(executable, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), NODE_CHECK_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (output.length < 128) output += chunk.slice(0, 128 - output.length);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const match = code === 0 ? /^v(\d+\.\d+\.\d+)\s*$/u.exec(output.trim()) : null;
      resolve(match?.[1]);
    });
  });
}

function isSupportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 22 && (minor > 13 || (minor === 13 && patch >= 0));
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'EEXIST';
}

function isSymlinkLoop(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ELOOP';
}
