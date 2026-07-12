import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  V02_READ_TOOL_LIMITS,
  V02_TOOL_CONTRACT_VERSION,
} from '@vscode-mcp/protocol/constants';

const CURSOR_VERSION = 1 as const;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CURSOR_PATTERN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export interface WorkspaceDiscoveryCursorBinding {
  readonly tool: 'list_workspace_files' | 'search_workspace_text';
  readonly instanceId: string;
  readonly workspaceFingerprint: string;
  readonly workspaceFolderId: string;
  readonly include: string;
  readonly exclude: string | null;
  readonly optionsHash: string;
}

export interface WorkspaceDiscoveryCursorPosition {
  readonly offset: number;
  readonly sortTupleHash: string;
}

interface CursorPayload extends WorkspaceDiscoveryCursorPosition {
  readonly version: typeof CURSOR_VERSION;
  readonly bindingHash: string;
}

export class WorkspaceDiscoveryCursorCodec {
  readonly #key: Buffer;
  #destroyed = false;

  public constructor(key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new Error('A cursor codec requires a 256-bit listener-generation key.');
    }
    this.#key = Buffer.from(key);
  }

  public encode(
    binding: WorkspaceDiscoveryCursorBinding,
    position: WorkspaceDiscoveryCursorPosition,
  ): string {
    this.assertActive();
    if (
      !Number.isSafeInteger(position.offset) ||
      position.offset <= 0 ||
      !SHA256_BASE64URL_PATTERN.test(position.sortTupleHash)
    ) {
      throw new Error('The cursor position is invalid.');
    }
    const payload: CursorPayload = {
      version: CURSOR_VERSION,
      bindingHash: hashBinding(binding),
      offset: position.offset,
      sortTupleHash: position.sortTupleHash,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.#key)
      .update(encoded)
      .digest('base64url');
    const cursor = `${encoded}.${signature}`;
    if (cursor.length > V02_READ_TOOL_LIMITS.cursorCharacters) {
      throw new Error('The cursor exceeds the contract limit.');
    }
    return cursor;
  }

  public decode(
    cursor: string,
    binding: WorkspaceDiscoveryCursorBinding,
  ): WorkspaceDiscoveryCursorPosition | null {
    if (this.#destroyed || cursor.length > V02_READ_TOOL_LIMITS.cursorCharacters) {
      return null;
    }
    const match = CURSOR_PATTERN.exec(cursor);
    const encoded = match?.[1];
    const providedSignature = match?.[2];
    if (encoded === undefined || providedSignature === undefined) {
      return null;
    }
    const expectedSignature = createHmac('sha256', this.#key).update(encoded).digest();
    let decodedSignature: Buffer;
    try {
      decodedSignature = Buffer.from(providedSignature, 'base64url');
    } catch {
      return null;
    }
    if (
      decodedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(decodedSignature, expectedSignature)
    ) {
      return null;
    }

    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 4 ||
      value['version'] !== CURSOR_VERSION ||
      value['bindingHash'] !== hashBinding(binding) ||
      !Number.isSafeInteger(value['offset']) ||
      Number(value['offset']) <= 0 ||
      typeof value['sortTupleHash'] !== 'string' ||
      !SHA256_BASE64URL_PATTERN.test(value['sortTupleHash'])
    ) {
      return null;
    }
    return {
      offset: Number(value['offset']),
      sortTupleHash: value['sortTupleHash'],
    };
  }

  public destroy(): void {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.#key.fill(0);
    }
  }

  private assertActive(): void {
    if (this.#destroyed) {
      throw new Error('The cursor codec listener generation has ended.');
    }
  }
}

export function hashWorkspaceDiscoverySortTuple(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function hashBinding(binding: WorkspaceDiscoveryCursorBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        contractVersion: V02_TOOL_CONTRACT_VERSION,
        tool: binding.tool,
        instanceId: binding.instanceId,
        workspaceFingerprint: binding.workspaceFingerprint,
        workspaceFolderId: binding.workspaceFolderId,
        include: binding.include,
        exclude: binding.exclude,
        optionsHash: binding.optionsHash,
      }),
      'utf8',
    )
    .digest('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
