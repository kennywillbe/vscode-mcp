import { Buffer } from 'node:buffer';

import {
  PROTOCOL_LIMITS,
  PROVIDER_OUTPUT_LIMITS,
  TOOL_LIMITS,
} from '@vscode-mcp/protocol/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditorHostDocument, EditorHostFileStat } from './editor-tool-host.js';
import type {
  LanguageHostOpenDocuments,
  LanguageToolHost,
} from './language-tool-host.js';
import { LanguageToolService } from './language-tool-service.js';
import {
  readBoundedProviderItems,
  snapshotBoundedProviderItems,
  type BoundedProviderItems,
} from './provider-output-bounds.js';
import { RequestScheduler } from './request-scheduler.js';
import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

const FIXED_NOW = new Date('2026-07-10T08:00:00.000Z');
const PATHS = createWorkspaceAuthorizationPathStrategy('posix');

afterEach(() => {
  vi.useRealTimers();
});

describe('LanguageToolService hover', () => {
  it('returns dirty-buffer hover data, preserves inert command links, and caps entries', async () => {
    const live = createDocument(
      'file:///workspace/src/index.ts',
      'const 😀value = 1;',
      { dirty: true, languageId: 'typescript', version: 7 },
    );
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    host.hoverResult = Array.from({ length: 22 }, (_, index) => ({
      range: range(0, 6, 0, 13),
      contents: [
        {
          kind: 'markdown',
          value: `[value-${index}](command:malicious.run)`,
        },
      ],
    }));
    const service = createService(host);

    const response = await service.callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 8 },
          expectedDocumentVersion: 7,
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      observedAt: FIXED_NOW.toISOString(),
      truncated: true,
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 2 }],
      payload: {
        tool: 'get_hover',
        result: {
          document: {
            relativePath: 'src/index.ts',
            documentVersion: 7,
            isDirty: true,
          },
          hovers: { length: TOOL_LIMITS.hover.entriesMax },
        },
      },
    });
    expect(JSON.stringify(response)).toContain('command:malicious.run');
    expect(host.hoverCalls).toEqual([
      {
        uri: live.document.uri,
        position: { line: 0, character: 8 },
      },
    ]);
  });

  it('truncates combined hover text on a Unicode scalar boundary', async () => {
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    host.hoverResult = [
      {
        range: null,
        contents: [{ kind: 'plaintext', value: '😀'.repeat(20_000) }],
      },
    ];

    const response = await createService(host).callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 5 },
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'CONTENT_TRUNCATED' }],
    });
    if (response.outcome !== 'success' || response.payload.tool !== 'get_hover') {
      throw new Error('Expected hover success.');
    }
    const value = response.payload.result.hovers[0]?.contents[0]?.value;
    expect(value).toBeDefined();
    expect(Buffer.byteLength(value ?? '', 'utf8')).toBe(
      TOOL_LIMITS.hover.combinedTextBytes,
    );
    expect(value?.endsWith('😀')).toBe(true);
  });

  it('rejects out-of-bounds positions and symlink escapes before provider invocation', async () => {
    const live = createDocument('file:///workspace/file.ts', 'short');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const service = createService(host, {
      realpaths: new Map([['/workspace/link.ts', '/outside/secret.ts']]),
    });

    const outOfBounds = await service.callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 6 },
        },
      },
      new AbortController().signal,
    );
    expect(outOfBounds).toMatchObject({
      outcome: 'toolError',
      error: { code: 'POSITION_OUT_OF_RANGE' },
    });

    const escape = await service.callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: 'file:///workspace/link.ts' },
          position: { line: 0, character: 0 },
        },
      },
      new AbortController().signal,
    );
    expect(escape).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_OUTSIDE_WORKSPACE' },
    });
    expect(host.hoverCalls).toEqual([]);
  });

  it('discards a late provider result on cancellation', async () => {
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const deferred = createDeferred<unknown>();
    host.hoverResult = deferred.promise;
    const controller = new AbortController();
    const responsePromise = createService(host).callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 0 },
        },
      },
      controller.signal,
    );
    await waitFor(() => host.hoverCalls.length === 1);

    controller.abort();
    await expectStillPending(responsePromise);
    deferred.resolve([
      { range: null, contents: [{ kind: 'plaintext', value: 'too late' }] },
    ]);
    const response = await responsePromise;

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED', retryable: true },
    });
  });

  it('keeps execution pending until a cancelled closed-document stat settles', async () => {
    const closed = createDocument('file:///workspace/closed.ts', 'value');
    const host = new FakeLanguageHost();
    host.openByUri.set(closed.document.uri, closed.document);
    const deferred = createDeferred<EditorHostFileStat>();
    host.statResult = deferred.promise;
    const controller = new AbortController();
    const call = createService(host).callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: closed.document.uri },
          position: { line: 0, character: 0 },
        },
      },
      controller.signal,
    );
    await waitFor(() => host.statCalls.length === 1);

    controller.abort();
    await expectStillPending(call);
    deferred.resolve({ size: 100, isFile: true });
    const response = await call;

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED', retryable: true },
    });
    expect(host.hoverCalls).toEqual([]);
  });

  it('keeps execution pending until a cancelled document open settles', async () => {
    const closed = createDocument('file:///workspace/closed.ts', 'value');
    const host = new FakeLanguageHost();
    const deferred = createDeferred<EditorHostDocument>();
    host.openTextDocumentResult = deferred.promise;
    const controller = new AbortController();
    const call = createService(host).callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: closed.document.uri },
          position: { line: 0, character: 0 },
        },
      },
      controller.signal,
    );
    await waitFor(() => host.openTextDocumentCalls.length === 1);

    controller.abort();
    await expectStillPending(call);
    deferred.resolve(closed.document);
    const response = await call;

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED', retryable: true },
    });
    expect(host.hoverCalls).toEqual([]);
  });

  it('treats an empty hover collection as a normal result and sanitizes provider errors', async () => {
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const service = createService(host);

    host.hoverResult = [];
    const empty = await service.callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 0 },
        },
      },
      new AbortController().signal,
    );
    expect(empty).toMatchObject({
      outcome: 'success',
      truncated: false,
      warnings: [],
      payload: { tool: 'get_hover', result: { hovers: [] } },
    });

    host.hoverResult = Promise.reject(new Error('private provider failure detail'));
    const failed = await service.callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 0 },
        },
      },
      new AbortController().signal,
    );
    expect(failed).toMatchObject({
      outcome: 'toolError',
      error: { code: 'INTERNAL_ERROR', retryable: false },
    });
    expect(JSON.stringify(failed)).not.toContain('private provider failure detail');
  });

  it('discards provider output when the live document version changes', async () => {
    const live = createDocument('file:///workspace/file.ts', 'value', { version: 4 });
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const deferred = createDeferred<unknown>();
    host.hoverResult = deferred.promise;
    const responsePromise = createService(host).callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 0 },
          expectedDocumentVersion: 4,
        },
      },
      new AbortController().signal,
    );
    await waitFor(() => host.hoverCalls.length === 1);
    live.setVersion(5);
    host.emitDocumentChanged(live.document.uri);

    await expectStillPending(responsePromise);
    deferred.resolve([]);
    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_CHANGED_DURING_REQUEST', retryable: true },
    });
  });

  it('rechecks workspace eligibility after the provider returns', async () => {
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    let accessCalls = 0;
    const service = createService(host, {
      getAccess: () => {
        accessCalls += 1;
        return accessCalls === 1
          ? { eligible: true, identity: workspaceIdentity() }
          : { eligible: false };
      },
    });

    const response = await service.callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 0 },
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'WORKSPACE_UNTRUSTED' },
    });
    expect(accessCalls).toBe(2);
  });

  it('bounds nested hover contents before inspection and lets invalid prefixes consume the public budget', async () => {
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const contents = throwingIndexArray(
      Array.from(
        { length: PROVIDER_OUTPUT_LIMITS.hover.contentsPerEntryMax + 1 },
        () => ({ kind: 'invalid', value: 'ignored' }),
      ),
      PROVIDER_OUTPUT_LIMITS.hover.contentsPerEntryMax,
    );
    host.hoverResult = [{ range: null, contents }];

    const response = await createService(host).callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 0 },
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      warnings: [
        { code: 'RESULTS_TRUNCATED', omittedCount: 193 },
        { code: 'UNSUPPORTED_ITEMS_OMITTED', omittedCount: 64 },
      ],
      payload: { result: { hovers: [] } },
    });
  });

  it('enforces the raw and public hover-content request budgets across entries', async () => {
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const fullContents = (): unknown[] =>
      Array.from({ length: PROVIDER_OUTPUT_LIMITS.hover.contentsPerEntryMax }, () => ({
        kind: 'plaintext',
        value: 'x',
      }));
    const inaccessibleTail = throwingIndexArray(fullContents(), 0);
    host.hoverResult = [
      { range: null, contents: fullContents() },
      { range: null, contents: fullContents() },
      { range: null, contents: fullContents() },
      { range: null, contents: fullContents() },
      { range: null, contents: inaccessibleTail },
    ];

    const response = await createService(host).callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 0 },
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1_024 }],
      payload: { result: { hovers: { length: 4 } } },
    });
    if (response.outcome !== 'success' || response.payload.tool !== 'get_hover') {
      throw new Error('Expected hover success.');
    }
    expect(
      response.payload.result.hovers.reduce(
        (count, hover) => count + hover.contents.length,
        0,
      ),
    ).toBe(TOOL_LIMITS.hover.contentsPerRequestMax);
  });
});

