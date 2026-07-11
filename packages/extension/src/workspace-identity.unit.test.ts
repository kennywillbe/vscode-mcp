import { describe, expect, it } from 'vitest';

import { createWorkspaceIdentity } from './workspace-identity.js';

describe('workspace identity', () => {
  it('is independent of workspace-folder order', async () => {
    const folders = [
      { name: 'B', uri: 'file:///workspace/b', fsPath: '/alias/b' },
      { name: 'A', uri: 'file:///workspace/a', fsPath: '/alias/a' },
    ];
    const canonicalize = async (path: string): Promise<string> =>
      path.replace('/alias', '/canonical');

    const first = await createWorkspaceIdentity({
      displayName: 'fixture',
      workspaceFileUri: null,
      folders,
      canonicalize,
    });
    const second = await createWorkspaceIdentity({
      displayName: 'fixture',
      workspaceFileUri: null,
      folders: [...folders].reverse(),
      canonicalize,
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.folders.map((folder) => folder.canonicalPath)).toEqual([
      '/canonical/a',
      '/canonical/b',
    ]);
  });

  it('changes when the canonical folder set changes', async () => {
    const canonicalize = async (path: string): Promise<string> => path;
    const first = await createWorkspaceIdentity({
      displayName: 'fixture',
      workspaceFileUri: null,
      folders: [{ name: 'A', uri: 'file:///workspace/a', fsPath: '/workspace/a' }],
      canonicalize,
    });
    const second = await createWorkspaceIdentity({
      displayName: 'fixture',
      workspaceFileUri: null,
      folders: [{ name: 'B', uri: 'file:///workspace/b', fsPath: '/workspace/b' }],
      canonicalize,
    });

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('rejects duplicate canonical roots', async () => {
    await expect(
      createWorkspaceIdentity({
        displayName: 'fixture',
        workspaceFileUri: null,
        folders: [
          { name: 'A', uri: 'file:///workspace/a', fsPath: '/alias/a' },
          { name: 'B', uri: 'file:///workspace/b', fsPath: '/alias/b' },
        ],
        canonicalize: async () => '/canonical/shared',
      }),
    ).rejects.toThrow('unique canonical paths');
  });
});
