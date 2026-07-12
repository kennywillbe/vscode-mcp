import { Buffer } from 'node:buffer';

import {
  PROVIDER_OUTPUT_LIMITS,
  PROTOCOL_LIMITS,
  TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import { describe, expect, it } from 'vitest';

import type {
  LanguageDefinitionKind,
  LanguageHostCallItem,
  LanguageHostDefinitionTarget,
  LanguageHostDocument,
  LanguageHostDocumentSymbols,
  LanguageHostHierarchicalSymbol,
  LanguageHostIncomingCall,
  LanguageHostOutgoingCall,
  LanguageHostProviderBatch,
  LanguageHostReference,
  LanguageHostWorkspaceSymbol,
  LanguageLocationToolHost,
} from './language-location-tool-host.js';
import { LanguageLocationToolService } from './language-location-tool-service.js';
import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

const NOW = new Date('2026-07-10T10:00:00.000Z');
const PATHS = createWorkspaceAuthorizationPathStrategy('posix');

describe('LanguageLocationToolService', () => {
  it('normalizes, reauthorizes, deduplicates, and sorts all definition kinds', async () => {
    const source = createDocument('file:///workspace/source.ts', 'use(value);', {
      version: 4,
      dirty: true,
    });
    const alpha = createDocument(
      'file:///workspace/alpha.ts',
      'export const alpha = 1;',
    );
    const beta = createDocument('file:///workspace/beta.ts', 'export const beta = 2;');
    const host = new FakeLanguageHost([source.document, alpha.document, beta.document]);
    host.definitionProvider = (kind) => {
      host.seenKinds.push(kind);
      return Promise.resolve(
        resultBatch([
          location(beta.document.uri, range(0, 13, 0, 17)),
          locationLink(
            alpha.document.uri,
            range(0, 0, 0, 23),
            range(0, 13, 0, 18),
            range(0, 4, 0, 9),
          ),
          location(beta.document.uri, range(0, 13, 0, 17)),
          location('file:///outside/private-name.ts', range(0, 0, 0, 1)),
          null,
        ]),
      );
    };
    const service = createService(host);

    for (const kind of [
      'definition',
      'declaration',
      'typeDefinition',
      'implementation',
    ] as const) {
      const response = await service.callTool(
        invocation('get_definition', {
          document: documentRef(source.document.uri),
          position: position(0, 4),
          expectedDocumentVersion: 4,
          kind,
        }),
        new AbortController().signal,
      );

      expect(response).toMatchObject({
        outcome: 'success',
        truncated: true,
        warnings: [
          { code: 'EXTERNAL_LOCATIONS_OMITTED', omittedCount: 1 },
          { code: 'UNSUPPORTED_ITEMS_OMITTED', omittedCount: 1 },
        ],
        payload: {
          tool: 'get_definition',
          result: {
            document: { documentVersion: 4, isDirty: true },
            kind,
            locations: [
              {
                uri: alpha.document.uri,
                targetSelectionRange: range(0, 13, 0, 18),
                originSelectionRange: range(0, 4, 0, 9),
              },
              {
                uri: beta.document.uri,
                targetRange: range(0, 13, 0, 17),
                targetSelectionRange: range(0, 13, 0, 17),
                originSelectionRange: null,
              },
            ],
          },
        },
      });
      expect(JSON.stringify(response)).not.toContain('private-name');
      expect(JSON.stringify(response)).not.toContain('/outside');
    }
    expect(host.seenKinds).toEqual([
      'definition',
      'declaration',
      'typeDefinition',
      'implementation',
    ]);
  });

  it('validates inputs and positions before invoking a provider', async () => {
    const source = createDocument('file:///workspace/source.ts', 'abc');
    const host = new FakeLanguageHost([source.document]);
    let providerCalls = 0;
    host.definitionProvider = () => {
      providerCalls += 1;
      return Promise.resolve(resultBatch([]));
    };
    const service = createService(host);

    const extra = await service.callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        unexpected: true,
      }),
      new AbortController().signal,
    );
    const outOfRange = await service.callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 4),
      }),
      new AbortController().signal,
    );
    const versionMismatch = await service.callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        expectedDocumentVersion: 99,
      }),
      new AbortController().signal,
    );

    expect(extra).toMatchObject({
      outcome: 'toolError',
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(outOfRange).toMatchObject({
      outcome: 'toolError',
      error: { code: 'POSITION_OUT_OF_RANGE' },
    });
    expect(versionMismatch).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_VERSION_MISMATCH' },
    });
    expect(providerCalls).toBe(0);
  });

  it('discards a late provider result after cancellation or document mutation', async () => {
    const source = createDocument('file:///workspace/source.ts', 'abc', { version: 2 });
    const host = new FakeLanguageHost([source.document]);
    const pending = deferred<LanguageHostProviderBatch<LanguageHostDefinitionTarget>>();
    let providerCalls = 0;
    host.definitionProvider = () => {
      providerCalls += 1;
      return pending.promise;
    };
    const service = createService(host);
    const controller = new AbortController();
    const call = service.callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 1),
      }),
      controller.signal,
    );
    await waitFor(() => providerCalls === 1);
    controller.abort();
    await expect(remainsPending(call, 25)).resolves.toBe(true);
    pending.resolve(resultBatch([location(source.document.uri, range(0, 0, 0, 1))]));
    const cancelled = await call;
    expect(cancelled).toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED', retryable: true },
    });

    host.definitionProvider = () => {
      source.version = 3;
      return Promise.resolve(resultBatch([]));
    };
    const changed = await service.callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 1),
        expectedDocumentVersion: 2,
      }),
      new AbortController().signal,
    );
    expect(changed).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_CHANGED_DURING_REQUEST', retryable: true },
    });
  });

  it('holds execution until cancelled stat and open operations actually settle', async () => {
    const source = createDocument('file:///workspace/closed.ts', 'abc');
    const statHost = new FakeLanguageHost([]);
    const pendingStat = deferred<{ readonly size: number; readonly isFile: boolean }>();
    let statEntered = false;
    statHost.statFile = () => {
      statEntered = true;
      return pendingStat.promise;
    };
    const statController = new AbortController();
    const statCall = createService(statHost).callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
      }),
      statController.signal,
    );
    await waitFor(() => statEntered);
    statController.abort();
    await expect(remainsPending(statCall, 25)).resolves.toBe(true);
    pendingStat.resolve({ size: 3, isFile: true });
    await expect(statCall).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED' },
    });
    expect(statHost.openCalls).toEqual([]);

    const openHost = new FakeLanguageHost([]);
    const pendingOpen = deferred<LanguageHostDocument>();
    let openEntered = false;
    openHost.openTextDocument = () => {
      openEntered = true;
      return pendingOpen.promise;
    };
    const openController = new AbortController();
    const openCall = createService(openHost).callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
      }),
      openController.signal,
    );
    await waitFor(() => openEntered);
    openController.abort();
    await expect(remainsPending(openCall, 25)).resolves.toBe(true);
    pendingOpen.resolve(source.document);
    await expect(openCall).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED' },
    });
  });

  it('stops lazy open-document lookup at the target and at its raw scan cap', async () => {
    const source = createDocument('file:///workspace/source.ts', 'abc');
    let targetPulls = 0;
    const targetFirst: Iterable<LanguageHostDocument> = {
      [Symbol.iterator](): Iterator<LanguageHostDocument> {
        return {
          next(): IteratorResult<LanguageHostDocument> {
            targetPulls += 1;
            if (targetPulls === 1) {
              return { done: false, value: source.document };
            }
            throw new Error('The open-document suffix was consumed after a match.');
          },
        };
      },
    };
    const targetResponse = await createService(
      new FakeLanguageHost(targetFirst),
    ).callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
      }),
      new AbortController().signal,
    );
    expect(targetResponse).toMatchObject({ outcome: 'success' });
    expect(targetPulls).toBe(1);

    const outside = createDocument('file:///outside/decoy.ts', 'abc');
    let cappedPulls = 0;
    const endlessDecoys: Iterable<LanguageHostDocument> = {
      [Symbol.iterator](): Iterator<LanguageHostDocument> {
        return {
          next(): IteratorResult<LanguageHostDocument> {
            if (cappedPulls >= PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax) {
              throw new Error('The open-document scan crossed its raw limit.');
            }
            cappedPulls += 1;
            return { done: false, value: outside.document };
          },
        };
      },
    };
    const cappedHost = new FakeLanguageHost(endlessDecoys);
    cappedHost.openedDocument = source.document;
    const cappedResponse = await createService(cappedHost).callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
      }),
      new AbortController().signal,
    );
    expect(cappedResponse).toMatchObject({ outcome: 'success' });
    expect(cappedPulls).toBe(PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax);
  });

  it('rejects an oversized closed document before asking VS Code to open it', async () => {
    const source = createDocument('file:///workspace/closed.ts', 'abc');
    const host = new FakeLanguageHost([]);
    host.openedDocument = source.document;
    host.fileStat = {
      size: TOOL_LIMITS.readDocument.closedFileBytes + 1,
      isFile: true,
    };

    const response = await createService(host).callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
      }),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: {
        code: 'DOCUMENT_TOO_LARGE',
        details: {
          maximumBytes: TOOL_LIMITS.readDocument.closedFileBytes,
          actualBytes: TOOL_LIMITS.readDocument.closedFileBytes + 1,
        },
      },
    });
    expect(host.statCalls).toEqual(['/workspace/closed.ts']);
    expect(host.openCalls).toEqual([]);
  });

  it('rejects a version change during the final workspace eligibility check', async () => {
    const source = createDocument('file:///workspace/source.ts', 'abc', { version: 2 });
    const host = new FakeLanguageHost([source.document]);
    host.definitionProvider = () =>
      Promise.resolve(resultBatch([location(source.document.uri, range(0, 0, 0, 1))]));
    let accessChecks = 0;
    const service = createService(host, {
      getAccess: () => {
        accessChecks += 1;
        if (accessChecks === 3) {
          source.version = 3;
        }
        return { eligible: true as const, identity: workspaceIdentity() };
      },
    });

    const response = await service.callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        expectedDocumentVersion: 2,
      }),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_CHANGED_DURING_REQUEST', retryable: true },
    });
    expect(accessChecks).toBe(3);
  });

  it('filters declarations, returns dirty-buffer context, and orders references', async () => {
    const source = createDocument(
      'file:///workspace/source.ts',
      'target();\ntarget();',
      {
        version: 7,
        dirty: true,
      },
    );
    const other = createDocument('file:///workspace/other.ts', 'target();');
    const host = new FakeLanguageHost([source.document, other.document]);
    host.referenceProvider = () =>
      Promise.resolve(
        resultBatch([
          reference(source.document.uri, range(1, 0, 1, 6)),
          reference(other.document.uri, range(0, 0, 0, 6)),
          reference(source.document.uri, range(0, 0, 0, 6)),
          reference(other.document.uri, range(0, 0, 0, 6)),
        ]),
      );
    host.definitionProvider = (kind) =>
      Promise.resolve(
        kind === 'declaration'
          ? resultBatch([location(source.document.uri, range(0, 0, 0, 6))])
          : resultBatch([]),
      );
    const service = createService(host);

    const response = await service.callTool(
      invocation('find_references', {
        document: documentRef(source.document.uri),
        position: position(0, 1),
        expectedDocumentVersion: 7,
        contextLines: 0,
      }),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      payload: {
        tool: 'find_references',
        result: {
          references: [
            {
              uri: other.document.uri,
              context: {
                text: 'target();',
                documentVersion: 1,
                isDirty: false,
              },
            },
            {
              uri: source.document.uri,
              range: range(1, 0, 1, 6),
              context: {
                text: 'target();',
                documentVersion: 7,
                isDirty: true,
              },
            },
          ],
        },
      },
    });
  });

  it('drops optional reference context before locations at the output budget', async () => {
    const longLine = `${'x'.repeat(3_900)}()`;
    const source = createDocument(
      'file:///workspace/large.ts',
      Array.from({ length: 110 }, () => longLine).join('\n'),
    );
    const host = new FakeLanguageHost([source.document]);
    host.referenceProvider = () =>
      Promise.resolve(
        resultBatch(
          Array.from({ length: 110 }, (_, line) =>
            reference(source.document.uri, range(line, 0, line, 1)),
          ),
        ),
      );
    const service = createService(host);

    const response = await service.callTool(
      invocation('find_references', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        includeDeclaration: true,
        limit: 200,
      }),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      truncated: true,
      warnings: [{ code: 'CONTENT_TRUNCATED' }],
      payload: {
        tool: 'find_references',
        result: { references: { length: 110 } },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(
      PROTOCOL_LIMITS.mcpResultBytes,
    );
    if (response.outcome === 'success' && response.payload.tool === 'find_references') {
      expect(
        response.payload.result.references.some((item) => item.context === null),
      ).toBe(true);
    }
  });

  it('flattens hierarchical symbols in preorder with stable parent IDs and limits', async () => {
    const source = createDocument(
      'file:///workspace/source.ts',
      'class A {\n  method() {}\n}',
    );
    const host = new FakeLanguageHost([source.document]);
    host.documentSymbols = {
      state: 'result',
      shape: 'hierarchical',
      omittedCount: 0,
      items: [
        {
          name: 'A',
          detail: '',
          kind: 'Class',
          range: range(0, 0, 2, 1),
          selectionRange: range(0, 6, 0, 7),
          deprecated: false,
          children: [
            {
              name: 'method',
              detail: '()',
              kind: 'Method',
              range: range(1, 2, 1, 13),
              selectionRange: range(1, 2, 1, 8),
              deprecated: true,
              children: [],
            },
          ],
        },
        {
          name: 'tail',
          detail: '',
          kind: 'Variable',
          range: range(2, 0, 2, 1),
          selectionRange: range(2, 0, 2, 1),
          deprecated: false,
          children: [],
        },
      ],
    };
    const service = createService(host);

    const response = await service.callTool(
      invocation('get_document_symbols', {
        document: documentRef(source.document.uri),
        limit: 2,
      }),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
      payload: {
        tool: 'get_document_symbols',
        result: {
          providerShape: 'hierarchical',
          symbols: [
            { id: 's0', parentId: null, name: 'A' },
            { id: 's1', parentId: 's0', name: 'method', deprecated: true },
          ],
        },
      },
    });
  });

  it('reauthorizes flat document symbols and preserves workspace-symbol relevance', async () => {
    const source = createDocument('file:///workspace/source.ts', 'abc');
    const second = createDocument('file:///workspace/second.ts', 'def');
    const host = new FakeLanguageHost([source.document, second.document]);
    host.documentSymbols = {
      state: 'result',
      shape: 'flat',
      omittedCount: 0,
      items: [
        flatSymbol('inside', source.document.uri, range(0, 0, 0, 3)),
        flatSymbol('wrong-document', second.document.uri, range(0, 0, 0, 3)),
        flatSymbol('external-secret', 'file:///outside/secret.ts', range(0, 0, 0, 1)),
      ],
    };
    host.workspaceSymbolProvider = () =>
      Promise.resolve(
        resultBatch([
          workspaceSymbol('z-relevant-first', second.document.uri),
          workspaceSymbol('a-relevant-second', source.document.uri),
          workspaceSymbol('private', 'file:///outside/private.ts'),
        ]),
      );
    const service = createService(host);

    const documentResponse = await service.callTool(
      invocation('get_document_symbols', {
        document: documentRef(source.document.uri),
      }),
      new AbortController().signal,
    );
    expect(documentResponse).toMatchObject({
      outcome: 'success',
      payload: {
        tool: 'get_document_symbols',
        result: { providerShape: 'flat', symbols: [{ name: 'inside' }] },
      },
    });
    expect(JSON.stringify(documentResponse)).not.toContain('external-secret');

    const workspaceResponse = await service.callTool(
      invocation('search_workspace_symbols', { query: 'relevant' }),
      new AbortController().signal,
    );
    expect(workspaceResponse).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'EXTERNAL_LOCATIONS_OMITTED', omittedCount: 1 }],
      payload: {
        tool: 'search_workspace_symbols',
        result: {
          query: 'relevant',
          symbols: [{ name: 'z-relevant-first' }, { name: 'a-relevant-second' }],
        },
      },
    });
    expect(JSON.stringify(workspaceResponse)).not.toContain('/outside');
  });

  it('returns one call-hierarchy level with filtered roots and deterministic calls', async () => {
    const source = createDocument('file:///workspace/source.ts', 'root();\ncaller();');
    const caller = createDocument('file:///workspace/caller.ts', 'root();');
    const callee = createDocument('file:///workspace/callee.ts', 'callee();');
    const host = new FakeLanguageHost([
      source.document,
      caller.document,
      callee.document,
    ]);
    const root = callItem('root', source.document.uri, range(0, 0, 0, 6));
    host.callRoots = resultBatch([
      callItem('external-root', 'file:///outside/root.ts', range(0, 0, 0, 1)),
      root,
    ]);
    host.incomingCalls = resultBatch([
      {
        from: callItem('caller', caller.document.uri, range(0, 0, 0, 6)),
        callSiteRanges: [range(0, 0, 0, 4), range(0, 0, 0, 4)],
      },
      {
        from: callItem('private', 'file:///outside/private.ts', range(0, 0, 0, 1)),
        callSiteRanges: [],
      },
    ]);
    host.outgoingCalls = resultBatch([
      {
        to: callItem('callee', callee.document.uri, range(0, 0, 0, 8)),
        callSiteRanges: [range(0, 0, 0, 4)],
      },
    ]);
    const service = createService(host);

    const response = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 1),
        direction: 'both',
      }),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'EXTERNAL_LOCATIONS_OMITTED', omittedCount: 2 }],
      payload: {
        tool: 'get_call_hierarchy',
        result: {
          roots: [{ name: 'root' }],
          selectedRootIndex: 0,
          incoming: [{ from: { name: 'caller' }, callSiteRanges: { length: 1 } }],
          outgoing: [{ to: { name: 'callee' }, callSiteRanges: { length: 1 } }],
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain('private');

    const incomingOnly = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 1),
        direction: 'incoming',
      }),
      new AbortController().signal,
    );
    expect(incomingOnly).toMatchObject({
      outcome: 'success',
      payload: { tool: 'get_call_hierarchy', result: { outgoing: null } },
    });
  });

  it('discards call-hierarchy output if the selected root document changes late', async () => {
    const source = createDocument('file:///workspace/source.ts', 'use(root);');
    const rootDocument = createDocument('file:///workspace/root.ts', 'root();', {
      version: 3,
    });
    const host = new FakeLanguageHost([source.document, rootDocument.document]);
    host.callRoots = resultBatch([
      callItem('root', rootDocument.document.uri, range(0, 0, 0, 6)),
    ]);
    let accessChecks = 0;
    const service = createService(host, {
      getAccess: () => {
        accessChecks += 1;
        if (accessChecks === 4) {
          rootDocument.version = 4;
        }
        return { eligible: true as const, identity: workspaceIdentity() };
      },
    });

    const response = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 4),
        direction: 'incoming',
      }),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_CHANGED_DURING_REQUEST', retryable: true },
    });
    expect(accessChecks).toBe(4);
  });

  it('fails closed on symlink escapes and workspace eligibility changes', async () => {
    const source = createDocument('file:///workspace/source.ts', 'abc');
    const host = new FakeLanguageHost([source.document]);
    const escaped = createService(host, {
      realpath: async (path) =>
        path === '/workspace/link.ts' ? '/outside/private.ts' : path,
    });
    const escapeResponse = await escaped.callTool(
      invocation('get_definition', {
        document: documentRef('file:///workspace/link.ts'),
        position: position(0, 0),
      }),
      new AbortController().signal,
    );
    expect(escapeResponse).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_OUTSIDE_WORKSPACE' },
    });

    let checks = 0;
    const changing = createService(host, {
      getAccess: () => {
        checks += 1;
        return checks === 1
          ? { eligible: true as const, identity: workspaceIdentity() }
          : { eligible: false as const };
      },
    });
    const changed = await changing.callTool(
      invocation('search_workspace_symbols', { query: 'abc' }),
      new AbortController().signal,
    );
    expect(changed).toMatchObject({
      outcome: 'toolError',
      error: { code: 'WORKSPACE_UNTRUSTED' },
    });
  });

  it('enforces exact and plus-one flat provider scan limits before reading the suffix', async () => {
    const source = createDocument('file:///workspace/source.ts', 'root();');
    const host = new FakeLanguageHost([source.document]);
    const service = createService(host);
    const definitionValue = location(source.document.uri, range(0, 0, 0, 4));
    const referenceValue = reference(source.document.uri, range(0, 0, 0, 4));
    const workspaceValue = workspaceSymbol('root', source.document.uri);
    const callValue = callItem('root', source.document.uri, range(0, 0, 0, 4));

    host.definitionProvider = () =>
      Promise.resolve(
        resultBatch(
          guardedProviderArray(
            PROVIDER_OUTPUT_LIMITS.definition.itemsMax,
            PROVIDER_OUTPUT_LIMITS.definition.itemsMax,
            () => definitionValue,
          ),
        ),
      );
    const exactDefinition = await service.callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
      }),
      new AbortController().signal,
    );
    expect(exactDefinition).toMatchObject({ outcome: 'success', warnings: [] });

    host.definitionProvider = () =>
      Promise.resolve(
        resultBatch(
          guardedProviderArray(
            PROVIDER_OUTPUT_LIMITS.definition.itemsMax + 1,
            PROVIDER_OUTPUT_LIMITS.definition.itemsMax,
            (index) => (index === 0 ? null : definitionValue),
          ),
          Number.MAX_SAFE_INTEGER,
        ),
      );
    const boundedDefinition = await service.callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
      }),
      new AbortController().signal,
    );
    expect(boundedDefinition).toMatchObject({
      outcome: 'success',
      warnings: [
        { code: 'RESULTS_TRUNCATED', omittedCount: Number.MAX_SAFE_INTEGER },
        { code: 'UNSUPPORTED_ITEMS_OMITTED', omittedCount: 1 },
      ],
    });

    host.referenceProvider = () =>
      Promise.resolve(
        resultBatch(
          guardedProviderArray(
            PROVIDER_OUTPUT_LIMITS.references.itemsMax + 1,
            PROVIDER_OUTPUT_LIMITS.references.itemsMax,
            () => referenceValue,
          ),
        ),
      );
    const boundedReferences = await service.callTool(
      invocation('find_references', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        includeDeclaration: true,
      }),
      new AbortController().signal,
    );
    expect(boundedReferences).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
    });

    host.workspaceSymbolProvider = () =>
      Promise.resolve(
        resultBatch(
          guardedProviderArray(
            PROVIDER_OUTPUT_LIMITS.workspaceSymbols.itemsMax + 1,
            PROVIDER_OUTPUT_LIMITS.workspaceSymbols.itemsMax,
            () => workspaceValue,
          ),
        ),
      );
    const boundedWorkspaceSymbols = await service.callTool(
      invocation('search_workspace_symbols', { query: 'root' }),
      new AbortController().signal,
    );
    expect(boundedWorkspaceSymbols).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
    });

    host.callRoots = resultBatch(
      guardedProviderArray(
        PROVIDER_OUTPUT_LIMITS.callHierarchy.rootsMax + 1,
        PROVIDER_OUTPUT_LIMITS.callHierarchy.rootsMax,
        () => callValue,
      ),
    );
    const boundedRoots = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        direction: 'incoming',
      }),
      new AbortController().signal,
    );
    expect(boundedRoots).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
      payload: { tool: 'get_call_hierarchy', result: { roots: [{ name: 'root' }] } },
    });
  });

  it('bounds hierarchical symbol width and depth while preserving cycle handling', async () => {
    const source = createDocument('file:///workspace/source.ts', 'symbol');
    const host = new FakeLanguageHost([source.document]);
    const service = createService(host);

    host.documentSymbols = {
      state: 'result',
      shape: 'hierarchical',
      omittedCount: 0,
      items: guardedProviderArray(
        PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax + 1,
        PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax,
        () => null,
      ),
    };
    const wide = await service.callTool(
      invocation('get_document_symbols', {
        document: documentRef(source.document.uri),
      }),
      new AbortController().signal,
    );
    expect(wide).toMatchObject({
      outcome: 'success',
      warnings: [
        { code: 'RESULTS_TRUNCATED', omittedCount: 1 },
        {
          code: 'UNSUPPORTED_ITEMS_OMITTED',
          omittedCount: PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax,
        },
      ],
    });

    let child: LanguageHostHierarchicalSymbol | null = null;
    for (
      let depth = PROVIDER_OUTPUT_LIMITS.documentSymbols.depthMax + 1;
      depth >= 0;
      depth -= 1
    ) {
      child = hierarchicalSymbol(`depth-${depth}`, child === null ? [] : [child]);
    }
    host.documentSymbols = {
      state: 'result',
      shape: 'hierarchical',
      omittedCount: 0,
      items: [child],
    };
    const deep = await service.callTool(
      invocation('get_document_symbols', {
        document: documentRef(source.document.uri),
        limit: TOOL_LIMITS.documentSymbols.itemsMax,
      }),
      new AbortController().signal,
    );
    expect(deep).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
      payload: {
        tool: 'get_document_symbols',
        result: {
          symbols: {
            length: PROVIDER_OUTPUT_LIMITS.documentSymbols.depthMax + 1,
          },
        },
      },
    });

    const cycle = hierarchicalSymbol('cycle', []);
    cycle.children.push(cycle);
    host.documentSymbols = {
      state: 'result',
      shape: 'hierarchical',
      omittedCount: 0,
      items: [cycle],
    };
    const cyclic = await service.callTool(
      invocation('get_document_symbols', {
        document: documentRef(source.document.uri),
      }),
      new AbortController().signal,
    );
    expect(cyclic).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'UNSUPPORTED_ITEMS_OMITTED', omittedCount: 1 }],
      payload: {
        tool: 'get_document_symbols',
        result: { symbols: [{ name: 'cycle' }] },
      },
    });
  });

  it('enforces nested call-site exact, plus-one, and invalid-prefix limits', async () => {
    const source = createDocument(
      'file:///workspace/source.ts',
      'x'.repeat(PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax + 2),
    );
    const host = new FakeLanguageHost([source.document]);
    const root = callItem('root', source.document.uri, range(0, 0, 0, 1));
    const caller = callItem('caller', source.document.uri, range(0, 0, 0, 1));
    host.callRoots = resultBatch([root]);
    const service = createService(host);

    host.incomingCalls = resultBatch([
      {
        from: caller,
        callSiteRanges: guardedProviderArray(
          PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
          PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
          (index) => range(0, index, 0, index),
        ),
      },
    ]);
    const exact = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        direction: 'incoming',
      }),
      new AbortController().signal,
    );
    expect(exact).toMatchObject({
      outcome: 'success',
      warnings: [
        {
          code: 'RESULTS_TRUNCATED',
          omittedCount:
            PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax -
            TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax,
        },
      ],
      payload: {
        tool: 'get_call_hierarchy',
        result: {
          incoming: [
            {
              callSiteRanges: {
                length: TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax,
              },
            },
          ],
        },
      },
    });

    host.incomingCalls = resultBatch([
      {
        from: caller,
        callSiteRanges: guardedProviderArray(
          PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax + 1,
          PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
          (index) => range(0, index, 0, index),
        ),
      },
    ]);
    const plusOne = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        direction: 'incoming',
      }),
      new AbortController().signal,
    );
    expect(plusOne).toMatchObject({
      outcome: 'success',
      warnings: [
        {
          code: 'RESULTS_TRUNCATED',
          omittedCount:
            PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax -
            TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax +
            1,
        },
      ],
    });

    host.incomingCalls = resultBatch([
      {
        from: caller,
        callSiteRanges: guardedProviderArray(
          PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
          PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
          (index) => (index === 0 ? null : range(0, index, 0, index)),
        ),
      },
    ]);
    const invalidPrefix = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        direction: 'incoming',
      }),
      new AbortController().signal,
    );
    expect(invalidPrefix).toMatchObject({
      outcome: 'success',
      warnings: [
        {
          code: 'RESULTS_TRUNCATED',
          omittedCount:
            PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax -
            TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax -
            1,
        },
        { code: 'UNSUPPORTED_ITEMS_OMITTED', omittedCount: 1 },
      ],
    });
  });

  it('enforces call-direction range and call-count caps before reading suffixes', async () => {
    const source = createDocument('file:///workspace/source.ts', 'x'.repeat(1_100));
    const host = new FakeLanguageHost([source.document]);
    host.callRoots = resultBatch([
      callItem('root', source.document.uri, range(0, 0, 0, 1)),
    ]);
    const service = createService(host);
    const calls: LanguageHostIncomingCall[] = [];
    for (let callIndex = 0; callIndex < 4; callIndex += 1) {
      calls.push({
        from: callItem(`caller-${callIndex}`, source.document.uri, range(0, 0, 0, 1)),
        callSiteRanges: guardedProviderArray(
          PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
          PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
          (index) => range(0, index, 0, index),
        ),
      });
    }
    calls.push({
      from: callItem('caller-4', source.document.uri, range(0, 0, 0, 1)),
      callSiteRanges: guardedProviderArray(1, 0, () => range(0, 0, 0, 0)),
    });
    host.incomingCalls = resultBatch(calls);

    const rangeBounded = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        direction: 'incoming',
        limitPerDirection: 10,
      }),
      new AbortController().signal,
    );
    expect(rangeBounded).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 3_001 }],
      payload: {
        tool: 'get_call_hierarchy',
        result: {
          incoming: { length: 5 },
        },
      },
    });

    const emptyCall: LanguageHostIncomingCall = {
      from: callItem('same-caller', source.document.uri, range(0, 0, 0, 1)),
      callSiteRanges: [],
    };
    host.incomingCalls = resultBatch(
      guardedProviderArray(
        PROVIDER_OUTPUT_LIMITS.callHierarchy.callsPerDirectionMax + 1,
        PROVIDER_OUTPUT_LIMITS.callHierarchy.callsPerDirectionMax,
        () => emptyCall,
      ),
    );
    const callsBounded = await service.callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        direction: 'incoming',
      }),
      new AbortController().signal,
    );
    expect(callsBounded).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
      payload: {
        tool: 'get_call_hierarchy',
        result: { incoming: [{ from: { name: 'same-caller' } }] },
      },
    });
  });

  it('merges duplicate call items incrementally and caps their unique ranges', async () => {
    const source = createDocument('file:///workspace/source.ts', 'x'.repeat(301));
    const host = new FakeLanguageHost([source.document]);
    host.callRoots = resultBatch([
      callItem('root', source.document.uri, range(0, 0, 0, 1)),
    ]);
    const caller = callItem('caller', source.document.uri, range(0, 0, 0, 1));
    host.incomingCalls = resultBatch([
      {
        from: caller,
        callSiteRanges: Array.from({ length: 200 }, (_, index) =>
          range(0, index, 0, index),
        ),
      },
      {
        from: caller,
        callSiteRanges: Array.from({ length: 200 }, (_, index) =>
          range(0, index + 100, 0, index + 100),
        ),
      },
    ]);

    const response = await createService(host).callTool(
      invocation('get_call_hierarchy', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
        direction: 'incoming',
      }),
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 50 }],
      payload: {
        tool: 'get_call_hierarchy',
        result: {
          incoming: [
            {
              from: { name: 'caller' },
              callSiteRanges: {
                length: TOOL_LIMITS.callHierarchy.callSiteRangesPerItemMax,
              },
            },
          ],
        },
      },
    });
    if (
      response.outcome === 'success' &&
      response.payload.tool === 'get_call_hierarchy'
    ) {
      expect(response.payload.result.incoming?.[0]?.callSiteRanges.at(-1)).toEqual(
        range(0, 249, 0, 249),
      );
    }
  });

  it('reports provider no-result without claiming truncation', async () => {
    const source = createDocument('file:///workspace/source.ts', 'abc');
    const host = new FakeLanguageHost([source.document]);
    host.definitionProvider = () => Promise.resolve({ state: 'noResult' });
    const response = await createService(host).callTool(
      invocation('get_definition', {
        document: documentRef(source.document.uri),
        position: position(0, 0),
      }),
      new AbortController().signal,
    );
    expect(response).toMatchObject({
      outcome: 'success',
      truncated: false,
      warnings: [{ code: 'PROVIDER_RETURNED_NO_RESULT' }],
      payload: { tool: 'get_definition', result: { locations: [] } },
    });
  });
});