describe('LanguageToolService scheduler integration', () => {
  it('keeps cancelled raw providers in active slots until they settle', async () => {
    type LanguageToolCallResult = Awaited<ReturnType<LanguageToolService['callTool']>>;
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const providerGates = Array.from(
      { length: PROTOCOL_LIMITS.activeCallsPerWindow + 1 },
      () => createDeferred<unknown>(),
    );
    host.hoverResultForCall = (callIndex) => {
      const gate = providerGates[callIndex];
      if (gate === undefined) {
        throw new Error('Missing provider gate.');
      }
      return gate.promise;
    };
    const service = createService(host);
    const scheduler = new RequestScheduler<string, LanguageToolCallResult>();
    const invocation = {
      tool: 'get_hover' as const,
      arguments: {
        document: { kind: 'uri' as const, uri: live.document.uri },
        position: { line: 0, character: 0 },
      },
    };
    const activeClients: Array<ReturnType<typeof scheduler.schedule>> = [];

    for (let requestId = 0; requestId < 4; requestId += 1) {
      for (const connectionId of ['a', 'b'] as const) {
        activeClients.push(
          scheduler.schedule({
            connectionId,
            requestId,
            timeoutMs: 60_000,
            execute: ({ signal }) => service.callTool(invocation, signal),
          }),
        );
      }
    }
    await waitFor(
      () => host.hoverCalls.length === PROTOCOL_LIMITS.activeCallsPerWindow,
    );

    const queuedClient = scheduler.schedule({
      connectionId: 'c',
      requestId: 0,
      timeoutMs: 60_000,
      execute: ({ signal }) => service.callTool(invocation, signal),
    });
    expect(scheduler.activeCount).toBe(PROTOCOL_LIMITS.activeCallsPerWindow);
    expect(scheduler.queuedCount).toBe(1);
    expect(host.hoverCalls).toHaveLength(PROTOCOL_LIMITS.activeCallsPerWindow);

    expect(scheduler.cancelConnection('a')).toBe(4);
    expect(scheduler.cancelConnection('b')).toBe(4);
    const cancelledClients = await Promise.all(activeClients);
    for (const result of cancelledClients) {
      expect(result).toMatchObject({
        outcome: 'toolError',
        error: { code: 'CANCELLED' },
      });
    }
    expect(scheduler.activeCount).toBe(PROTOCOL_LIMITS.activeCallsPerWindow);
    expect(scheduler.queuedCount).toBe(1);
    expect(host.hoverCalls).toHaveLength(PROTOCOL_LIMITS.activeCallsPerWindow);

    providerGates[0]?.resolve([]);
    await waitFor(
      () => host.hoverCalls.length === PROTOCOL_LIMITS.activeCallsPerWindow + 1,
    );
    expect(scheduler.activeCount).toBe(PROTOCOL_LIMITS.activeCallsPerWindow);
    expect(scheduler.queuedCount).toBe(0);

    expect(scheduler.cancelConnection('c')).toBe(1);
    await expect(queuedClient).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'CANCELLED' },
    });
    for (const gate of providerGates) {
      gate.resolve([]);
    }
    await waitFor(() => scheduler.activeCount === 0);
  });
});

