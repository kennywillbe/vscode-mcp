import { describe, expect, it } from 'vitest';

import type { WorkspaceIdentity } from './workspace-identity.js';
import {
  authorizeWorkspaceDocument,
  createWorkspaceAuthorizationPathStrategy,
  type WorkspaceAuthorizationResult,
  type WorkspacePathFlavor,
} from './workspace-authorizer.js';

const POSIX_PATHS = createWorkspaceAuthorizationPathStrategy('posix');
const WINDOWS_PATHS = createWorkspaceAuthorizationPathStrategy('win32');

describe('workspace document authorization', () => {
  it('maps a URI to the deepest canonical workspace root', async () => {
    const result = await authorize({
      identity: workspace([
        folder('outer', 'file:///repo', '/repo'),
        folder('app', 'file:///repo/packages/app', '/repo/packages/app'),
      ]),
      reference: 'file:///repo/packages/app/src/index.ts',
    });

    expect(result).toEqual({
      ok: true,
      document: {
        workspaceFolderId: 'app',
        canonicalPath: '/repo/packages/app/src/index.ts',
        relativePath: 'src/index.ts',
        uri: 'file:///repo/packages/app/src/index.ts',
      },
    });
  });

  it('keeps an alias URI for live-buffer lookup while authorizing its real path', async () => {
    const result = await authorize({
      identity: workspace([
        folder('project', 'file:///aliases/project', '/real/project'),
      ]),
      reference: {
        kind: 'workspacePath',
        workspaceFolderId: 'project',
        relativePath: 'src/index.ts',
      },
      realpath: async (path) => path.replace('/aliases/project', '/real/project'),
    });

    expect(result).toEqual({
      ok: true,
      document: {
        workspaceFolderId: 'project',
        canonicalPath: '/real/project/src/index.ts',
        relativePath: 'src/index.ts',
        uri: 'file:///aliases/project/src/index.ts',
      },
    });
  });

  it('assigns an outer-root workspace path to a nested owning root', async () => {
    const result = await authorize({
      identity: workspace([
        folder('outer', 'file:///repo', '/repo'),
        folder('nested', 'file:///repo/packages', '/repo/packages'),
      ]),
      reference: {
        kind: 'workspacePath',
        workspaceFolderId: 'outer',
        relativePath: 'packages/tool/src/main.ts',
      },
    });

    expect(result).toEqual({
      ok: true,
      document: {
        workspaceFolderId: 'nested',
        canonicalPath: '/repo/packages/tool/src/main.ts',
        relativePath: 'tool/src/main.ts',
        uri: 'file:///repo/packages/tool/src/main.ts',
      },
    });
  });

  it('rejects path-prefix traps', async () => {
    const result = await authorize({
      identity: workspace([folder('project', 'file:///work/project', '/work/project')]),
      reference: { kind: 'uri', uri: 'file:///work/project-copy/secrets.ts' },
    });

    expectFailure(result, 'DOCUMENT_OUTSIDE_WORKSPACE');
  });

  it('rejects symlink escapes from the selected folder', async () => {
    const result = await authorize({
      identity: workspace([
        folder('allowed', 'file:///work/allowed', '/work/allowed'),
        folder('other', 'file:///work/other', '/work/other'),
      ]),
      reference: {
        kind: 'workspacePath',
        workspaceFolderId: 'allowed',
        relativePath: 'link/secret.ts',
      },
      realpath: async () => '/work/other/secret.ts',
    });

    expectFailure(result, 'DOCUMENT_OUTSIDE_WORKSPACE');
  });

  it('returns a stable missing-folder error before resolving a path', async () => {
    let realpathCalled = false;
    const result = await authorize({
      identity: workspace([folder('known', 'file:///work/known', '/work/known')]),
      reference: {
        kind: 'workspacePath',
        workspaceFolderId: 'missing',
        relativePath: 'src/index.ts',
      },
      realpath: async (path) => {
        realpathCalled = true;
        return path;
      },
    });

    expectFailure(result, 'WORKSPACE_FOLDER_NOT_FOUND');
    expect(realpathCalled).toBe(false);
  });

  it.each([
    '',
    '/absolute.ts',
    'C:/drive.ts',
    'src\\index.ts',
    '../secret.ts',
    'src/../secret.ts',
    './index.ts',
    'src//index.ts',
    'src/',
  ])('rejects invalid workspace-relative path %j', async (relativePath) => {
    const result = await authorize({
      identity: workspace([folder('project', 'file:///work/project', '/work/project')]),
      reference: {
        kind: 'workspacePath',
        workspaceFolderId: 'project',
        relativePath,
      },
    });

    expectFailure(result, 'INVALID_ARGUMENT');
  });

  it.each(['untitled:Scratch-1', 'vscode-remote://ssh-remote/work/file.ts'])(
    'rejects unsupported URI scheme %s',
    async (uri) => {
      const result = await authorize({
        identity: workspace([
          folder('project', 'file:///work/project', '/work/project'),
        ]),
        reference: { kind: 'uri', uri },
      });

      expectFailure(result, 'UNSUPPORTED_URI_SCHEME');
    },
  );

  it('rejects malformed and non-local file URIs without exposing their paths', async () => {
    const malformed = await authorize({
      identity: workspace([folder('project', 'file:///work/project', '/work/project')]),
      reference: { kind: 'uri', uri: 'not a uri' },
    });
    const remote = await authorize({
      identity: workspace([folder('project', 'file:///work/project', '/work/project')]),
      reference: { kind: 'uri', uri: 'file://fileserver/share/secret.ts' },
    });

    expect(malformed).toEqual({ ok: false, errorCode: 'INVALID_ARGUMENT' });
    expect(remote).toEqual({ ok: false, errorCode: 'UNSUPPORTED_DOCUMENT' });
    expect(JSON.stringify([malformed, remote])).not.toContain('secret.ts');
  });

  it('maps realpath failures to a path-free document-not-found error', async () => {
    const result = await authorize({
      identity: workspace([folder('project', 'file:///work/project', '/work/project')]),
      reference: { kind: 'uri', uri: 'file:///work/project/private.ts' },
      realpath: async () => {
        throw new Error('/work/project/private.ts is missing');
      },
    });

    expect(result).toEqual({ ok: false, errorCode: 'DOCUMENT_NOT_FOUND' });
    expect(JSON.stringify(result)).not.toContain('private.ts');
  });

  it('uses case-insensitive Windows containment and forward-slash output', async () => {
    const result = await authorize({
      identity: workspace([folder('project', 'file:///C:/Work/App', 'C:\\Work\\App')]),
      reference: {
        kind: 'workspacePath',
        workspaceFolderId: 'project',
        relativePath: 'Src/Index.ts',
      },
      realpath: async () => 'c:\\work\\app\\Src\\Index.ts',
      flavor: 'win32',
    });

    expect(result).toEqual({
      ok: true,
      document: {
        workspaceFolderId: 'project',
        canonicalPath: 'c:\\work\\app\\Src\\Index.ts',
        relativePath: 'Src/Index.ts',
        uri: 'file:///C:/Work/App/Src/Index.ts',
      },
    });
  });

  it('rejects a Windows target on another drive', async () => {
    const result = await authorize({
      identity: workspace([folder('project', 'file:///C:/Work/App', 'C:\\Work\\App')]),
      reference: { kind: 'uri', uri: 'file:///D:/Work/App/index.ts' },
      flavor: 'win32',
    });

    expectFailure(result, 'DOCUMENT_OUTSIDE_WORKSPACE');
  });

  it('keeps POSIX containment case-sensitive', async () => {
    const result = await authorize({
      identity: workspace([folder('project', 'file:///Work/App', '/Work/App')]),
      reference: { kind: 'uri', uri: 'file:///work/app/index.ts' },
    });

    expectFailure(result, 'DOCUMENT_OUTSIDE_WORKSPACE');
  });
});