class FakeLanguageHost implements LanguageLocationToolHost {
  public readonly seenKinds: LanguageDefinitionKind[] = [];
  public definitionProvider: (
    kind: LanguageDefinitionKind,
  ) => Promise<LanguageHostProviderBatch<LanguageHostDefinitionTarget>> = () =>
    Promise.resolve(resultBatch([]));
  public referenceProvider: () => Promise<
    LanguageHostProviderBatch<LanguageHostReference>
  > = () => Promise.resolve(resultBatch([]));
  public documentSymbols: LanguageHostDocumentSymbols = {
    state: 'result',
    shape: 'hierarchical',
    omittedCount: 0,
    items: [],
  };
  public workspaceSymbolProvider: () => Promise<
    LanguageHostProviderBatch<LanguageHostWorkspaceSymbol>
  > = () => Promise.resolve(resultBatch([]));
  public callRoots: LanguageHostProviderBatch<LanguageHostCallItem> = resultBatch([]);
  public incomingCalls: LanguageHostProviderBatch<LanguageHostIncomingCall> =
    resultBatch([]);
  public outgoingCalls: LanguageHostProviderBatch<LanguageHostOutgoingCall> =
    resultBatch([]);
  public fileStat = { size: 0, isFile: true };
  public openedDocument: LanguageHostDocument | null = null;
  public readonly statCalls: string[] = [];
  public readonly openCalls: string[] = [];

