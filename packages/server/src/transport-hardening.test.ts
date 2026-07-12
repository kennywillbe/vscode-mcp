import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { PROTOCOL_LIMITS } from '@vscode-mcp/protocol/constants';
import { describe, expect, it, vi } from 'vitest';

import {
  BoundedStdioServerTransport,
  type BoundedStdioTransportError,
} from './bounded-stdio-transport.js';

function messageAtSize(byteLength: number): JSONRPCMessage {
  const base: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { padding: '' },
  };
  const baseLength = Buffer.byteLength(JSON.stringify(base), 'utf8');
  if (byteLength < baseLength) {
    throw new Error('The requested MCP fixture size is too small.');
  }
  return {
    ...base,
    params: { padding: 'x'.repeat(byteLength - baseLength) },
  };
}

function framed(message: JSONRPCMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

describe('MCP stdio hard limits', () => {
  it('accepts an exact 256 KiB stdin message and rejects 256 KiB plus one', async () => {
    expect(PROTOCOL_LIMITS.mcpInboundMessageBytes).toBe(256 * 1_024);
    const exactMessage = messageAtSize(PROTOCOL_LIMITS.mcpInboundMessageBytes);
    expect(Buffer.byteLength(JSON.stringify(exactMessage), 'utf8')).toBe(
      PROTOCOL_LIMITS.mcpInboundMessageBytes,
    );

    const exactInput = new PassThrough();
    const exactTransport = new BoundedStdioServerTransport(
      exactInput,
      new PassThrough(),
    );
    const onExactMessage = vi.fn();
    exactTransport.onmessage = onExactMessage;
    await exactTransport.start();
    exactInput.write(framed(exactMessage));
    expect(onExactMessage).toHaveBeenCalledOnce();
    await exactTransport.close();

    const oversizedInput = new PassThrough();
    const oversizedTransport = new BoundedStdioServerTransport(
      oversizedInput,
      new PassThrough(),
    );
    const onOversizedMessage = vi.fn();
    const onError = vi.fn();
    oversizedTransport.onmessage = onOversizedMessage;
    oversizedTransport.onerror = onError;
    await oversizedTransport.start();
    oversizedInput.write(
      framed(messageAtSize(PROTOCOL_LIMITS.mcpInboundMessageBytes + 1)),
    );

    expect(onOversizedMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining<Partial<BoundedStdioTransportError>>({
        code: 'MESSAGE_TOO_LARGE',
        message: 'The MCP message exceeds its byte limit.',
      }),
    );
  });
});