describe('LanguageToolService signature help', () => {
  it('normalizes provider variants and enforces signature and parameter caps', async () => {
    const live = createDocument('file:///workspace/file.ts', 'fn(value)');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const firstParameters = throwingIndexArray(
      Array.from({ length: 101 }, (_, index) => ({
        label: index === 0 ? [3, 8] : `parameter-${index}`,
        documentation: { kind: 'plaintext', value: `doc-${index}` },
      })),
      PROVIDER_OUTPUT_LIMITS.signatureHelp.parametersPerSignatureMax,
    );
    host.signatureResult = {
      activeSignature: 0,
      activeParameter: 0,
      signatures: throwingIndexArray(
        Array.from({ length: 21 }, (_, index) => ({
          label: index === 0 ? 'fn(value)' : `fn${index}()`,
          documentation: {
            kind: index === 0 ? 'markdown' : 'plaintext',
            value: `signature-${index}`,
          },
          activeParameter: index === 0 ? 1 : undefined,
          parameters: index === 0 ? firstParameters : [],
        })),
        PROVIDER_OUTPUT_LIMITS.signatureHelp.signaturesMax,
      ),
    };

    const response = await createService(host).callTool(
      {
        tool: 'get_signature_help',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 3 },
          triggerCharacter: '😀',
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 2 }],
      payload: {
        tool: 'get_signature_help',
        result: {
          activeSignature: 0,
          activeParameter: 1,
          signatures: { length: TOOL_LIMITS.signatureHelp.signaturesMax },
        },
      },
    });
    if (
      response.outcome !== 'success' ||
      response.payload.tool !== 'get_signature_help'
    ) {
      throw new Error('Expected signature-help success.');
    }
    expect(response.payload.result.signatures[0]?.parameters).toHaveLength(
      TOOL_LIMITS.signatureHelp.parametersPerSignatureMax,
    );
    expect(response.payload.result.signatures[0]?.parameters[0]).toMatchObject({
      label: null,
      labelRange: [3, 8],
    });
    expect(host.signatureCalls[0]?.triggerCharacter).toBe('😀');
  });

  it('strictly rejects a multi-scalar trigger and reports a genuine no-result warning', async () => {
    const live = createDocument('file:///workspace/file.ts', 'fn()');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const service = createService(host);

    const invalid = await service.callTool(
      {
        tool: 'get_signature_help',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 2 },
          triggerCharacter: 'ab',
        },
      },
      new AbortController().signal,
    );
    expect(invalid).toMatchObject({
      outcome: 'toolError',
      error: { code: 'INVALID_ARGUMENT' },
    });
    expect(host.signatureCalls).toEqual([]);

    host.signatureResult = undefined;
    const noResult = await service.callTool(
      {
        tool: 'get_signature_help',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 2 },
        },
      },
      new AbortController().signal,
    );
    expect(noResult).toMatchObject({
      outcome: 'success',
      truncated: false,
      warnings: [{ code: 'PROVIDER_RETURNED_NO_RESULT' }],
      payload: {
        result: { activeSignature: null, activeParameter: null, signatures: [] },
      },
    });
  });

  it('treats an empty signature collection as a normal successful result', async () => {
    const live = createDocument('file:///workspace/file.ts', 'fn()');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    host.signatureResult = {
      activeSignature: undefined,
      activeParameter: undefined,
      signatures: [],
    };

    const response = await createService(host).callTool(
      {
        tool: 'get_signature_help',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 2 },
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'success',
      truncated: false,
      warnings: [],
      payload: {
        tool: 'get_signature_help',
        result: { activeSignature: null, activeParameter: null, signatures: [] },
      },
    });
  });

  it('discards provider output changed during the final workspace check', async () => {
    const live = createDocument('file:///workspace/file.ts', 'value', { version: 4 });
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    host.hoverResult = [
      { range: null, contents: [{ kind: 'plaintext', value: 'hover' }] },
    ];
    let accessChecks = 0;
    const service = createService(host, {
      getAccess: () => {
        accessChecks += 1;
        if (accessChecks === 3) {
          live.setVersion(5);
        }
        return { eligible: true as const, identity: workspaceIdentity() };
      },
    });

    const response = await service.callTool(
      {
        tool: 'get_hover',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          position: { line: 0, character: 0 },
          expectedDocumentVersion: 4,
        },
      },
      new AbortController().signal,
    );

    expect(response).toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_CHANGED_DURING_REQUEST', retryable: true },
    });
    expect(accessChecks).toBe(3);
  });
});

