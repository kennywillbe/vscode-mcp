import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';
import { MessageReader, MessageWriter, type Message } from 'vscode-jsonrpc/node';

import {
  BOUNDED_JSON_RPC_HEADER_BYTES,
  BoundedJsonRpcError,
  BoundedJsonRpcMessageReader,
  BoundedJsonRpcMessageWriter,
  type BoundedJsonRpcErrorCode,
} from './bounded-jsonrpc.js';
import { JSON_RPC_VERSION, PROTOCOL_LIMITS } from './constants.js';

type ReaderOutcome = {
  readonly messages: readonly Message[];
  readonly error: Error | undefined;
};

function serialize(value: unknown): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error('Test value is not serializable.');
  }
  return Buffer.from(text, 'utf8');
}

function frameBody(body: Uint8Array, header?: string): Buffer {
  const framingHeader = header ?? `Content-Length: ${body.byteLength}\r\n\r\n`;
  return Buffer.concat([Buffer.from(framingHeader, 'ascii'), body]);
}

function frameMessage(message: unknown, includeContentType = false): Buffer {
  const body = serialize(message);
  const contentType = includeContentType
    ? 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n'
    : '';
  return frameBody(body, `Content-Length: ${body.byteLength}\r\n${contentType}\r\n`);
}

function messageWithSerializedBytes(targetBytes: number): {
  jsonrpc: string;
  payload: string;
} {
  const emptyMessage = { jsonrpc: JSON_RPC_VERSION, payload: '' };
  const emptyBytes = serialize(emptyMessage).byteLength;
  if (targetBytes < emptyBytes) {
    throw new Error('Target is too small for the test message envelope.');
  }

  const message = {
    jsonrpc: JSON_RPC_VERSION,
    payload: 'a'.repeat(targetBytes - emptyBytes),
  };
  if (serialize(message).byteLength !== targetBytes) {
    throw new Error('Test message has an unexpected serialized size.');
  }
  return message;
}

function paddedContentLengthHeader(bodyBytes: number, targetBytes: number): Buffer {
  const prefix = 'Content-Length:';
  const suffix = `${bodyBytes}\r\n\r\n`;
  const paddingBytes =
    targetBytes -
    Buffer.byteLength(prefix, 'ascii') -
    Buffer.byteLength(suffix, 'ascii');
  if (paddingBytes < 0) {
    throw new Error('Target header size is too small.');
  }
  const result = Buffer.from(`${prefix}${' '.repeat(paddingBytes)}${suffix}`, 'ascii');
  if (result.byteLength !== targetBytes) {
    throw new Error('Test header has an unexpected size.');
  }
  return result;
}

async function readChunks(
  chunks: readonly Uint8Array[],
  maximumBodyBytes: number,
): Promise<ReaderOutcome> {
  const stream = new PassThrough();
  const reader = new BoundedJsonRpcMessageReader(stream, maximumBodyBytes);
  const messages: Message[] = [];
  let error: Error | undefined;

  reader.onError((receivedError) => {
    error = receivedError;
  });
  const closed = new Promise<void>((resolve) => {
    reader.onClose(() => {
      resolve();
    });
  });
  reader.listen((message) => {
    messages.push(message);
  });

  for (const chunk of chunks) {
    if (!stream.destroyed) {
      stream.write(chunk);
    }
  }
  if (!stream.destroyed) {
    stream.end();
  }
  await closed;
  return { messages, error };
}

function expectErrorCode(
  error: Error | undefined,
  expectedCode: BoundedJsonRpcErrorCode,
): void {
  expect(error).toBeInstanceOf(BoundedJsonRpcError);
  if (error instanceof BoundedJsonRpcError) {
    expect(error.code).toBe(expectedCode);
  }
}

