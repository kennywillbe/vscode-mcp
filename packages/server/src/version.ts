import packageManifest from '../package.json' with { type: 'json' };

import { AnyToolContractVersionSchema } from '@vscode-mcp/protocol/schemas';

/** Single source of truth for MCP server and private IPC client identification. */
export const SERVER_VERSION = AnyToolContractVersionSchema.parse(
  packageManifest.version,
);
