import { Buffer } from 'node:buffer';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { PROTOCOL_LIMITS } from '@vscode-mcp/protocol/constants';

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export class BoundedStdioTransportError extends Error {
  public constructor(public readonly code: 'MESSAGE_TOO_LARGE' | 'MALFORMED_MESSAGE') {
    super(
      code === 'MESSAGE_TOO_LARGE'
        ? 'The MCP message exceeds its byte limit.'
        : 'The MCP message is malformed.',
    );
    this.name = 'BoundedStdioTransportError';
  }
}

/**
 * Newline-delimited MCP stdio transport with a pre-parse inbound byte ceiling.
 * stdout remains reserved exclusively for serialized MCP messages.
 */
export class BoundedStdioServerTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <Message extends JSONRPCMessage>(message: Message) => void;

  private readonly pending: Buffer;
  private pendingLength = 0;
  private started = false;
  private closed = false;

  public constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
    private readonly maximumInboundBytes = PROTOCOL_LIMITS.mcpInboundMessageBytes,
  ) {
    if (!Number.isSafeInteger(maximumInboundBytes) || maximumInboundBytes <= 0) {
      throw new RangeError('The MCP inbound byte limit must be a positive integer.');
    }
    // A fixed-capacity buffer keeps fragmented input linear: each accepted byte is
    // copied once instead of repeatedly concatenating the whole partial message.
    this.pending = Buffer.allocUnsafe(maximumInboundBytes);
  }

  public async start(): Promise<void> {
    if (this.started) {
      throw new Error('The MCP stdio transport has already started.');
    }
    if (this.closed) {
      throw new Error('The MCP stdio transport is closed.');
    }
    this.started = true;
    this.input.on('data', this.handleData);
    this.input.on('error', this.handleInputError);
    this.output.on('error', this.handleOutputError);
  }

  public async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    void options;
    if (this.closed) {
      throw new Error('The MCP stdio transport is closed.');
    }
    const serialized = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error): void => {
        this.output.off('error', handleError);
        reject(error);
      };
      this.output.once('error', handleError);
      const accepted = this.output.write(serialized, 'utf8', () => {
        this.output.off('error', handleError);
        resolve();
      });
      if (!accepted) {
        // The write callback resolves only after the buffered data is handled.
      }
    });
  }

  public async close(): Promise<void> {
    this.finishClose();
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }

    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let offset = 0;
    while (offset < bytes.length && !this.closed) {
      const lineFeed = bytes.indexOf(LINE_FEED, offset);
      if (lineFeed === -1) {
        this.append(bytes.subarray(offset));
        return;
      }

      this.append(bytes.subarray(offset, lineFeed));
      if (this.closed) {
        return;
      }
      this.processPendingLine();
      offset = lineFeed + 1;
    }
  };

  private readonly handleInputError = (error: Error): void => {
    this.fail(error);
  };

  private readonly handleOutputError = (error: Error): void => {
    this.fail(error);
  };

  private append(segment: Buffer): void {
    if (this.pendingLength + segment.length > this.maximumInboundBytes) {
      this.fail(new BoundedStdioTransportError('MESSAGE_TOO_LARGE'));
      return;
    }
    if (segment.length === 0) {
      return;
    }
    segment.copy(this.pending, this.pendingLength);
    this.pendingLength += segment.length;
  }

  private processPendingLine(): void {
    let body = this.pending.subarray(0, this.pendingLength);
    this.pendingLength = 0;
    if (body.at(-1) === CARRIAGE_RETURN) {
      body = body.subarray(0, -1);
    }

    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
      const parsed: unknown = JSON.parse(text);
      const message = JSONRPCMessageSchema.parse(parsed);
      this.onmessage?.(message);
    } catch {
      this.fail(new BoundedStdioTransportError('MALFORMED_MESSAGE'));
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.onerror?.(error);
    this.finishClose();
  }

  private finishClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.input.off('data', this.handleData);
    this.input.off('error', this.handleInputError);
    this.output.off('error', this.handleOutputError);
    if (this.input.listenerCount('data') === 0) {
      this.input.pause();
    }
    this.pendingLength = 0;
    this.onclose?.();
  }
}
