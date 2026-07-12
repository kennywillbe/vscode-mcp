import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { RegistryWorkspaceFolderSchema } from '@vscode-mcp/protocol/registry-schemas';
import { WorkspaceFingerprintSchema } from '@vscode-mcp/protocol/schemas';

export interface WorkspaceFolderSource {
  name: string;
  uri: string;
  fsPath: string;
}

export interface WorkspaceIdentity {
  fingerprint: string;
  displayName: string;
  workspaceFileUri: string | null;
  folders: Array<{
    workspaceFolderId: string;
    name: string;
    uri: string;
    canonicalPath: string;
  }>;
}

export interface WorkspaceIdentityOptions {
  displayName: string;
  workspaceFileUri: string | null;
  folders: readonly WorkspaceFolderSource[];
  canonicalize?: (path: string) => Promise<string>;
}

export async function createWorkspaceIdentity(
  options: WorkspaceIdentityOptions,
): Promise<WorkspaceIdentity> {
  if (options.folders.length === 0) {
    throw new Error('A workspace identity requires at least one folder.');
  }

  const canonicalize = options.canonicalize ?? realpath;
  const folders = await Promise.all(
    options.folders.map(async (folder) => {
      const canonicalPath = await canonicalize(folder.fsPath);
      return RegistryWorkspaceFolderSchema.parse({
        workspaceFolderId: createHash('sha256')
          .update(canonicalPath)
          .digest('hex')
          .slice(0, 32),
        name: folder.name,
        uri: folder.uri,
        canonicalPath,
      });
    }),
  );
  folders.sort((left, right) =>
    compareCodeUnits(left.canonicalPath, right.canonicalPath),
  );

  if (new Set(folders.map((folder) => folder.canonicalPath)).size !== folders.length) {
    throw new Error('Workspace folders must resolve to unique canonical paths.');
  }

  const fingerprint = WorkspaceFingerprintSchema.parse(
    createHash('sha256')
      .update(folders.map((folder) => folder.canonicalPath).join('\0'))
      .digest('hex'),
  );

  return {
    fingerprint,
    displayName: options.displayName,
    workspaceFileUri: options.workspaceFileUri,
    folders,
  };
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
