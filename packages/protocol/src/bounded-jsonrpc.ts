import { Buffer } from 'node:buffer';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from 'vscode-jsonrpc/node';

import { JSON_RPC_VERSION, PROTOCOL_LIMITS } from './constants.js';

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'ascii');
const CONTENT_LENGTH_HEADER = 'content-length';
const CONTENT_TYPE_HEADER = 'content-type';
const CONTENT_TYPE_PATTERN =
  /^[\t ]*application\/vscode-jsonrpc[\t ]*;[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*$/i;
const CONTENT_LENGTH_PATTERN = /^[\t ]*([0-9]+)[\t ]*$/;

export const BOUNDED_JSON_RPC_HEADER_BYTES = PROTOCOL_LIMITS.framingHeaderBytes;

export const BOUNDED_JSON_RPC_ERROR_CODES = [
  'INVALID_LIMIT',
  'INVALID_HEADER',
  'HEADER_TOO_LARGE',
  'BODY_TOO_LARGE',
  'INVALID_UTF8',
  'INVALID_JSON',
  'INVALID_JSON_RPC',
  'TRUNCATED_FRAME',
  'READER_ALREADY_LISTENING',
  'WRITER_CLOSED',
] as const;

export type BoundedJsonRpcErrorCode = (typeof BOUNDED_JSON_RPC_ERROR_CODES)[number];

export class BoundedJsonRpcError extends Error {
  public constructor(
    public readonly code: BoundedJsonRpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BoundedJsonRpcError';
  }
}

function boundedError(
  code: BoundedJsonRpcErrorCode,
  message: string,
): BoundedJsonRpcError {
  return new BoundedJsonRpcError(code, message);
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}

function assertBodyLimit(maximumBodyBytes: number): void {
  if (
    !Number.isSafeInteger(maximumBodyBytes) ||
    maximumBodyBytes <= 0 ||
    maximumBodyBytes > PROTOCOL_LIMITS.extensionToBridgeFrameBytes
  ) {
    throw boundedError(
      'INVALID_LIMIT',
      'The JSON-RPC body limit is outside the protocol bounds.',
    );
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcMessage(value: unknown): value is Message {
  if (!isJsonObject(value) || value.jsonrpc !== JSON_RPC_VERSION) {
    return false;
  }
  if (!Object.hasOwn(value, 'id')) {
    return true;
  }

  const id = value.id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0;
}

function isHeaderByte(byte: number): boolean {
  return (
    byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)
  );
}

function endsWithHeaderTerminator(buffer: Buffer, length: number): boolean {
  if (length < HEADER_TERMINATOR.length) {
    return false;
  }

  const start = length - HEADER_TERMINATOR.length;
  for (let index = 0; index < HEADER_TERMINATOR.length; index += 1) {
    if (buffer[start + index] !== HEADER_TERMINATOR[index]) {
      return false;
    }
  }
  return true;
}

function parseContentLength(header: Buffer, maximumBodyBytes: number): number {
  const headerText = header
    .subarray(0, header.length - HEADER_TERMINATOR.length)
    .toString('ascii');
  const lines = headerText.split('\r\n');

  let contentLength: number | undefined;
  let sawContentType = false;

  for (const line of lines) {
    if (line.length === 0) {
      throw boundedError('INVALID_HEADER', 'Empty framing header line.');
    }

    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw boundedError('INVALID_HEADER', 'Malformed framing header line.');
    }

    const rawName = line.slice(0, separator);
    if (rawName.trim() !== rawName) {
      throw boundedError('INVALID_HEADER', 'Malformed framing header name.');
    }

    const name = rawName.toLowerCase();
    const value = line.slice(separator + 1);

    if (name === CONTENT_LENGTH_HEADER) {
      if (contentLength !== undefined) {
        throw boundedError('INVALID_HEADER', 'Duplicate Content-Length header.');
      }

      const match = CONTENT_LENGTH_PATTERN.exec(value);
      const digits = match?.[1];
      if (digits === undefined) {
        throw boundedError('INVALID_HEADER', 'Invalid Content-Length header.');
      }

      const parsedLength = Number(digits);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        throw boundedError('INVALID_HEADER', 'Invalid Content-Length header.');
      }
      if (parsedLength > maximumBodyBytes) {
        throw boundedError('BODY_TOO_LARGE', 'Declared JSON-RPC body is too large.');
      }

      contentLength = parsedLength;
      continue;
    }

    if (name === CONTENT_TYPE_HEADER) {
      if (sawContentType) {
        throw boundedError('INVALID_HEADER', 'Duplicate Content-Type header.');
      }
      if (!CONTENT_TYPE_PATTERN.test(value)) {
        throw boundedError('INVALID_HEADER', 'Unsupported Content-Type header.');
      }
      sawContentType = true;
      continue;
    }

    throw boundedError('INVALID_HEADER', 'Unknown framing header.');
  }

  if (contentLength === undefined) {
    throw boundedError('INVALID_HEADER', 'Missing Content-Length header.');
  }
  return contentLength;
}

