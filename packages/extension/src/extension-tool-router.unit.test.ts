import {
  IpcCallToolResultSchema,
  type IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas';
import { EXTENSION_TOOL_NAMES } from '@vscode-mcp/protocol/tool-schemas';
import { describe, expect, it, vi } from 'vitest';

import {
  ExtensionToolRouter,
  IMPLEMENTED_EXTENSION_TOOL_NAMES,
  type ExtensionToolProvider,
} from './extension-tool-router.js';

describe('ExtensionToolRouter', () => {
  it('publishes the complete canonical ten-tool capability array', () => {
    expect(IMPLEMENTED_EXTENSION_TOOL_NAMES).toEqual([...EXTENSION_TOOL_NAMES]);
  });

  it('routes by fixed tool name and rejects a mismatched provider response', async () => {
    const calls: string[] = [];
    const providers = EXTENSION_TOOL_NAMES.map((name) =>
      fakeProvider(name, async (invocation) => {
        calls.push(invocationName(invocation));
        return failure(name);
      }),
    );
    const router = new ExtensionToolRouter(providers);

    await expect(
      router.callTool(
        { tool: 'get_hover', arguments: {} },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: 'toolError', tool: 'get_hover' });
    expect(calls).toEqual(['get_hover']);

    const mismatch = providers.map((provider) =>
      provider.names[0] === 'get_hover'
        ? fakeProvider('get_hover', async () => failure('read_document'))
        : provider,
    );
    await expect(
      new ExtensionToolRouter(mismatch).callTool(
        { tool: 'get_hover', arguments: {} },
        new AbortController().signal,
      ),
    ).rejects.toThrow('mismatched');
  });

  it('fails construction for duplicate or incomplete provider sets', () => {
    const complete = EXTENSION_TOOL_NAMES.map((name) => fakeProvider(name, vi.fn()));
    expect(
      () => new ExtensionToolRouter([...complete, fakeProvider('get_hover', vi.fn())]),
    ).toThrow('more than one');
    expect(() => new ExtensionToolRouter(complete.slice(1))).toThrow('incomplete');
  });
});

function fakeProvider(
  name: (typeof EXTENSION_TOOL_NAMES)[number],
  callTool: ExtensionToolProvider['callTool'],
): ExtensionToolProvider {
  return { names: [name], callTool };
}

function invocationName(invocation: unknown): string {
  return typeof invocation === 'object' &&
    invocation !== null &&
    'tool' in invocation &&
    typeof invocation.tool === 'string'
    ? invocation.tool
    : '';
}

function failure(tool: (typeof EXTENSION_TOOL_NAMES)[number]): IpcCallToolResult {
  return IpcCallToolResultSchema.parse({
    outcome: 'toolError',
    tool,
    error: {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The provider is unavailable.',
      retryable: false,
    },
  });
}
