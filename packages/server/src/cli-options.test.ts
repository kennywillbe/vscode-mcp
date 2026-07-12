import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BridgeConfigurationError,
  resolveBridgeRuntimeOptions,
} from './cli-options.js';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('bridge CLI options', () => {
  it('defaults to an unbounded selector with canonical cwd', async () => {
    const fixture = await createFixture();
    const options = await resolveBridgeRuntimeOptions([], fixture, 'darwin');

    expect(options.upperBound).toEqual({ kind: 'unbounded' });
    expect(options.canonicalCwd).toBe(await realpath(fixture));
  });

  it('accepts a single instance selector', async () => {
    const fixture = await createFixture();
    const instanceId = '00000000-0000-4000-8000-000000000000';
    const options = await resolveBridgeRuntimeOptions(
      ['--instance', instanceId],
      fixture,
      'linux',
    );

    expect(options.upperBound).toEqual({ kind: 'instance', instanceId });
  });

  it('canonicalizes an absolute workspace selector', async () => {
    const fixture = await createFixture();
    const options = await resolveBridgeRuntimeOptions(
      ['--workspace', fixture],
      fixture,
      'linux',
    );

    expect(options.upperBound).toEqual({
      kind: 'workspace',
      canonicalWorkspacePath: await realpath(fixture),
    });
  });

  it('rejects unknown, duplicate, malformed, and relative selectors', async () => {
    const fixture = await createFixture();
    const cases = [
      ['--unknown'],
      ['--instance'],
      ['--instance', 'not-a-uuid'],
      ['--workspace', 'relative/path'],
      ['--instance', '00000000-0000-4000-8000-000000000000', '--workspace', fixture],
    ];

    for (const arguments_ of cases) {
      await expect(
        resolveBridgeRuntimeOptions(arguments_, fixture, 'linux'),
      ).rejects.toBeInstanceOf(Error);
    }
    await expect(
      resolveBridgeRuntimeOptions(['--unknown'], fixture, 'linux'),
    ).rejects.toBeInstanceOf(BridgeConfigurationError);
  });
});

async function createFixture(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), 'vscode-mcp-cli-options-'));
  fixtures.push(fixture);
  return fixture;
}
