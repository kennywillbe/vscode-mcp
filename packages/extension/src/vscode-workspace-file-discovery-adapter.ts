import { lstat, realpath } from 'node:fs/promises';

import * as vscode from 'vscode';

import type {
  WorkspaceFileDiscoveryCandidate,
  WorkspaceFileDiscoveryEntryStat,
  WorkspaceFileDiscoveryHost,
} from './workspace-file-discovery-service.js';

/** Stable VS Code/Node adapter for the unregistered v0.2 discovery service. */
export class VsCodeWorkspaceFileDiscoveryHost implements WorkspaceFileDiscoveryHost {
  public async findFiles(
    folderUri: string,
    include: string,
    exclude: string | null,
    maximumResults: number,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceFileDiscoveryCandidate[]> {
    const folder = vscode.Uri.parse(folderUri, true);
    if (folder.scheme !== 'file') {
      throw new Error('Workspace discovery requires a local file folder.');
    }
    const cancellation = new vscode.CancellationTokenSource();
    const abort = (): void => cancellation.cancel();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      cancellation.cancel();
    }
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, include),
        exclude,
        maximumResults,
        cancellation.token,
      );
      const candidates: WorkspaceFileDiscoveryCandidate[] = [];
      for (let index = 0; index < uris.length && index < maximumResults; index += 1) {
        const uri = uris[index];
        if (uri !== undefined) {
          candidates.push({ uri: uri.toString() });
        }
      }
      return candidates;
    } finally {
      signal.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  }

  public async lstat(path: string): Promise<WorkspaceFileDiscoveryEntryStat> {
    const value = await lstat(path);
    return {
      kind: value.isSymbolicLink() ? 'symbolicLink' : value.isFile() ? 'file' : 'other',
      identity: `${String(value.dev)}:${String(value.ino)}`,
      size: value.size,
      modifiedTime: value.mtimeMs,
    };
  }

  public async realpath(path: string): Promise<string> {
    return await realpath(path);
  }
}
