import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import {
  BoundedStdioServerTransport,
  BoundedStdioTransportError,
} from './bounded-stdio-transport.js';

function request(id: number, padding = ''): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: { padding },
  };
}

function serialized(message: JSONRPCMessage): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

describe('BoundedStdioServerTransport', () => {
  it('handles fragmented and coalesced newline-delimited messages', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output, 1024);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();

    const first = serialized(request(1));
    input.write(first.subarray(0, 7));
    input.write(Buffer.concat([first.subarray(7), serialized(request(2))]));

    expect(received).toEqual([request(1), request(2)]);
    await transport.close();
  });

  it('accepts the exact byte boundary and rejects one byte over before parsing', async () => {
    const exactMessage = request(1, 'x');
    const baseBytes = Buffer.byteLength(JSON.stringify(exactMessage), 'utf8');
    const maximum = baseBytes + 10;
    const exact = request(1, 'x'.repeat(11));
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(maximum);

    const exactInput = new PassThrough();
    const exactTransport = new BoundedStdioServerTransport(
      exactInput,
      new PassThrough(),
      maximum,
    );
    const onExactMessage = vi.fn();
    exactTransport.onmessage = onExactMessage;
    await exactTransport.start();
    exactInput.write(serialized(exact));
    expect(onExactMessage).toHaveBeenCalledOnce();
    await exactTransport.close();

    const oversizedInput = new PassThrough();
    const oversizedTransport = new BoundedStdioServerTransport(
      oversizedInput,
      new PassThrough(),
      maximum,
    );
    const onError = vi.fn();
    const onMessage = vi.fn();
    oversizedTransport.onerror = onError;
    oversizedTransport.onmessage = onMessage;
    await oversizedTransport.start();
    oversizedInput.write(serialized(request(1, 'x'.repeat(12))));

    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining<Partial<BoundedStdioTransportError>>({
        code: 'MESSAGE_TOO_LARGE',
      }),
    );
  });

  it('closes on malformed UTF-8 or JSON without exposing the input', async () => {
    const input = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, new PassThrough(), 1024);
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);
    await transport.start();

    input.write(Buffer.from([0xff, 0x0a]));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(BoundedStdioTransportError);
    expect(errors[0]?.message).not.toContain('ff');
  });

  it('serializes outbound messages to stdout-compatible newline framing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    const transport = new BoundedStdioServerTransport(input, output, 1024);
    await transport.start();

    await transport.send(request(7));

    expect(Buffer.concat(chunks).toString('utf8')).toBe(
      JSON.stringify(request(7)) + '\n',
    );
    await transport.close();
  });
});
