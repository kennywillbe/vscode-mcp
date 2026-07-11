import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/write-apply-spike.js',
  version: process.env['VSCODE_TEST_VERSION'] ?? 'stable',
  workspaceFolder: '../../fixtures/scanner-spike.code-workspace',
  mocha: {
    timeout: 30_000,
  },
});