function decodeMessage(body: Buffer): Message {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw boundedError('INVALID_UTF8', 'JSON-RPC body is not valid UTF-8.');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw boundedError('INVALID_JSON', 'JSON-RPC body is not valid JSON.');
  }

  if (!isJsonObject(value)) {
    throw boundedError('INVALID_JSON_RPC', 'JSON-RPC body must be one object.');
  }
  if (!isJsonRpcMessage(value)) {
    throw boundedError('INVALID_JSON_RPC', 'JSON-RPC version must be 2.0.');
  }
  return value;
}

/**
 * A Content-Length reader that validates and bounds framing before allocating a body.
 * It is directly usable by vscode-jsonrpc's createMessageConnection.
 */
export class BoundedJsonRpcMessageReader
  extends AbstractMessageReader
  implements MessageReader
{
  private readonly headerBuffer = Buffer.alloc(BOUNDED_JSON_RPC_HEADER_BYTES);
  private readonly maximumBodyBytes: number;
  private headerLength = 0;
  private bodyBuffer: Buffer | undefined;
  private bodyOffset = 0;
  private callback: DataCallback | undefined;
  private listening = false;
  private terminal = false;
  private disposed = false;

  public constructor(
    private readonly readable: Readable,
    maximumBodyBytes: number,
  ) {
    super();
    assertBodyLimit(maximumBodyBytes);
    this.maximumBodyBytes = maximumBodyBytes;
  }

  public override listen(callback: DataCallback): Disposable {
    if (this.listening) {
      throw boundedError(
        'READER_ALREADY_LISTENING',
        'The bounded JSON-RPC reader may listen only once.',
      );
    }
    this.listening = true;
    this.callback = callback;
    this.readable.on('data', this.handleData);
    this.readable.once('end', this.handleEnd);
    this.readable.once('close', this.handleClose);
    this.readable.once('error', this.handleStreamError);

    return {
      dispose: (): void => {
        this.dispose();
      },
    };
  }

  public override dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachStreamListeners();
    this.callback = undefined;
    this.bodyBuffer = undefined;
    this.headerLength = 0;
    this.bodyOffset = 0;
    super.dispose();
  }

  private readonly handleData = (chunk: unknown): void => {
    if (this.terminal || this.disposed) {
      return;
    }
    if (!(chunk instanceof Uint8Array)) {
      this.fail(
        boundedError('INVALID_HEADER', 'JSON-RPC transport must provide raw bytes.'),
      );
      return;
    }

    try {
      this.consume(chunk);
    } catch (error) {
      this.fail(asError(error, 'Failed to read a JSON-RPC frame.'));
    }
  };

  private readonly handleEnd = (): void => {
    if (this.terminal || this.disposed) {
      return;
    }
    if (this.headerLength !== 0 || this.bodyBuffer !== undefined) {
      this.fail(
        boundedError('TRUNCATED_FRAME', 'JSON-RPC transport ended during a frame.'),
      );
      return;
    }
    this.closeCleanly();
  };

  private readonly handleClose = (): void => {
    if (this.terminal || this.disposed) {
      return;
    }
    if (this.headerLength !== 0 || this.bodyBuffer !== undefined) {
      this.fireError(
        boundedError('TRUNCATED_FRAME', 'JSON-RPC transport closed during a frame.'),
      );
    }
    this.closeCleanly();
  };

  private readonly handleStreamError = (error: Error): void => {
    this.fail(error);
  };

  private consume(chunk: Uint8Array): void {
    let chunkOffset = 0;

    while (chunkOffset < chunk.byteLength && !this.terminal && !this.disposed) {
      if (this.bodyBuffer === undefined) {
        chunkOffset = this.consumeHeader(chunk, chunkOffset);
      } else {
        chunkOffset = this.consumeBody(chunk, chunkOffset);
      }
    }
  }

  private consumeHeader(chunk: Uint8Array, startOffset: number): number {
    let chunkOffset = startOffset;

    while (chunkOffset < chunk.byteLength) {
      if (this.headerLength >= BOUNDED_JSON_RPC_HEADER_BYTES) {
        throw boundedError('HEADER_TOO_LARGE', 'JSON-RPC framing header is too large.');
      }

      const byte = chunk[chunkOffset];
      if (byte === undefined || !isHeaderByte(byte)) {
        throw boundedError('INVALID_HEADER', 'JSON-RPC framing header is not ASCII.');
      }

      const previousByte =
        this.headerLength === 0 ? undefined : this.headerBuffer[this.headerLength - 1];
      if (byte === 0x0a && previousByte !== 0x0d) {
        throw boundedError('INVALID_HEADER', 'JSON-RPC headers require CRLF lines.');
      }
      if (previousByte === 0x0d && byte !== 0x0a) {
        throw boundedError('INVALID_HEADER', 'JSON-RPC headers require CRLF lines.');
      }

      this.headerBuffer[this.headerLength] = byte;
      this.headerLength += 1;
      chunkOffset += 1;

      if (endsWithHeaderTerminator(this.headerBuffer, this.headerLength)) {
        const header = this.headerBuffer.subarray(0, this.headerLength);
        const contentLength = parseContentLength(header, this.maximumBodyBytes);
        this.headerLength = 0;
        this.bodyBuffer = Buffer.alloc(contentLength);
        this.bodyOffset = 0;

        if (contentLength === 0) {
          this.completeBody();
        }
        return chunkOffset;
      }
    }

    return chunkOffset;
  }

  private consumeBody(chunk: Uint8Array, startOffset: number): number {
    const body = this.bodyBuffer;
    if (body === undefined) {
      return startOffset;
    }

    const remainingBodyBytes = body.byteLength - this.bodyOffset;
    const availableChunkBytes = chunk.byteLength - startOffset;
    const copiedBytes = Math.min(remainingBodyBytes, availableChunkBytes);
    body.set(chunk.subarray(startOffset, startOffset + copiedBytes), this.bodyOffset);
    this.bodyOffset += copiedBytes;

    if (this.bodyOffset === body.byteLength) {
      this.completeBody();
    }
    return startOffset + copiedBytes;
  }

  private completeBody(): void {
    const body = this.bodyBuffer;
    if (body === undefined) {
      throw boundedError('INVALID_JSON_RPC', 'Missing JSON-RPC body buffer.');
    }

    this.bodyBuffer = undefined;
    this.bodyOffset = 0;
    const message = decodeMessage(body);
    const callback = this.callback;
    if (callback === undefined) {
      throw boundedError('INVALID_JSON_RPC', 'JSON-RPC reader is not listening.');
    }
    callback(message);
  }

  private fail(error: Error): void {
    if (this.terminal || this.disposed) {
      return;
    }
    this.terminal = true;
    this.detachStreamListeners();
    this.fireError(error);
    this.fireClose();
    this.readable.destroy();
  }

  private closeCleanly(): void {
    if (this.terminal || this.disposed) {
      return;
    }
    this.terminal = true;
    this.detachStreamListeners();
    this.fireClose();
  }

  private detachStreamListeners(): void {
    this.readable.removeListener('data', this.handleData);
    this.readable.removeListener('end', this.handleEnd);
    this.readable.removeListener('close', this.handleClose);
    this.readable.removeListener('error', this.handleStreamError);
  }
}