  public constructor(public readonly documents: Iterable<LanguageHostDocument>) {}

  public openDocuments(): Iterable<LanguageHostDocument> {
    return this.documents;
  }

  public statFile(canonicalPath: string): Promise<{
    readonly size: number;
    readonly isFile: boolean;
  }> {
    this.statCalls.push(canonicalPath);
    return Promise.resolve(this.fileStat);
  }

  public openTextDocument(uri: string): Promise<LanguageHostDocument> {
    this.openCalls.push(uri);
    let document = this.openedDocument?.uri === uri ? this.openedDocument : undefined;
    if (document === undefined) {
      for (const candidate of this.documents) {
        if (candidate.uri === uri) {
          document = candidate;
          break;
        }
      }
    }
    return document === undefined
      ? Promise.reject(new Error('not found'))
      : Promise.resolve(document);
  }

  public provideDefinition(
    kind: LanguageDefinitionKind,
  ): Promise<LanguageHostProviderBatch<LanguageHostDefinitionTarget>> {
    return this.definitionProvider(kind);
  }

  public provideReferences(): Promise<
    LanguageHostProviderBatch<LanguageHostReference>
  > {
    return this.referenceProvider();
  }

  public provideDocumentSymbols(): Promise<LanguageHostDocumentSymbols> {
    return Promise.resolve(this.documentSymbols);
  }

