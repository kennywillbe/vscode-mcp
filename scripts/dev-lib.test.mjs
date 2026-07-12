import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createArtifactTestEnvironment,
  createMcpConfig,
  isVersionInRange,
  parseArtifactTestArguments,
  parseSetupArguments,
  parseVersion,
} from './dev-lib.mjs';

describe('development helpers', () => {
  it('parses semantic versions and enforces supported major ranges', () => {
    expect(parseVersion('22.13.0')).toEqual([22, 13, 0]);
    expect(parseVersion('10.24.0-rc.1')).toEqual([10, 24, 0]);
    expect(parseVersion('not-a-version')).toBeUndefined();
    expect(isVersionInRange('22.13.0', '22.13.0', 23)).toBe(true);
    expect(isVersionInRange('22.12.9', '22.13.0', 23)).toBe(false);
    expect(isVersionInRange('23.0.0', '22.13.0', 23)).toBe(false);
  });

  it('creates an absolute stdio MCP configuration', () => {
    expect(createMcpConfig('./node', './server.mjs')).toEqual({
      mcpServers: {
        vscode: {
          command: path.resolve('./node'),
          args: [path.resolve('./server.mjs')],
        },
      },
    });
  });

  it('accepts only the documented setup arguments', () => {
    expect(parseSetupArguments([])).toEqual({ help: false, install: false });
    expect(parseSetupArguments(['--install'])).toEqual({
      help: false,
      install: true,
    });
    expect(parseSetupArguments(['--', '--install'])).toEqual({
      help: false,
      install: true,
    });
    expect(() => parseSetupArguments(['--force'])).toThrow('Usage:');
  });

  it('accepts either release mode or an explicit local artifact pair', () => {
    expect(parseArtifactTestArguments([])).toEqual({ mode: 'release' });
    expect(
      parseArtifactTestArguments([
        '--vsix',
        './extension.vsix',
        '--server',
        './cli.mjs',
      ]),
    ).toEqual({
      mode: 'local',
      serverPath: path.resolve('./cli.mjs'),
      vsixPath: path.resolve('./extension.vsix'),
    });
    expect(() => parseArtifactTestArguments(['--vsix', './x'])).toThrow('Usage:');
  });

  it('isolates packaged-pair discovery from live VS Code instances', () => {
    expect(
      createArtifactTestEnvironment(
        { PATH: '/bin' },
        {
          harnessPath: '/tmp/harness',
          runtimeDirectory: '/tmp/isolated-runtime',
          serverPath: '/tmp/server.mjs',
          vsixPath: '/tmp/extension.vsix',
        },
      ),
    ).toEqual({
      PATH: '/bin',
      VSCODE_MCP_ARTIFACT_HARNESS: '/tmp/harness',
      VSCODE_MCP_ARTIFACT_RUNTIME: '/tmp/isolated-runtime',
      VSCODE_MCP_ARTIFACT_VSIX: '/tmp/extension.vsix',
      VSCODE_MCP_SERVER_PATH: '/tmp/server.mjs',
    });
  });
});