describe('LanguageToolService diagnostics', () => {
  it('waits for quiet, sorts deterministically, filters external related data, and caps text', async () => {
    vi.useFakeTimers();
    const a = createDocument('file:///workspace/a.ts', 'alpha\nbeta', {
      dirty: true,
      version: 3,
    });
    const b = createDocument('file:///workspace/b.ts', 'bravo');
    const outside = createDocument('file:///outside/private-secret.ts', 'secret');
    const related = createDocument('file:///workspace/related.ts', 'related');
    const host = new FakeLanguageHost();
    host.documents = [b.document, outside.document, a.document];
    host.openByUri.set(related.document.uri, related.document);
    host.diagnosticsByUri.set(a.document.uri, [
      {
        range: range(1, 0, 1, 4),
        severity: 'warning',
        message: '😀'.repeat(5_000),
        source: 'typescript',
        code: { value: 1234, targetUri: 'file:///workspace/docs.ts' },
        tags: ['deprecated', 'unnecessary'],
        relatedInformation: [
          {
            uri: related.document.uri,
            range: range(0, 0, 0, 7),
            message: 'inside',
          },
          {
            uri: outside.document.uri,
            range: range(0, 0, 0, 6),
            message: 'must not leak',
          },
        ],
      },
      {
        range: range(0, 0, 0, 5),
        severity: 'error',
        message: 'a-error',
        source: null,
        code: null,
        tags: [],
        relatedInformation: [],
      },
    ]);
    host.diagnosticsByUri.set(b.document.uri, [
      {
        range: range(0, 0, 0, 5),
        severity: 'information',
        message: 'b-info',
        source: null,
        code: null,
        tags: [],
        relatedInformation: [],
      },
    ]);

    const responsePromise = createService(host).callTool(
      { tool: 'get_diagnostics', arguments: { limit: 2 } },
      new AbortController().signal,
    );
    await advanceDiagnosticsClock(301);
    const response = await responsePromise;

    expect(response).toMatchObject({
      outcome: 'success',
      truncated: true,
      warnings: [
        { code: 'RESULTS_TRUNCATED', omittedCount: 1 },
        { code: 'CONTENT_TRUNCATED' },
        { code: 'EXTERNAL_LOCATIONS_OMITTED', omittedCount: 2 },
      ],
      payload: {
        tool: 'get_diagnostics',
        result: {
          coverage: 'open_documents',
          freshness: {
            state: 'settled',
            heuristic: true,
            quietPeriodMs: TOOL_LIMITS.diagnostics.quietPeriodMs,
            waitedMs: TOOL_LIMITS.diagnostics.quietPeriodMs,
            lastChangeAt: null,
          },
          documents: [
            {
              document: { uri: a.document.uri, isDirty: true, documentVersion: 3 },
              diagnostics: [
                { severity: 'error', message: 'a-error' },
                {
                  severity: 'warning',
                  code: { value: '1234', targetUri: 'file:///workspace/docs.ts' },
                  relatedInformation: [
                    { uri: related.document.uri, message: 'inside' },
                  ],
                },
              ],
            },
            { document: { uri: b.document.uri }, diagnostics: [] },
          ],
        },
      },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('private-secret');
    expect(serialized).not.toContain('must not leak');
    if (response.outcome !== 'success' || response.payload.tool !== 'get_diagnostics') {
      throw new Error('Expected diagnostics success.');
    }
    const warningMessage =
      response.payload.result.documents[0]?.diagnostics[1]?.message;
    expect(Buffer.byteLength(warningMessage ?? '', 'utf8')).toBe(
      TOOL_LIMITS.diagnostics.messageBytes,
    );
  });

  it('reports changing freshness after the maximum bounded wait', async () => {
    vi.useFakeTimers();
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    for (const delay of [250, 500, 750, 1_000, 1_250]) {
      setTimeout(() => {
        host.emitDiagnosticsChanged([live.document.uri]);
      }, delay);
    }

    const responsePromise = createService(host).callTool(
      {
        tool: 'get_diagnostics',
        arguments: { document: { kind: 'uri', uri: live.document.uri } },
      },
      new AbortController().signal,
    );
    await advanceDiagnosticsClock(TOOL_LIMITS.diagnostics.maximumWaitMs + 1);
    const response = await responsePromise;

    expect(response).toMatchObject({
      outcome: 'success',
      payload: {
        result: {
          freshness: {
            state: 'changing',
            waitedMs: TOOL_LIMITS.diagnostics.maximumWaitMs,
            lastChangeAt: FIXED_NOW.toISOString(),
          },
        },
      },
    });
  });

  it('marks freshness unknown when a bounded diagnostic-change event omits URIs', async () => {
    vi.useFakeTimers();
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const changedUris = throwingIndexArray(
      Array.from(
        { length: TOOL_LIMITS.diagnostics.documentsMax + 1 },
        (_, index) => `file:///outside/unrelated-${index}.ts`,
      ),
      TOOL_LIMITS.diagnostics.documentsMax,
    );
    setTimeout(() => host.emitDiagnosticsChanged(changedUris), 100);

    const responsePromise = createService(host).callTool(
      {
        tool: 'get_diagnostics',
        arguments: { document: { kind: 'uri', uri: live.document.uri } },
      },
      new AbortController().signal,
    );
    await advanceDiagnosticsClock(401);

    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'success',
      payload: {
        result: {
          freshness: {
            state: 'unknown',
            waitedMs: 400,
            lastChangeAt: FIXED_NOW.toISOString(),
          },
        },
      },
    });
  });

  it('rechecks an expected dirty-buffer version after the freshness wait', async () => {
    vi.useFakeTimers();
    const live = createDocument('file:///workspace/file.ts', 'value', { version: 8 });
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    setTimeout(() => {
      live.setVersion(9);
      host.emitDiagnosticsChanged([live.document.uri]);
    }, 100);

    const responsePromise = createService(host).callTool(
      {
        tool: 'get_diagnostics',
        arguments: {
          document: { kind: 'uri', uri: live.document.uri },
          expectedDocumentVersion: 8,
        },
      },
      new AbortController().signal,
    );
    await advanceDiagnosticsClock(401);

    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'toolError',
      error: { code: 'DOCUMENT_CHANGED_DURING_REQUEST' },
    });
  });

  it('caps raw diagnostic traversal at the request boundary without inspecting cap plus one', async () => {
    vi.useFakeTimers();
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    let providerIndexReads = 0;
    host.diagnosticsByUri.set(
      live.document.uri,
      throwingIndexArray(
        Array.from(
          {
            length: PROVIDER_OUTPUT_LIMITS.diagnostics.itemsPerRequestMax + 1,
          },
          () => null,
        ),
        PROVIDER_OUTPUT_LIMITS.diagnostics.itemsPerRequestMax,
        () => {
          providerIndexReads += 1;
        },
      ),
    );

    const responsePromise = createService(host).callTool(
      {
        tool: 'get_diagnostics',
        arguments: { document: { kind: 'uri', uri: live.document.uri } },
      },
      new AbortController().signal,
    );
    await advanceDiagnosticsClock(TOOL_LIMITS.diagnostics.quietPeriodMs + 1);

    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'success',
      warnings: [
        { code: 'RESULTS_TRUNCATED', omittedCount: 1 },
        {
          code: 'UNSUPPORTED_ITEMS_OMITTED',
          omittedCount: PROVIDER_OUTPUT_LIMITS.diagnostics.itemsPerRequestMax,
        },
      ],
      payload: { result: { documents: [{ diagnostics: [] }] } },
    });
    expect(host.diagnosticReadLimits).toEqual([
      { items: 0, relatedInformation: 0 },
      {
        items: PROVIDER_OUTPUT_LIMITS.diagnostics.itemsPerRequestMax,
        relatedInformation:
          PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerRequestMax,
      },
    ]);
    expect(providerIndexReads).toBe(
      PROVIDER_OUTPUT_LIMITS.diagnostics.itemsPerRequestMax,
    );
  });

  it('caps diagnostic nested collections before inspection and counts invalid prefixes', async () => {
    vi.useFakeTimers();
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const relatedInformation = throwingIndexArray(
      Array.from(
        {
          length: PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerItemMax + 1,
        },
        () => null,
      ),
      PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerItemMax,
    );
    host.diagnosticsByUri.set(live.document.uri, [
      {
        range: range(0, 0, 0, 1),
        severity: 'warning',
        message: 'bounded',
        source: null,
        code: null,
        tags: throwingIndexArray(
          Array.from(
            {
              length: PROVIDER_OUTPUT_LIMITS.diagnostics.tagsPerItemMax + 1,
            },
            () => 'invalid',
          ),
          PROVIDER_OUTPUT_LIMITS.diagnostics.tagsPerItemMax,
        ),
        relatedInformation,
      },
    ]);

    const responsePromise = createService(host).callTool(
      {
        tool: 'get_diagnostics',
        arguments: { document: { kind: 'uri', uri: live.document.uri } },
      },
      new AbortController().signal,
    );
    await advanceDiagnosticsClock(TOOL_LIMITS.diagnostics.quietPeriodMs + 1);

    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'success',
      warnings: [
        { code: 'RESULTS_TRUNCATED', omittedCount: 104 },
        { code: 'UNSUPPORTED_ITEMS_OMITTED', omittedCount: 34 },
      ],
      payload: {
        result: { documents: [{ diagnostics: [{ relatedInformation: [] }] }] },
      },
    });
  });

  it('enforces raw and public related-information budgets across the whole request', async () => {
    vi.useFakeTimers();
    const live = createDocument('file:///workspace/file.ts', 'value');
    const host = new FakeLanguageHost();
    host.documents = [live.document];
    const diagnostics = Array.from({ length: 63 }, (_, index) => ({
      range: range(0, 0, 0, 1),
      severity: 'warning',
      message: `bounded-${index}`,
      source: null,
      code: null,
      tags: [],
      relatedInformation:
        index === 62
          ? throwingIndexArray(
              Array.from(
                {
                  length:
                    PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerItemMax,
                },
                () => null,
              ),
              64,
            )
          : Array.from(
              {
                length: PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerItemMax,
              },
              () => null,
            ),
    }));
    host.diagnosticsByUri.set(live.document.uri, diagnostics);

    const responsePromise = createService(host).callTool(
      {
        tool: 'get_diagnostics',
        arguments: { document: { kind: 'uri', uri: live.document.uri } },
      },
      new AbortController().signal,
    );
    await advanceDiagnosticsClock(TOOL_LIMITS.diagnostics.quietPeriodMs + 1);

    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'success',
      warnings: [
        { code: 'RESULTS_TRUNCATED', omittedCount: 6_064 },
        {
          code: 'UNSUPPORTED_ITEMS_OMITTED',
          omittedCount: TOOL_LIMITS.diagnostics.relatedInformationPerRequestMax,
        },
      ],
      payload: { result: { documents: [{ diagnostics: { length: 63 } }] } },
    });
  });

  it('bounds open-document coverage and reports documents not inspected', async () => {
    vi.useFakeTimers();
    const host = new FakeLanguageHost();
    host.documents = Array.from(
      { length: TOOL_LIMITS.diagnostics.documentsMax + 1 },
      (_, index) =>
        createDocument(`file:///workspace/file-${index}.ts`, 'value').document,
    );

    const responsePromise = createService(host).callTool(
      { tool: 'get_diagnostics', arguments: {} },
      new AbortController().signal,
    );
    await advanceDiagnosticsClock(TOOL_LIMITS.diagnostics.quietPeriodMs + 1);
    const response = await responsePromise;

    expect(response).toMatchObject({
      outcome: 'success',
      warnings: [{ code: 'RESULTS_TRUNCATED', omittedCount: 1 }],
      payload: { result: { documents: { length: 200 } } },
    });
  });
});

