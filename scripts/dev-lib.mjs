import path from 'node:path';

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) {
    return undefined;
  }

  return match.slice(1, 4).map(Number);
}

export function isVersionInRange(value, minimum, nextMajor) {
  const parsed = parseVersion(value);
  const lowerBound = parseVersion(minimum);
  if (!parsed || !lowerBound) {
    return false;
  }

  return compareVersions(parsed, lowerBound) >= 0 && parsed[0] < nextMajor;
}

export function createMcpConfig(nodePath, serverPath) {
  return {
    mcpServers: {
      vscode: {
        command: path.resolve(nodePath),
        args: [path.resolve(serverPath)],
      },
    },
  };
}

export function parseSetupArguments(arguments_) {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
  if (normalized.length === 0) {
    return { help: false, install: false };
  }
  if (normalized.length === 1 && normalized[0] === '--install') {
    return { help: false, install: true };
  }
  if (normalized.length === 1 && normalized[0] === '--help') {
    return { help: true, install: false };
  }
  throw new Error('Usage: pnpm setup:local [--install]');
}

export function parseArtifactTestArguments(arguments_) {
  if (arguments_.length === 0) {
    return { mode: 'release' };
  }
  if (
    arguments_.length === 4 &&
    arguments_[0] === '--vsix' &&
    arguments_[1].length > 0 &&
    arguments_[2] === '--server' &&
    arguments_[3].length > 0
  ) {
    return {
      mode: 'local',
      serverPath: path.resolve(arguments_[3]),
      vsixPath: path.resolve(arguments_[1]),
    };
  }
  throw new Error(
    'Usage: node scripts/test-release-artifacts.mjs [--vsix <file.vsix> --server <cli.mjs>]',
  );
}

export function createArtifactTestEnvironment(
  baseEnvironment,
  { harnessPath, runtimeDirectory, serverPath, vsixPath },
) {
  return {
    ...baseEnvironment,
    VSCODE_MCP_ARTIFACT_HARNESS: harnessPath,
    VSCODE_MCP_ARTIFACT_RUNTIME: runtimeDirectory,
    VSCODE_MCP_ARTIFACT_VSIX: vsixPath,
    VSCODE_MCP_SERVER_PATH: serverPath,
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}
