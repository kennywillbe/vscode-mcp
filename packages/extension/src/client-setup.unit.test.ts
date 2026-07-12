import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyCodexConfigPlan,
  createCodexManagedBlock,
  createGenericMcpConfig,
  inspectNodeExecutable,
  installBundledServer,
  planCodexConfigRemoval,
  planCodexConfigUpdate,
  readCodexConfig,
  removeInstalledServers,
} from './client-setup.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('Codex client setup', () => {
  it('adds, replaces, and removes only the managed TOML block', () => {
    const first = createCodexManagedBlock('/opt/node', '/opt/server.mjs');
    const created = planCodexConfigUpdate('', first);
    expect(created.status).toBe('create');
    expect(created.next).toContain('[mcp_servers.vscode_mcp]');

    const existing = `model = "gpt-test"\n\n${created.next}`;
    const second = createCodexManagedBlock('/new/node', '/new/server.mjs');
    const replaced = planCodexConfigUpdate(existing, second);
    expect(replaced.status).toBe('replace');
    expect(replaced.next).toContain('model = "gpt-test"');
    expect(replaced.next).toContain('/new/server.mjs');
    expect(replaced.next).not.toContain('/opt/server.mjs');

    const removed = planCodexConfigRemoval(replaced.next);
    expect(removed.status).toBe('remove');
    expect(removed.next).toBe('model = "gpt-test"\n');
  });

  it('refuses malformed markers and manually owned server tables', () => {
    expect(() =>
      planCodexConfigUpdate(
        '# >>> vscode-mcp managed configuration >>>\n',
        createCodexManagedBlock('/node', '/server'),
      ),
    ).toThrow(/malformed/u);
    expect(() =>
      planCodexConfigUpdate(
        '[mcp_servers.vscode_mcp]\ncommand = "manual"\n',
        createCodexManagedBlock('/node', '/server'),
      ),
    ).toThrow(/manually managed/u);
  });

  it('creates an exclusive backup and atomically applies a reviewed plan', async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, '.codex', 'config.toml');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, 'model = "existing"\n');
    const plan = planCodexConfigUpdate(
      await readCodexConfig(configPath),
      createCodexManagedBlock('/node', '/server'),
    );

    const backup = await applyCodexConfigPlan(configPath, plan);
    expect(backup).toBeDefined();
    expect(await readFile(backup!, 'utf8')).toBe('model = "existing"\n');
    expect(await readFile(configPath, 'utf8')).toContain('[mcp_servers.vscode_mcp]');
    expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects a config race after preview', async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, 'config.toml');
    await writeFile(configPath, 'first\n');
    const plan = planCodexConfigUpdate(
      'first\n',
      createCodexManagedBlock('/node', '/server'),
    );
    await writeFile(configPath, 'second\n');
    await expect(applyCodexConfigPlan(configPath, plan)).rejects.toThrow(
      /changed after preview/u,
    );
  });

  it('installs only a version-matched SHA-256 verified bundled server', async () => {
    const root = await temporaryDirectory();
    const bundle = path.join(root, 'bundle');
    const storage = path.join(root, 'storage');
    await mkdir(bundle);
    const cli = Buffer.from('#!/usr/bin/env node\n');
    await writeFile(path.join(bundle, 'cli.mjs'), cli);
    await writeFile(
      path.join(bundle, 'manifest.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        productVersion: '1.0.0',
        nodeEngine: '^22.13.0',
        cli: {
          file: 'cli.mjs',
          sha256: createHash('sha256').update(cli).digest('hex'),
        },
      })}\n`,
    );

    const installed = await installBundledServer({
      bundleDirectory: bundle,
      storageDirectory: storage,
      extensionVersion: '1.0.0',
    });
    expect(await readFile(installed)).toEqual(cli);
    expect((await lstat(installed)).mode & 0o777).toBe(0o600);

    await writeFile(path.join(bundle, 'cli.mjs'), 'tampered');
    await expect(
      installBundledServer({
        bundleDirectory: bundle,
        storageDirectory: storage,
        extensionVersion: '1.0.0',
      }),
    ).rejects.toThrow(/SHA-256/u);

    await removeInstalledServers(storage);
    await expect(lstat(path.join(storage, 'server'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('recognizes a compatible Node executable and produces generic JSON', async () => {
    const node = await inspectNodeExecutable(process.execPath);
    expect(node?.version).toMatch(/^22\./u);
    expect(createGenericMcpConfig('/node', '/server')).toContain('"mcpServers"');
  });

  it('does not follow a symlinked config file', async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, 'target');
    const config = path.join(root, 'config.toml');
    await writeFile(target, 'secret');
    await chmod(target, 0o600);
    await import('node:fs/promises').then(({ symlink }) => symlink(target, config));
    await expect(readCodexConfig(config)).rejects.toThrow(/non-symlink/u);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'vscode-mcp-setup-'));
  temporaryDirectories.push(directory);
  return directory;
}