class FakeLanguageHost implements LanguageToolHost {
  public documents: EditorHostDocument[] = [];
  public readonly diagnosticsByUri = new Map<string, readonly unknown[]>();
  public readonly diagnosticReadLimits: Array<{
    readonly items: number;
    readonly relatedInformation: number;
  }> = [];
  public readonly openByUri = new Map<string, EditorHostDocument>();
  public readonly hoverCalls: Array<{
    uri: string;
    position: { line: number; character: number };
  }> = [];
  public readonly signatureCalls: Array<{
    uri: string;
    position: { line: number; character: number };
    triggerCharacter: string | undefined;
  }> = [];
  public hoverResult: unknown | Promise<unknown> = [];
  public hoverResultForCall:
    ((callIndex: number) => unknown | Promise<unknown>) | undefined;
  public signatureResult: unknown | Promise<unknown> = undefined;
  public statResult: EditorHostFileStat | Promise<EditorHostFileStat> = {
    size: 100,
    isFile: true,
  };
  public readonly statCalls: string[] = [];
  public openTextDocumentResult:
    EditorHostDocument | Promise<EditorHostDocument> | undefined;
  public readonly openTextDocumentCalls: string[] = [];
  readonly #listeners = new Set<(uris: BoundedProviderItems<string>) => void>();
  readonly #documentListeners = new Set<(uri: string) => void>();