type EncodedFrame = {
  readonly header: Buffer;
  readonly body: Buffer;
};

interface ResponseWriteWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function encodeFrame(message: Message, maximumBodyBytes: number): EncodedFrame {
  if (!isJsonRpcMessage(message)) {
    throw boundedError('INVALID_JSON_RPC', 'JSON-RPC version must be 2.0.');
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(message);
  } catch {
    throw boundedError('INVALID_JSON', 'JSON-RPC message is not serializable.');
  }
  if (serialized === undefined) {
    throw boundedError('INVALID_JSON', 'JSON-RPC message is not serializable.');
  }

  const body = Buffer.from(serialized, 'utf8');
  if (body.byteLength > maximumBodyBytes) {
    throw boundedError('BODY_TOO_LARGE', 'Serialized JSON-RPC body is too large.');
  }

  return {
    header: Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
    body,
  };
}

/**
 * A serialized, bounded Content-Length writer directly usable by vscode-jsonrpc.
 */
export class BoundedJsonRpcMessageWriter
  extends AbstractMessageWriter
  implements MessageWriter
{
  private readonly maximumBodyBytes: number;
  private readonly responseWriteWaiters = new Map<number, ResponseWriteWaiter>();
  private writeTail: Promise<void> = Promise.resolve();
  private errorCount = 0;
  private ending = false;
  private terminal = false;
  private disposed = false;

  public constructor(
    private readonly writable: Writable,
    maximumBodyBytes: number,
  ) {
    super();
    assertBodyLimit(maximumBodyBytes);
    this.maximumBodyBytes = maximumBodyBytes;
    this.writable.once('error', this.handleStreamError);
    this.writable.once('close', this.handleClose);
  }

  public write(message: Message): Promise<void> {
    if (this.ending || this.terminal || this.disposed) {
      return Promise.reject(
        boundedError('WRITER_CLOSED', 'The bounded JSON-RPC writer is closed.'),
      );
    }

    let frame: EncodedFrame;
    try {
      frame = encodeFrame(message, this.maximumBodyBytes);
    } catch (error) {
      const failure = asError(error, 'Failed to encode a JSON-RPC frame.');
      this.fail(failure, message);
      return Promise.reject(failure);
    }

    const operation = this.writeTail.then(async () => {
      if (this.terminal || this.disposed) {
        throw boundedError('WRITER_CLOSED', 'The bounded JSON-RPC writer is closed.');
      }

      try {
        await this.writeChunk(frame.header);
        await this.writeChunk(frame.body);
      } catch (error) {
        const failure = asError(error, 'Failed to write a JSON-RPC frame.');
        this.fail(failure, message);
        throw failure;
      }
    });

    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.settleMatchingResponseWrite(message, operation);
    return operation;
  }

  /** Resolves only after a complete result/error response for one request ID is written. */
  public waitForResponseWrite(requestId: number): Promise<void> {
    if (!Number.isSafeInteger(requestId) || requestId < 0) {
      return Promise.reject(
        boundedError('INVALID_JSON_RPC', 'The response write ID is invalid.'),
      );
    }
    if (this.ending || this.terminal || this.disposed) {
      return Promise.reject(
        boundedError('WRITER_CLOSED', 'The bounded JSON-RPC writer is closed.'),
      );
    }
    if (this.responseWriteWaiters.has(requestId)) {
      return Promise.reject(
        boundedError('INVALID_JSON_RPC', 'The response write ID is already tracked.'),
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.responseWriteWaiters.set(requestId, { resolve, reject });
    });
  }

  public end(): void {
    if (this.ending || this.terminal || this.disposed) {
      return;
    }
    this.ending = true;
    this.rejectResponseWriteWaiters(
      boundedError('WRITER_CLOSED', 'The bounded JSON-RPC writer is closed.'),
    );
    void this.writeTail.then(() => {
      if (!this.terminal && !this.disposed) {
        this.writable.end();
      }
    });
  }

  public override dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rejectResponseWriteWaiters(
      boundedError('WRITER_CLOSED', 'The bounded JSON-RPC writer is closed.'),
    );
    this.detachStreamListeners();
    super.dispose();
  }

  private readonly handleStreamError = (error: Error): void => {
    this.fail(error);
  };

  private readonly handleClose = (): void => {
    if (this.terminal || this.disposed) {
      return;
    }
    this.terminal = true;
    this.rejectResponseWriteWaiters(
      boundedError('WRITER_CLOSED', 'The bounded JSON-RPC writer is closed.'),
    );
    this.detachStreamListeners();
    this.fireClose();
  };

  private writeChunk(chunk: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writable.write(chunk, (error: Error | null | undefined) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private fail(error: Error, message?: Message): void {
    if (this.terminal || this.disposed) {
      return;
    }
    this.terminal = true;
    this.rejectResponseWriteWaiters(error);
    this.errorCount += 1;
    this.detachStreamListeners();
    this.fireError(error, message, this.errorCount);
    this.fireClose();
    this.writable.destroy();
  }

  private detachStreamListeners(): void {
    this.writable.removeListener('error', this.handleStreamError);
    this.writable.removeListener('close', this.handleClose);
  }

  private settleMatchingResponseWrite(
    message: Message,
    operation: Promise<void>,
  ): void {
    const untrustedMessage: unknown = message;
    if (
      !isJsonObject(untrustedMessage) ||
      !Object.hasOwn(untrustedMessage, 'id') ||
      Object.hasOwn(untrustedMessage, 'method')
    ) {
      return;
    }
    const hasResult = Object.hasOwn(untrustedMessage, 'result');
    const hasError = Object.hasOwn(untrustedMessage, 'error');
    if (hasResult === hasError) {
      return;
    }
    const id = untrustedMessage.id;
    if (typeof id !== 'number') {
      return;
    }
    const waiter = this.responseWriteWaiters.get(id);
    if (waiter === undefined) {
      return;
    }

    this.responseWriteWaiters.delete(id);
    void operation.then(waiter.resolve, (error: unknown) => {
      waiter.reject(asError(error, 'Failed to write the tracked JSON-RPC response.'));
    });
  }

  private rejectResponseWriteWaiters(error: Error): void {
    for (const waiter of this.responseWriteWaiters.values()) {
      waiter.reject(error);
    }
    this.responseWriteWaiters.clear();
  }
}
