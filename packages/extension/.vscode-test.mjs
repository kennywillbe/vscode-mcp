import { join } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;

export default defineConfig({
  env: {
    XDG_RUNTIME_DIR: join('/tmp', `vmcp-test-${uid}`),
  },
  files: 'out/**/*.test.js',
  version: process.env['VSCODE_TEST_VERSION'] ?? 'stable',
  launchArgs: ['--disable-gpu'],
  workspaceFolder: '../../fixtures/extension-host.code-workspace',
  mocha: {
    timeout: 20_000,
  },
});