  public openDocuments(): LanguageHostOpenDocuments {
    const documents = this.documents;
    const availableCount = Math.min(
      documents.length,
      PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax,
    );
    return {
      availableCount,
      omittedCount: documents.length - availableCount,
      *[Symbol.iterator](): Iterator<EditorHostDocument> {
        for (let index = 0; index < availableCount; index += 1) {
          const document = documents[index];
          if (document !== undefined) {
            yield document;
          }
        }
      },
    };
  }

  public async statFile(canonicalPath: string): Promise<EditorHostFileStat> {
    this.statCalls.push(canonicalPath);
    return this.statResult;
  }

  public async openTextDocument(uri: string): Promise<EditorHostDocument> {
    this.openTextDocumentCalls.push(uri);
    const document =
      this.openTextDocumentResult === undefined
        ? this.openByUri.get(uri)
        : await this.openTextDocumentResult;
    if (document === undefined) {
      throw new Error('missing');
    }
    if (!this.documents.includes(document)) {
      this.documents.push(document);
    }
    return document;
  }

  public onDocumentChanged(listener: (uri: string) => void): {
    dispose(): void;
  } {
    this.#documentListeners.add(listener);
    return {
      dispose: () => {
        this.#documentListeners.delete(listener);
      },
    };
  }

