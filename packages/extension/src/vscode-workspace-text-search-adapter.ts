import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

import { PROVIDER_OUTPUT_LIMITS } from '@vscode-mcp/protocol/constants';
import * as vscode from 'vscode';

import type { EditorHostDocument, EditorHostIterable } from './editor-tool-host.js';
import { VsCodeWorkspaceFileDiscoveryHost } from './vscode-workspace-file-discovery-adapter.js';
import type { WorkspaceTextSearchHost } from './workspace-text-search-service.js';
import type { WorkspaceFileDiscoveryEntryStat } from './workspace-file-discovery-service.js';

/** Stable VS Code/Node host for the unregistered v0.2 literal scanner. */
export class VsCodeWorkspaceTextSearchHost
  extends VsCodeWorkspaceFileDiscoveryHost
  implements WorkspaceTextSearchHost
{
  public async readFile(
    path: string,
    signal: AbortSignal,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly before: WorkspaceFileDiscoveryEntryStat;
    readonly after: WorkspaceFileDiscoveryEntryStat;
  }> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await fileHandleStat(handle);
      const bytes = await handle.readFile({ signal });
      const after = await fileHandleStat(handle);
      return { bytes, before, after };
    } finally {
      await handle.close();
    }
  }

  public openDocuments(): EditorHostIterable<EditorHostDocument> {
    const source = vscode.workspace.textDocuments;
    const maximum = PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax;
    const available = Math.min(source.length, maximum);
    return {
      omittedCount: source.length - available,
      *[Symbol.iterator](): Iterator<EditorHostDocument> {
        for (let index = 0; index < available; index += 1) {
          const document = source[index];
          if (document !== undefined) {
            yield wrapDocument(document);
          }
        }
      },
    };
  }
}

async function fileHandleStat(
  handle: FileHandle,
): Promise<WorkspaceFileDiscoveryEntryStat> {
  const value = await handle.stat();
  return {
    kind: value.isFile() ? 'file' : 'other',
    identity: `${String(value.dev)}:${String(value.ino)}`,
    size: value.size,
    modifiedTime: value.mtimeMs,
  };
}

function wrapDocument(document: vscode.TextDocument): EditorHostDocument {
  return {
    get uri(): string {
      return document.uri.toString();
    },
    get languageId(): string {
      return document.languageId;
    },
    get version(): number {
      return document.version;
    },
    get isDirty(): boolean {
      return document.isDirty;
    },
    get lineCount(): number {
      return document.lineCount;
    },
    get eol(): 'LF' | 'CRLF' {
      return document.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF';
    },
    lineText(line: number): string {
      return document.lineAt(line).text;
    },
  };
}