  public provideWorkspaceSymbols(): Promise<
    LanguageHostProviderBatch<LanguageHostWorkspaceSymbol>
  > {
    return this.workspaceSymbolProvider();
  }

  public prepareCallHierarchy(): Promise<
    LanguageHostProviderBatch<LanguageHostCallItem>
  > {
    return Promise.resolve(this.callRoots);
  }

  public provideIncomingCalls(): Promise<
    LanguageHostProviderBatch<LanguageHostIncomingCall>
  > {
    return Promise.resolve(this.incomingCalls);
  }

  public provideOutgoingCalls(): Promise<
    LanguageHostProviderBatch<LanguageHostOutgoingCall>
  > {
    return Promise.resolve(this.outgoingCalls);
  }
}

interface MutableDocument {
  readonly document: LanguageHostDocument;
  version: number;
  dirty: boolean;
}

function createDocument(
  uri: string,
  text: string,
  options: { readonly version?: number; readonly dirty?: boolean } = {},
): MutableDocument {
  const lines = text.split('\n');
  const fixture: MutableDocument = {
    version: options.version ?? 1,
    dirty: options.dirty ?? false,
    document: {
      uri,
      languageId: 'typescript',
      get version(): number {
        return fixture.version;
      },
      get isDirty(): boolean {
        return fixture.dirty;
      },
      lineCount: lines.length,
      eol: 'LF',
      lineText(line: number): string {
        const value = lines[line];
        if (value === undefined) {
          throw new RangeError('line out of range');
        }
        return value;
      },
    },
  };
  return fixture;
}