describe('BoundedJsonRpcMessageReader', () => {
  it('is a vscode-jsonrpc MessageReader', () => {
    const stream = new PassThrough();
    const reader = new BoundedJsonRpcMessageReader(stream, 1_024);
    expect(MessageReader.is(reader)).toBe(true);
    reader.dispose();
    stream.destroy();
  });

  it('accepts a header of exactly 8 KiB', async () => {
    const body = serialize({ jsonrpc: JSON_RPC_VERSION });
    const header = paddedContentLengthHeader(
      body.byteLength,
      BOUNDED_JSON_RPC_HEADER_BYTES,
    );
    const outcome = await readChunks(
      [Buffer.concat([header, body])],
      PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.messages).toEqual([{ jsonrpc: JSON_RPC_VERSION }]);
  });

  it('rejects an 8 KiB plus one-byte header', async () => {
    const body = serialize({ jsonrpc: JSON_RPC_VERSION });
    const header = paddedContentLengthHeader(
      body.byteLength,
      BOUNDED_JSON_RPC_HEADER_BYTES + 1,
    );
    const outcome = await readChunks(
      [Buffer.concat([header, body])],
      PROTOCOL_LIMITS.bridgeToExtensionFrameBytes,
    );

    expectErrorCode(outcome.error, 'HEADER_TOO_LARGE');
    expect(outcome.messages).toEqual([]);
  });

  it.each([
    ['bridge to extension', PROTOCOL_LIMITS.bridgeToExtensionFrameBytes],
    ['extension to bridge', PROTOCOL_LIMITS.extensionToBridgeFrameBytes],
  ])(
    'accepts the exact %s body limit and rejects limit plus one',
    async (_direction, limit) => {
      const exactBody = serialize(messageWithSerializedBytes(limit));
      const exact = await readChunks([frameBody(exactBody)], limit);
      expect(exact.error).toBeUndefined();
      expect(exact.messages).toHaveLength(1);

      const oversizedBody = serialize(messageWithSerializedBytes(limit + 1));
      const oversized = await readChunks([frameBody(oversizedBody)], limit);
      expectErrorCode(oversized.error, 'BODY_TOO_LARGE');
      expect(oversized.messages).toEqual([]);
    },
  );

  it('handles byte-wise fragmentation and coalesced frames', async () => {
    const first = frameMessage({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: 'vscode-mcp/hello',
    });
    const fragmented = Array.from(first, (byte) => Buffer.from([byte]));
    const fragmentedOutcome = await readChunks(fragmented, 4_096);
    expect(fragmentedOutcome.error).toBeUndefined();
    expect(fragmentedOutcome.messages).toHaveLength(1);

    const second = frameMessage({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: {},
    });
    const coalescedOutcome = await readChunks([Buffer.concat([first, second])], 4_096);
    expect(coalescedOutcome.error).toBeUndefined();
    expect(coalescedOutcome.messages).toHaveLength(2);
  });

  it('accepts only the optional UTF-8 vscode-jsonrpc content type', async () => {
    const accepted = await readChunks(
      [frameMessage({ jsonrpc: JSON_RPC_VERSION }, true)],
      1_024,
    );
    expect(accepted.error).toBeUndefined();

    const body = serialize({ jsonrpc: JSON_RPC_VERSION });
    const rejected = await readChunks(
      [
        frameBody(
          body,
          `Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
        ),
      ],
      1_024,
    );
    expectErrorCode(rejected.error, 'INVALID_HEADER');
  });

  it.each([
    [
      'missing Content-Length',
      'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n',
    ],
    ['duplicate Content-Length', 'Content-Length: 1\r\nContent-Length: 1\r\n\r\n'],
    ['unknown header', 'Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n'],
    [
      'duplicate Content-Type',
      'Content-Length: 1\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n',
    ],
    ['negative Content-Length', 'Content-Length: -1\r\n\r\n'],
    ['fractional Content-Length', 'Content-Length: 1.5\r\n\r\n'],
    ['overflowing Content-Length', 'Content-Length: 9007199254740992\r\n\r\n'],
    ['LF-only framing', 'Content-Length: 1\n\n'],
  ])('rejects malformed headers: %s', async (_name, header) => {
    const outcome = await readChunks(
      [Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from('{}', 'ascii')])],
      1_024,
    );
    expectErrorCode(outcome.error, 'INVALID_HEADER');
  });

  it('rejects non-ASCII framing headers', async () => {
    const outcome = await readChunks(
      [
        Buffer.concat([
          Buffer.from('Content-Length: 1', 'ascii'),
          Buffer.from([0x80]),
          Buffer.from('\r\n\r\n{}', 'ascii'),
        ]),
      ],
      1_024,
    );
    expectErrorCode(outcome.error, 'INVALID_HEADER');
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xff]), 'INVALID_UTF8'],
    ['malformed JSON', Buffer.from('{', 'utf8'), 'INVALID_JSON'],
    ['JSON array batch', serialize([]), 'INVALID_JSON_RPC'],
    ['JSON scalar', serialize('value'), 'INVALID_JSON_RPC'],
    ['wrong JSON-RPC version', serialize({ jsonrpc: '1.0' }), 'INVALID_JSON_RPC'],
  ] as const)('rejects %s bodies', async (_name, body, code) => {
    const outcome = await readChunks([frameBody(body)], 1_024);
    expectErrorCode(outcome.error, code);
  });

  it.each([
    ['string', '1'],
    ['negative', -1],
    ['fractional', 1.5],
    ['null', null],
    ['overflowing', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s JSON-RPC request ID', async (_name, id) => {
    const outcome = await readChunks(
      [
        frameMessage({
          jsonrpc: JSON_RPC_VERSION,
          id,
          method: 'vscode-mcp/hello',
        }),
      ],
      1_024,
    );
    expectErrorCode(outcome.error, 'INVALID_JSON_RPC');
    expect(outcome.messages).toEqual([]);
  });

  it('rejects a truncated body when the transport ends', async () => {
    const outcome = await readChunks(
      [frameBody(Buffer.from('{}', 'ascii'), 'Content-Length: 10\r\n\r\n')],
      1_024,
    );
    expectErrorCode(outcome.error, 'TRUNCATED_FRAME');
  });
});

describe('BoundedJsonRpcMessageWriter', () => {
  it('is a vscode-jsonrpc MessageWriter and emits compliant framing', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: unknown) => {
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
    });
    const writer = new BoundedJsonRpcMessageWriter(stream, 1_024);
    expect(MessageWriter.is(writer)).toBe(true);

    const message = {
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: { value: '😀' },
    };
    await writer.write(message);
    const finished = once(stream, 'finish');
    writer.end();
    await finished;

    const body = serialize(message);
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
        body,
      ]),
    );
  });

  it('observes only the complete response write for the exact request ID', async () => {
    const stream = new PassThrough();
    stream.resume();
    const writer = new BoundedJsonRpcMessageWriter(stream, 1_024);
    let observed = false;
    const responseWritten = writer.waitForResponseWrite(7).then(() => {
      observed = true;
    });
    const notification = {
      jsonrpc: JSON_RPC_VERSION,
      method: 'test/notification',
    };
    const sameIdRequest = {
      jsonrpc: JSON_RPC_VERSION,
      id: 7,
      method: 'test/request',
    };
    const otherResponse = { jsonrpc: JSON_RPC_VERSION, id: 6, result: {} };
    const targetResponse = { jsonrpc: JSON_RPC_VERSION, id: 7, result: {} };

    await writer.write(notification);
    await writer.write(sameIdRequest);
    await writer.write(otherResponse);
    expect(observed).toBe(false);

    await writer.write(targetResponse);
    await responseWritten;
    expect(observed).toBe(true);
    writer.dispose();
    stream.destroy();
  });

  it('rejects response-write observers on write failure and disposal', async () => {
    const oversizedStream = new PassThrough();
    oversizedStream.resume();
    const oversizedWriter = new BoundedJsonRpcMessageWriter(oversizedStream, 64);
    const failedObservation = expect(
      oversizedWriter.waitForResponseWrite(9),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    const oversizedResponse = {
      jsonrpc: JSON_RPC_VERSION,
      id: 9,
      result: { padding: 'x'.repeat(128) },
    };
    await expect(oversizedWriter.write(oversizedResponse)).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
    await failedObservation;

    const disposedStream = new PassThrough();
    const disposedWriter = new BoundedJsonRpcMessageWriter(disposedStream, 1_024);
    const disposedObservation = expect(
      disposedWriter.waitForResponseWrite(10),
    ).rejects.toMatchObject({ code: 'WRITER_CLOSED' });
    disposedWriter.dispose();
    await disposedObservation;
    disposedStream.destroy();
  });

  it.each([
    ['bridge to extension', PROTOCOL_LIMITS.bridgeToExtensionFrameBytes],
    ['extension to bridge', PROTOCOL_LIMITS.extensionToBridgeFrameBytes],
  ])('writes a body at the exact %s cap', async (_direction, limit) => {
    const stream = new PassThrough();
    stream.resume();
    const writer = new BoundedJsonRpcMessageWriter(stream, limit);
    await expect(
      writer.write(messageWithSerializedBytes(limit)),
    ).resolves.toBeUndefined();
    const finished = once(stream, 'finish');
    writer.end();
    await finished;
  });

  it.each([
    ['bridge to extension', PROTOCOL_LIMITS.bridgeToExtensionFrameBytes],
    ['extension to bridge', PROTOCOL_LIMITS.extensionToBridgeFrameBytes],
  ])('refuses and closes on a %s body at cap plus one', async (_direction, limit) => {
    const stream = new PassThrough();
    stream.resume();
    const writer = new BoundedJsonRpcMessageWriter(stream, limit);
    const errors: Error[] = [];
    writer.onError(([error]) => {
      errors.push(error);
    });

    await expect(
      writer.write(messageWithSerializedBytes(limit + 1)),
    ).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
    expect(errors).toHaveLength(1);
    expect(stream.destroyed).toBe(true);
  });

  it('rejects a non-2.0 message before writing', async () => {
    const stream = new PassThrough();
    const writer = new BoundedJsonRpcMessageWriter(stream, 1_024);
    await expect(writer.write({ jsonrpc: '1.0' })).rejects.toMatchObject({
      code: 'INVALID_JSON_RPC',
    });
    expect(stream.destroyed).toBe(true);
  });

  it('rejects an invalid JSON-RPC response ID before writing', async () => {
    const stream = new PassThrough();
    const writer = new BoundedJsonRpcMessageWriter(stream, 1_024);
    const invalidMessage = {
      jsonrpc: JSON_RPC_VERSION,
      id: '1',
      result: {},
    };
    await expect(writer.write(invalidMessage)).rejects.toMatchObject({
      code: 'INVALID_JSON_RPC',
    });
    expect(stream.destroyed).toBe(true);
  });
});
