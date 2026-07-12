import { Buffer } from 'node:buffer';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { PROTOCOL_LIMITS } from '@vscode-mcp/protocol/constants';
import { describe, expect, it } from 'vitest';

import { resolveBridgeRuntimeOptions } from './cli-options.js';
import { assertSerializedToolArgumentsWithinLimit } from './sdk-adapter.js';

describe('server input and selector acceptance', () => {
  it('M1-LIM-001 accepts exactly 256 KiB of serialized arguments and rejects plus one before IPC', () => {
    expect(PROTOCOL_LIMITS.mcpToolArgumentsBytes).toBe(256 * 1_024);
    const exact = objectSizedTo(PROTOCOL_LIMITS.mcpToolArgumentsBytes);
    const plusOne = objectSizedTo(PROTOCOL_LIMITS.mcpToolArgumentsBytes + 1);

    expect(serializedBytes(exact)).toBe(PROTOCOL_LIMITS.mcpToolArgumentsBytes);
    expect(() => assertSerializedToolArgumentsWithinLimit(exact)).not.toThrow();

    let failure: unknown;
    try {
      assertSerializedToolArgumentsWithinLimit(plusOne);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: 'MCP error -32602: Tool arguments exceed the serialized input limit.',
      data: undefined,
    });
    expect(String(failure)).not.toContain('ARGUMENT_CONTENT_CANARY');
  });

  it.each([
    'friendly-window',
    'Workspace One',
    'workspace/root',
    'root-1',
    'a'.repeat(64),
  ])('M1-SEL-006 rejects alias-shaped --instance value %j', async (alias) => {
    await expect(
      resolveBridgeRuntimeOptions(['--instance', alias], process.cwd(), 'linux'),
    ).rejects.toBeInstanceOf(Error);
  });
});

function objectSizedTo(targetBytes: number): Record<string, string> {
  const value = { marker: '' };
  const overhead = serializedBytes(value);
  if (targetBytes < overhead) {
    throw new Error('The requested argument fixture is too small.');
  }
  value.marker = 'ARGUMENT_CONTENT_CANARY'.padEnd(targetBytes - overhead, 'x');
  if (serializedBytes(value) !== targetBytes) {
    throw new Error('The argument fixture could not reach the requested byte size.');
  }
  return value;
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('The test value was not serializable.');
  }
  return Buffer.byteLength(serialized, 'utf8');
}