  public diagnostics(
    uri: string,
    limits: { readonly items: number; readonly relatedInformation: number },
  ): BoundedProviderItems<unknown> {
    this.diagnosticReadLimits.push({ ...limits });
    return snapshotBoundedProviderItems(
      this.diagnosticsByUri.get(uri) ?? [],
      limits.items,
    );
  }

  public onDiagnosticsChanged(listener: (uris: BoundedProviderItems<string>) => void): {
    dispose(): void;
  } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  public async provideHover(
    uri: string,
    position: { readonly line: number; readonly character: number },
  ): Promise<BoundedProviderItems<unknown> | undefined> {
    this.hoverCalls.push({ uri, position: { ...position } });
    const raw = await (this.hoverResultForCall?.(this.hoverCalls.length - 1) ??
      this.hoverResult);
    if (raw === undefined) {
      return undefined;
    }
    const bounded = readBoundedProviderItems(
      raw,
      PROVIDER_OUTPUT_LIMITS.hover.entriesMax,
    );
    if (bounded === null) {
      throw new Error('Invalid fake hover result.');
    }
    return bounded;
  }

  public async provideSignatureHelp(
    uri: string,
    position: { readonly line: number; readonly character: number },
    triggerCharacter: string | undefined,
  ): Promise<unknown> {
    this.signatureCalls.push({ uri, position: { ...position }, triggerCharacter });
    return this.signatureResult;
  }