function location(
  uri: string,
  locationRange: ReturnType<typeof range>,
): LanguageHostDefinitionTarget {
  return { shape: 'location', uri, range: locationRange };
}

function locationLink(
  targetUri: string,
  targetRange: ReturnType<typeof range>,
  targetSelectionRange: ReturnType<typeof range>,
  originSelectionRange: ReturnType<typeof range>,
): LanguageHostDefinitionTarget {
  return {
    shape: 'locationLink',
    targetUri,
    targetRange,
    targetSelectionRange,
    originSelectionRange,
  };
}

function reference(
  uri: string,
  referenceRange: ReturnType<typeof range>,
): LanguageHostReference {
  return { uri, range: referenceRange };
}

function flatSymbol(name: string, uri: string, symbolRange: ReturnType<typeof range>) {
  return {
    name,
    kind: 'Variable',
    containerName: '',
    uri,
    range: symbolRange,
    deprecated: false,
  };
}

function workspaceSymbol(name: string, uri: string): LanguageHostWorkspaceSymbol {
  return {
    name,
    kind: 'Function',
    containerName: '',
    uri,
    range: range(0, 0, 0, 1),
  };
}

interface MutableHierarchicalSymbolFixture extends LanguageHostHierarchicalSymbol {
  readonly children: Array<LanguageHostHierarchicalSymbol | null>;
}

