import process from 'node:process';

import { defineConfig } from '@vscode/test-cli';

const extensionDevelopmentPath = requiredEnvironment('VSCODE_MCP_ARTIFACT_HARNESS');
const runtimeDirectory = requiredEnvironment('VSCODE_MCP_ARTIFACT_RUNTIME');
const vsix = requiredEnvironment('VSCODE_MCP_ARTIFACT_VSIX');

export default defineConfig({
  env: {
    XDG_RUNTIME_DIR: runtimeDirectory,
  },
  files: 'out/**/*.test.js',
  version: process.env['VSCODE_TEST_VERSION'] ?? 'stable',
  launchArgs: process.platform === 'linux' ? ['--disable-gpu'] : [],
  extensionDevelopmentPath,
  installExtensions: [vsix],
  workspaceFolder: '../../fixtures/extension-host.code-workspace',
  mocha: {
    timeout: 20_000,
  },
});

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for packaged-artifact tests.`);
  }
  return value;
}