interface AuthorizeOptions {
  readonly identity: WorkspaceIdentity;
  readonly reference: Parameters<typeof authorizeWorkspaceDocument>[0]['reference'];
  readonly realpath?: (path: string) => Promise<string>;
  readonly flavor?: WorkspacePathFlavor;
}

function authorize(options: AuthorizeOptions): Promise<WorkspaceAuthorizationResult> {
  const flavor = options.flavor ?? 'posix';
  return authorizeWorkspaceDocument({
    workspaceIdentity: options.identity,
    reference: options.reference,
    realpath: options.realpath ?? passthroughRealpath,
    pathStrategy: flavor === 'posix' ? POSIX_PATHS : WINDOWS_PATHS,
  });
}

function passthroughRealpath(path: string): Promise<string> {
  return Promise.resolve(path);
}

interface FolderInput {
  readonly workspaceFolderId: string;
  readonly name: string;
  readonly uri: string;
  readonly canonicalPath: string;
}

function folder(
  workspaceFolderId: string,
  uri: string,
  canonicalPath: string,
): FolderInput {
  return {
    workspaceFolderId,
    name: workspaceFolderId,
    uri,
    canonicalPath,
  };
}

function workspace(folders: readonly FolderInput[]): WorkspaceIdentity {
  return {
    fingerprint: '0'.repeat(64),
    displayName: 'fixture',
    workspaceFileUri: null,
    folders: folders.map((value) => ({ ...value })),
  };
}

function expectFailure(
  result: WorkspaceAuthorizationResult,
  errorCode: Exclude<WorkspaceAuthorizationResult, { ok: true }>['errorCode'],
): void {
  expect(result).toEqual({ ok: false, errorCode });
}
