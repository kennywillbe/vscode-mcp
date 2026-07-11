import process from 'node:process';

import {
  BridgeConfigurationError,
  resolveBridgeRuntimeOptions,
} from './cli-options.js';
import { LocalInstanceRegistry } from './local-instance-registry.js';
import { connectStdio, createMcpServer } from './sdk-adapter.js';

async function main(): Promise<void> {
  const runtimeOptions = await resolveBridgeRuntimeOptions(
    process.argv.slice(2),
    process.cwd(),
  );
  const server = createMcpServer(new LocalInstanceRegistry(runtimeOptions));

  const close = async (): Promise<void> => {
    await server.close();
  };

  process.once('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });

  await connectStdio(server);
}

try {
  await main();
} catch (error: unknown) {
  const message =
    error instanceof BridgeConfigurationError
      ? error.message
      : 'The bridge could not start.';
  process.stderr.write(`vscode-mcp failed to start: ${message}\n`);
  process.exitCode = 1;
}