function hierarchicalSymbol(
  name: string,
  children: Array<LanguageHostHierarchicalSymbol | null>,
): MutableHierarchicalSymbolFixture {
  return {
    name,
    detail: '',
    kind: 'Function',
    range: range(0, 0, 0, 6),
    selectionRange: range(0, 0, 0, 6),
    deprecated: false,
    children,
  };
}

function callItem(
  name: string,
  uri: string,
  itemRange: ReturnType<typeof range>,
): LanguageHostCallItem {
  return {
    name,
    detail: '',
    kind: 'Function',
    uri,
    range: itemRange,
    selectionRange: itemRange,
    providerHandle: { name },
  };
}

function resultBatch<Item>(
  items: readonly (Item | null)[],
  omittedCount = 0,
): LanguageHostProviderBatch<Item> {
  return { state: 'result', items, omittedCount };
}

function guardedProviderArray<Item>(
  length: number,
  readableCount: number,
  valueAt: (index: number) => Item,
): readonly Item[] {
  return new Proxy(new Array<Item>(length), {
    get(target, property, receiver): unknown {
      if (typeof property === 'string') {
        const index = Number(property);
        if (
          Number.isSafeInteger(index) &&
          index >= 0 &&
          index.toString() === property
        ) {
          if (index >= readableCount) {
            throw new Error(`Provider suffix index ${property} was read.`);
          }
          return valueAt(index);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function documentRef(uri: string) {
  return { kind: 'uri' as const, uri };
}

function invocation(tool: string, arguments_: object): object {
  return { tool, arguments: arguments_ };
}

function position(line: number, character: number) {
  return { line, character };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    start: position(startLine, startCharacter),
    end: position(endLine, endCharacter),
  };
}

interface ServiceOverrides {
  readonly realpath?: (path: string) => Promise<string>;
  readonly getAccess?: () =>
    | { readonly eligible: true; readonly identity: WorkspaceIdentity }
    | { readonly eligible: false };
}

function createService(
  host: LanguageLocationToolHost,
  overrides: ServiceOverrides = {},
): LanguageLocationToolService {
  return new LanguageLocationToolService({
    host,
    getWorkspaceAccess:
      overrides.getAccess ??
      (() => ({ eligible: true, identity: workspaceIdentity() })),
    realpath: overrides.realpath ?? ((path) => Promise.resolve(path)),
    pathStrategy: PATHS,
    now: () => NOW,
  });
}

function workspaceIdentity(): WorkspaceIdentity {
  return {
    fingerprint: 'a'.repeat(64),
    displayName: 'fixture',
    workspaceFileUri: null,
    folders: [
      {
        workspaceFolderId: 'workspace',
        name: 'workspace',
        uri: 'file:///workspace',
        canonicalPath: '/workspace',
      },
    ],
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolver: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      if (resolver === undefined) {
        throw new Error('deferred resolver unavailable');
      }
      resolver(value);
    },
  };
}

async function remainsPending<Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), milliseconds)),
  ]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 100;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('The expected operation was not observed.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