  public emitDiagnosticsChanged(uris: readonly string[]): void {
    const bounded = snapshotBoundedProviderItems(
      uris,
      TOOL_LIMITS.diagnostics.documentsMax,
    );
    for (const listener of this.#listeners) {
      listener(bounded);
    }
  }

  public emitDocumentChanged(uri: string): void {
    for (const listener of this.#documentListeners) {
      listener(uri);
    }
  }
}

interface MutableDocument {
  readonly document: EditorHostDocument;
  setVersion(version: number): void;
}

function createDocument(
  uri: string,
  text: string,
  options: {
    readonly dirty?: boolean;
    readonly languageId?: string;
    readonly version?: number;
  } = {},
): MutableDocument {
  const lines = text.split('\n');
  let version = options.version ?? 1;
  return {
    document: {
      uri,
      languageId: options.languageId ?? 'typescript',
      get version(): number {
        return version;
      },
      isDirty: options.dirty ?? false,
      lineCount: lines.length,
      eol: 'LF',
      lineText(line: number): string {
        const value = lines[line];
        if (value === undefined) {
          throw new Error('line out of range');
        }
        return value;
      },
    },
    setVersion(nextVersion: number): void {
      version = nextVersion;
    },
  };
}

function createService(
  host: FakeLanguageHost,
  options: {
    readonly realpaths?: ReadonlyMap<string, string>;
    readonly getAccess?: () =>
      | { readonly eligible: false }
      | { readonly eligible: true; readonly identity: WorkspaceIdentity };
  } = {},
): LanguageToolService {
  return new LanguageToolService({
    host,
    getWorkspaceAccess:
      options.getAccess ?? (() => ({ eligible: true, identity: workspaceIdentity() })),
    realpath: async (path) => options.realpaths?.get(path) ?? path,
    pathStrategy: PATHS,
    now: () => FIXED_NOW,
  });
}

function workspaceIdentity(): WorkspaceIdentity {
  return {
    fingerprint: 'a'.repeat(64),
    displayName: 'fixture',
    workspaceFileUri: null,
    folders: [
      {
        workspaceFolderId: 'root',
        name: 'workspace',
        uri: 'file:///workspace',
        canonicalPath: '/workspace',
      },
    ],
  };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
} {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function throwingIndexArray<Value>(
  values: Value[],
  forbiddenIndex: number,
  onIndexRead?: (index: number) => void,
): Value[] {
  return new Proxy(values, {
    get(target, property, receiver) {
      if (property === String(forbiddenIndex) || property === Symbol.iterator) {
        throw new Error('Provider output was inspected beyond its raw budget.');
      }
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        onIndexRead?.(Number(property));
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      if (resolvePromise === null) {
        throw new Error('Deferred promise is not initialized.');
      }
      resolvePromise(value);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Condition was not reached.');
}

async function expectStillPending<Value>(promise: Promise<Value>): Promise<void> {
  const state = await Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), 10);
    }),
  ]);
  expect(state).toBe('pending');
}

async function advanceDiagnosticsClock(milliseconds: number): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(milliseconds);
}
