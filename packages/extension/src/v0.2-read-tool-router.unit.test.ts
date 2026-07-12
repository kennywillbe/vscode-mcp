import { describe, expect, it } from 'vitest';

import {
  V02ExtensionToolRouter,
  V02ReadToolRouter,
  type V02ReadToolRouterOptions,
} from './v0.2-read-tool-router.js';
import { WorkspaceTextSearchError } from './workspace-text-search-service.js';

const instanceId = 'a12f0291-37e2-4ff6-b763-0abf3fe66714';
const observedAt = '2026-07-11T03:30:00.000Z';

describe('V02ReadToolRouter', () => {
  it('routes and wraps a schema-valid success without changing v0.2 content', async () => {
    const router = createRouter();
    const result = await router.callTool(
      {
        tool: 'list_workspace_files',
        arguments: { workspaceFolderId: 'root' },
      },
      new AbortController().signal,
    );
    expect(router.names).toEqual([
      'list_workspace_files',
      'read_documents',
      'search_workspace_text',
    ]);
    expect(result).toMatchObject({
      outcome: 'success',
      tool: 'list_workspace_files',
      response: {
        contractVersion: '0.2.0',
        instanceId,
        result: { files: ['a.ts'] },
      },
    });
  });

  it('preserves stable service errors and sanitizes unknown failures', async () => {
    const expected = await createRouter({
      searchText: {
        searchWorkspaceText: () =>
          Promise.reject(
            new WorkspaceTextSearchError(
              'INVALID_CURSOR',
              'The continuation cursor is invalid.',
              false,
            ),
          ),
      },
    }).callTool(searchInvocation(), new AbortController().signal);
    expect(expected).toEqual({
      outcome: 'toolError',
      tool: 'search_workspace_text',
      error: {
        code: 'INVALID_CURSOR',
        message: 'The continuation cursor is invalid.',
        retryable: false,
      },
    });

    const internal = await createRouter({
      searchText: {
        searchWorkspaceText: () => Promise.reject(new Error('private canary')),
      },
    }).callTool(searchInvocation(), new AbortController().signal);
    expect(internal).toMatchObject({
      outcome: 'toolError',
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(JSON.stringify(internal)).not.toContain('private canary');
  });

  it('returns INVALID_ARGUMENT for a recognized malformed tool and rejects unknown tools', async () => {
    const router = createRouter();
    await expect(
      router.callTool(
        { tool: 'read_documents', arguments: { workspaceFolderId: 'root' } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: 'toolError',
      tool: 'read_documents',
      error: { code: 'INVALID_ARGUMENT' },
    });
    await expect(
      router.callTool(
        { tool: 'read_document', arguments: {} },
        new AbortController().signal,
      ),
    ).rejects.toThrow('not recognized');
  });

  it('normalizes an aborted request to CANCELLED', async () => {
    const controller = new AbortController();
    const router = createRouter({
      searchText: {
        searchWorkspaceText: () => {
          controller.abort();
          return Promise.reject(new Error('late content'));
        },
      },
    });
    await expect(
      router.callTool(searchInvocation(), controller.signal),
    ).resolves.toEqual({
      outcome: 'toolError',
      tool: 'search_workspace_text',
      error: {
        code: 'CANCELLED',
        message: 'The request was cancelled.',
        retryable: true,
      },
    });
  });

  it('composes all thirteen tools while preserving legacy result validation', async () => {
    const legacyCalls: unknown[] = [];
    const legacy = {
      callTool(invocation: unknown) {
        legacyCalls.push(invocation);
        return Promise.resolve({
          outcome: 'toolError' as const,
          tool: 'read_document' as const,
          error: {
            code: 'DOCUMENT_NOT_FOUND' as const,
            message: 'The document could not be found.',
            retryable: false,
          },
        });
      },
    };
    const combined = new V02ExtensionToolRouter(legacy, createRouter());
    expect(combined.names).toHaveLength(13);
    await expect(
      combined.callTool(
        {
          tool: 'read_document',
          arguments: {
            document: {
              kind: 'workspacePath',
              workspaceFolderId: 'root',
              relativePath: 'missing.ts',
            },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ tool: 'read_document' });
    expect(legacyCalls).toHaveLength(1);

    await expect(
      combined.callTool(
        {
          tool: 'list_workspace_files',
          arguments: { workspaceFolderId: 'root' },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ tool: 'list_workspace_files' });
    expect(legacyCalls).toHaveLength(1);
  });
});

function createRouter(
  overrides: Partial<V02ReadToolRouterOptions> = {},
): V02ReadToolRouter {
  const options: V02ReadToolRouterOptions = {
    listFiles: {
      listWorkspaceFiles: () =>
        Promise.resolve({
          contractVersion: '0.2.0',
          instanceId,
          observedAt,
          truncated: false,
          warnings: [],
          result: {
            workspaceFolderId: 'root',
            files: ['a.ts'],
            hasMore: false,
            nextCursor: null,
          },
        }),
    },
    readDocuments: {
      readDocuments: () =>
        Promise.resolve({
          contractVersion: '0.2.0',
          instanceId,
          observedAt,
          truncated: false,
          warnings: [],
          result: {
            workspaceFolderId: 'root',
            items: [
              {
                outcome: 'error',
                error: {
                  code: 'DOCUMENT_NOT_FOUND',
                  message: 'The document was not found.',
                  retryable: false,
                },
              },
            ],
          },
        }),
    },
    searchText: {
      searchWorkspaceText: () =>
        Promise.resolve({
          contractVersion: '0.2.0',
          instanceId,
          observedAt,
          truncated: false,
          warnings: [],
          result: {
            workspaceFolderId: 'root',
            query: 'needle',
            documents: [],
            returnedMatchCount: 0,
            hasMore: false,
            nextCursor: null,
          },
        }),
    },
    ...overrides,
  };
  return new V02ReadToolRouter(options);
}

function searchInvocation() {
  return {
    tool: 'search_workspace_text',
    arguments: { workspaceFolderId: 'root', query: 'needle' },
  };
}
