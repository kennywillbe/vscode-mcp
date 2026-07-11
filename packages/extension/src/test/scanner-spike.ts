import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import * as vscode from 'vscode';

import { createWorkspaceAuthorizationPathStrategy } from '../workspace-authorizer.js';
import { WorkspaceDiscoveryCursorCodec } from '../workspace-discovery-cursor.js';
import { WorkspaceFileDiscoveryService } from '../workspace-file-discovery-service.js';
import { createWorkspaceIdentity } from '../workspace-identity.js';
import { VsCodeV02ReadRuntime } from '../vscode-v0.2-read-runtime.js';
import {
  createVsCodeWorkspaceDocumentBatchService,
  createVsCodeWorkspaceTextSearchService,
} from '../vscode-editor-tool-adapter.js';
import { VsCodeWorkspaceFileDiscoveryHost } from '../vscode-workspace-file-discovery-adapter.js';

const defaultLimits: ScanLimits = {
  aggregateBytes: 64 * 1024 * 1024,
  candidates: 10_000,
  concurrency: 2,
  matches: 1_000,
  perFileBytes: 2 * 1024 * 1024,
  responseBytes: 256 * 1024,
  contextLines: 2,
};
const defaultExcluded =
  '**/{.git,node_modules,dist,out,build,coverage,artifacts,.vscode-test,.next,.open-next,.sst,.wrangler,.turbo,.cache,.parcel-cache,.nuxt,.output,.tmp,__pycache__,.venv}/**';

suite('bounded scanner feasibility spike', () => {
  test('measures stable VS Code discovery and bounded literal scanning', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(
      (folder) => folder.name === 'vscode-mcp',
    );
    assert.ok(workspaceFolder);
    assert.equal(workspaceFolder.uri.scheme, 'file');

    const result = await scanWorkspace(workspaceFolder, 'vscode-mcp', defaultLimits);
    process.stdout.write(`SCANNER_SPIKE_METRICS ${JSON.stringify(result.metrics)}\n`);

    assert.ok(result.metrics.candidates > 0);
    assert.ok(result.metrics.scannedFiles > 0);
    assert.ok(result.metrics.matches > 0);
    assert.ok(result.metrics.inspectedBytes <= defaultLimits.aggregateBytes);
  });

  test('prefers a dirty live buffer over stale disk content', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      const uri = vscode.Uri.joinPath(caseUri, 'dirty.ts');
      await vscode.workspace.fs.writeFile(uri, encode('DISK_ONLY_NEEDLE\n'));
      await waitForCandidateCount(workspaceFolder, 1);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        'LIVE_ONLY_NEEDLE\n',
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(document.isDirty, true);

      try {
        const live = await scanWorkspace(
          workspaceFolder,
          'LIVE_ONLY_NEEDLE',
          defaultLimits,
        );
        const stale = await scanWorkspace(
          workspaceFolder,
          'DISK_ONLY_NEEDLE',
          defaultLimits,
        );
        assert.equal(live.metrics.matches, 1);
        assert.equal(live.metrics.liveDocuments, 1);
        assert.equal(stale.metrics.matches, 0);
      } finally {
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        );
      }
    });
  });

  test('rejects a discovered symlink that resolves outside the workspace', async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), 'vscode-mcp-scan-external-'));
    try {
      const externalFile = join(externalRoot, 'external.txt');
      await writeFile(externalFile, 'EXTERNAL_SCANNER_CANARY\n');
      await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
        await symlink(externalFile, join(caseUri.fsPath, 'alias.txt'));
        await waitForCandidateCount(workspaceFolder, 1);
        const result = await scanWorkspace(
          workspaceFolder,
          'EXTERNAL_SCANNER_CANARY',
          defaultLimits,
        );
        assert.equal(result.metrics.matches, 0);
        assert.ok(result.metrics.unauthorizedFiles >= 1);
      });
    } finally {
      await rm(externalRoot, { force: true, recursive: true });
    }
  });

  test('extends the default exclude glob and reserves null for no exclusions', async () => {
    await withTemporaryScanRoot(async (_workspaceFolder, caseUri) => {
      const nextUri = vscode.Uri.joinPath(caseUri, '.next');
      const customAUri = vscode.Uri.joinPath(caseUri, 'custom-a');
      const customBUri = vscode.Uri.joinPath(caseUri, 'custom-b');
      await Promise.all(
        [nextUri, customAUri, customBUri].map((uri) =>
          vscode.workspace.fs.createDirectory(uri),
        ),
      );
      await Promise.all([
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'keep.ts'),
          encode('keep\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(nextUri, 'generated.ts'),
          encode('generated\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(customAUri, 'a.ts'),
          encode('custom a\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(customBUri, 'b.ts'),
          encode('custom b\n'),
        ),
      ]);

      const include = new vscode.RelativePattern(caseUri, '**/*');
      const defaults = await vscode.workspace.findFiles(
        include,
        combineExcludePattern(undefined),
      );
      const extended = await vscode.workspace.findFiles(
        include,
        combineExcludePattern('**/custom-{a,b}/**'),
      );
      const unfiltered = await vscode.workspace.findFiles(
        include,
        combineExcludePattern(null),
      );

      assert.deepEqual(relativeNames(caseUri, defaults), [
        'custom-a/a.ts',
        'custom-b/b.ts',
        'keep.ts',
      ]);
      assert.deepEqual(relativeNames(caseUri, extended), ['keep.ts']);
      assert.deepEqual(relativeNames(caseUri, unfiltered), [
        '.next/generated.ts',
        'custom-a/a.ts',
        'custom-b/b.ts',
        'keep.ts',
      ]);
    });
  });

  test('runs the unregistered list service through stable VS Code discovery', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      const generatedUri = vscode.Uri.joinPath(caseUri, '.next');
      const customUri = vscode.Uri.joinPath(caseUri, 'custom');
      await Promise.all(
        [generatedUri, customUri].map((uri) =>
          vscode.workspace.fs.createDirectory(uri),
        ),
      );
      const keepUri = vscode.Uri.joinPath(caseUri, 'keep.ts');
      await Promise.all([
        vscode.workspace.fs.writeFile(keepUri, encode('keep\n')),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(generatedUri, 'generated.ts'),
          encode('generated\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(customUri, 'hidden.ts'),
          encode('custom\n'),
        ),
      ]);
      await symlink(keepUri.fsPath, join(caseUri.fsPath, 'alias.ts'));

      const folders = vscode.workspace.workspaceFolders ?? [];
      const identity = await createWorkspaceIdentity({
        displayName: 'scanner-spike',
        workspaceFileUri:
          vscode.workspace.workspaceFile?.scheme === 'file'
            ? vscode.workspace.workspaceFile.toString()
            : null,
        folders: folders.map((folder) => ({
          name: folder.name,
          uri: folder.uri.toString(),
          fsPath: folder.uri.fsPath,
        })),
      });
      const selectedFolder = identity.folders.find(
        (folder) => folder.uri === workspaceFolder.uri.toString(),
      );
      assert.ok(selectedFolder);
      const caseName = relative(workspaceFolder.uri.fsPath, caseUri.fsPath)
        .split(sep)
        .join('/');
      const include = `${caseName}/**/*`;
      const service = new WorkspaceFileDiscoveryService({
        instanceId: 'a12f0291-37e2-4ff6-b763-0abf3fe66714',
        cursorCodec: new WorkspaceDiscoveryCursorCodec(randomBytes(32)),
        host: new VsCodeWorkspaceFileDiscoveryHost(),
        getWorkspaceAccess: () => ({ eligible: true, identity }),
        pathStrategy: createWorkspaceAuthorizationPathStrategy('posix'),
      });

      const first = await service.listWorkspaceFiles(
        {
          workspaceFolderId: selectedFolder.workspaceFolderId,
          include,
          limit: 1,
        },
        new AbortController().signal,
      );
      assert.deepEqual(first.result.files, [`${caseName}/custom/hidden.ts`]);
      assert.equal(first.result.hasMore, true);
      assert.ok(first.result.nextCursor);
      assert.equal(first.truncated, true);
      assert.equal(first.warnings[0]?.code, 'UNSUPPORTED_ITEMS_OMITTED');

      const second = await service.listWorkspaceFiles(
        {
          workspaceFolderId: selectedFolder.workspaceFolderId,
          include,
          limit: 1,
          cursor: first.result.nextCursor,
        },
        new AbortController().signal,
      );
      assert.deepEqual(second.result.files, [`${caseName}/keep.ts`]);
      assert.equal(second.result.hasMore, false);

      const extended = await service.listWorkspaceFiles(
        {
          workspaceFolderId: selectedFolder.workspaceFolderId,
          include,
          exclude: `${caseName}/custom/**`,
        },
        new AbortController().signal,
      );
      assert.deepEqual(extended.result.files, [`${caseName}/keep.ts`]);

      const unfiltered = await service.listWorkspaceFiles(
        {
          workspaceFolderId: selectedFolder.workspaceFolderId,
          include,
          exclude: null,
        },
        new AbortController().signal,
      );
      assert.deepEqual(unfiltered.result.files, [
        `${caseName}/.next/generated.ts`,
        `${caseName}/custom/hidden.ts`,
        `${caseName}/keep.ts`,
      ]);
    });
  });

  test('runs the unregistered batch reader with dirty live text and partial errors', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      const uri = vscode.Uri.joinPath(caseUri, 'batch.ts');
      await vscode.workspace.fs.writeFile(uri, encode('disk first\ndisk second\n'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        'live first\nlive second\n',
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(document.isDirty, true);

      try {
        const identity = await createWorkspaceIdentity({
          displayName: 'scanner-spike',
          workspaceFileUri:
            vscode.workspace.workspaceFile?.scheme === 'file'
              ? vscode.workspace.workspaceFile.toString()
              : null,
          folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
            name: folder.name,
            uri: folder.uri.toString(),
            fsPath: folder.uri.fsPath,
          })),
        });
        const selectedFolder = identity.folders.find(
          (folder) => folder.uri === workspaceFolder.uri.toString(),
        );
        assert.ok(selectedFolder);
        const caseName = relative(workspaceFolder.uri.fsPath, caseUri.fsPath)
          .split(sep)
          .join('/');
        const service = createVsCodeWorkspaceDocumentBatchService({
          instanceId: 'a12f0291-37e2-4ff6-b763-0abf3fe66714',
          isWorkspaceEnabled: () => true,
        });
        const result = await service.readDocuments(
          {
            workspaceFolderId: selectedFolder.workspaceFolderId,
            documents: [
              {
                document: {
                  kind: 'workspacePath',
                  workspaceFolderId: selectedFolder.workspaceFolderId,
                  relativePath: `${caseName}/batch.ts`,
                },
                startLine: 1,
                lineCount: 1,
              },
              {
                document: {
                  kind: 'workspacePath',
                  workspaceFolderId: selectedFolder.workspaceFolderId,
                  relativePath: `${caseName}/missing.ts`,
                },
              },
            ],
          },
          new AbortController().signal,
        );
        assert.equal(result.result.items.length, 2);
        assert.deepEqual(result.result.items[0], {
          outcome: 'success',
          document: {
            workspaceFolderId: selectedFolder.workspaceFolderId,
            relativePath: `${caseName}/batch.ts`,
            languageId: 'typescript',
            documentVersion: document.version,
            isDirty: true,
          },
          eol: 'LF',
          totalLineCount: 3,
          returnedRange: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 11 },
          },
          text: 'live second',
          hasMore: true,
          nextStartLine: 2,
        });
        assert.equal(result.result.items[1]?.outcome, 'error');
        if (result.result.items[1]?.outcome === 'error') {
          assert.equal(result.result.items[1].error.code, 'DOCUMENT_NOT_FOUND');
        }
      } finally {
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        );
      }
    });
  });

  test('runs the unregistered literal search with dirty precedence and pagination', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      const dirtyUri = vscode.Uri.joinPath(caseUri, 'dirty-search.ts');
      await Promise.all([
        vscode.workspace.fs.writeFile(dirtyUri, encode('DISK_SEARCH_ONLY\n')),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'closed-search.ts'),
          encode('LITERAL .* NEEDLE\nNEEDLE\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'binary-search.bin'),
          Uint8Array.from([78, 69, 0, 69, 68, 76, 69]),
        ),
      ]);
      const document = await vscode.workspace.openTextDocument(dirtyUri);
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        dirtyUri,
        new vscode.Range(0, 0, document.lineCount, 0),
        'LIVE_SEARCH_NEEDLE\n',
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);

      try {
        const identity = await createWorkspaceIdentity({
          displayName: 'scanner-spike',
          workspaceFileUri:
            vscode.workspace.workspaceFile?.scheme === 'file'
              ? vscode.workspace.workspaceFile.toString()
              : null,
          folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
            name: folder.name,
            uri: folder.uri.toString(),
            fsPath: folder.uri.fsPath,
          })),
        });
        const selectedFolder = identity.folders.find(
          (folder) => folder.uri === workspaceFolder.uri.toString(),
        );
        assert.ok(selectedFolder);
        const caseName = relative(workspaceFolder.uri.fsPath, caseUri.fsPath)
          .split(sep)
          .join('/');
        const service = createVsCodeWorkspaceTextSearchService({
          instanceId: 'a12f0291-37e2-4ff6-b763-0abf3fe66714',
          cursorCodec: new WorkspaceDiscoveryCursorCodec(randomBytes(32)),
          isWorkspaceEnabled: () => true,
        });
        const first = await service.searchWorkspaceText(
          {
            workspaceFolderId: selectedFolder.workspaceFolderId,
            query: 'NEEDLE',
            include: `${caseName}/**/*`,
            limit: 2,
          },
          new AbortController().signal,
        );
        assert.equal(first.result.returnedMatchCount, 2);
        assert.equal(first.result.hasMore, true);
        assert.ok(first.result.nextCursor);
        assert.deepEqual(
          first.result.documents.map((entry) => entry.document.relativePath),
          [`${caseName}/closed-search.ts`],
        );

        const second = await service.searchWorkspaceText(
          {
            workspaceFolderId: selectedFolder.workspaceFolderId,
            query: 'NEEDLE',
            include: `${caseName}/**/*`,
            limit: 2,
            cursor: first.result.nextCursor,
          },
          new AbortController().signal,
        );
        assert.equal(second.result.returnedMatchCount, 1);
        assert.equal(second.result.documents[0]?.state.source, 'live');
        assert.equal(
          second.result.documents[0]?.document.relativePath,
          `${caseName}/dirty-search.ts`,
        );

        const stale = await service.searchWorkspaceText(
          {
            workspaceFolderId: selectedFolder.workspaceFolderId,
            query: 'DISK_SEARCH_ONLY',
            include: `${caseName}/**/*`,
          },
          new AbortController().signal,
        );
        assert.equal(stale.result.returnedMatchCount, 0);
      } finally {
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        );
      }
    });
  });

  test('invalidates v0.2 cursors when the listener-generation runtime is destroyed', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      await Promise.all([
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'first.ts'),
          encode('first\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'second.ts'),
          encode('second\n'),
        ),
      ]);
      const identity = await createWorkspaceIdentity({
        displayName: 'scanner-spike',
        workspaceFileUri:
          vscode.workspace.workspaceFile?.scheme === 'file'
            ? vscode.workspace.workspaceFile.toString()
            : null,
        folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
          name: folder.name,
          uri: folder.uri.toString(),
          fsPath: folder.uri.fsPath,
        })),
      });
      const selectedFolder = identity.folders.find(
        (folder) => folder.uri === workspaceFolder.uri.toString(),
      );
      assert.ok(selectedFolder);
      const caseName = relative(workspaceFolder.uri.fsPath, caseUri.fsPath)
        .split(sep)
        .join('/');
      const runtime = new VsCodeV02ReadRuntime({
        instanceId: 'a12f0291-37e2-4ff6-b763-0abf3fe66714',
        cursorKey: Buffer.alloc(32, 7),
        isWorkspaceEnabled: () => true,
      });
      const invocation = {
        tool: 'list_workspace_files' as const,
        arguments: {
          workspaceFolderId: selectedFolder.workspaceFolderId,
          include: `${caseName}/**/*`,
          limit: 1,
        },
      };
      const first = await runtime.router.callTool(
        invocation,
        new AbortController().signal,
      );
      assert.equal(first.outcome, 'success');
      assert.equal(first.tool, 'list_workspace_files');
      if (first.outcome !== 'success' || first.tool !== 'list_workspace_files') {
        throw new Error('The lifecycle fixture did not return a list page.');
      }
      assert.ok(first.response.result.nextCursor);
      runtime.destroy();
      runtime.destroy();

      const expired = await runtime.router.callTool(
        {
          ...invocation,
          arguments: {
            ...invocation.arguments,
            cursor: first.response.result.nextCursor,
          },
        },
        new AbortController().signal,
      );
      assert.deepEqual(expired, {
        outcome: 'toolError',
        tool: 'list_workspace_files',
        error: {
          code: 'INVALID_CURSOR',
          message: 'The continuation cursor is invalid.',
          retryable: false,
        },
      });
    });
  });

  test('enforces candidate, file, aggregate, binary, and match bounds', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      await Promise.all([
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'a.txt'),
          encode('hit hit hit\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'b.txt'),
          encode('hit hit hit\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'binary.bin'),
          Uint8Array.from([104, 105, 116, 0, 104, 105, 116]),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'large.txt'),
          encode('x'.repeat(64)),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'invalid-utf8.txt'),
          Uint8Array.from([255, 254, 253]),
        ),
      ]);
      await waitForCandidateCount(workspaceFolder, 5);

      const fileBound = await scanWorkspace(workspaceFolder, 'hit', {
        ...defaultLimits,
        perFileBytes: 32,
      });
      assert.equal(fileBound.metrics.binaryFiles, 1);
      assert.equal(fileBound.metrics.invalidUtf8Files, 1);
      assert.ok(fileBound.metrics.oversizedFiles >= 1);

      const aggregateBound = await scanWorkspace(workspaceFolder, 'hit', {
        ...defaultLimits,
        aggregateBytes: 13,
        matches: 2,
      });
      assert.equal(aggregateBound.metrics.aggregateLimitReached, true);
      assert.equal(aggregateBound.metrics.matchLimitReached, true);
      assert.equal(aggregateBound.metrics.matches, 2);

      const candidateBound = await scanWorkspace(workspaceFolder, 'hit', {
        ...defaultLimits,
        candidates: 1,
      });
      assert.equal(candidateBound.metrics.candidateLimitReached, true);
      assert.ok(candidateBound.metrics.scannedFiles <= 1);
    });
  });

  test('stops scheduling new read batches after cancellation', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(caseUri, `file-${String(index)}.txt`),
            encode('cancel probe\n'),
          ),
        ),
      );
      await waitForCandidateCount(workspaceFolder, 12);
      const cancellation = new vscode.CancellationTokenSource();
      let cancelledAt = 0;
      const result = await scanWorkspace(
        workspaceFolder,
        'probe',
        { ...defaultLimits, concurrency: 2 },
        cancellation.token,
        () => {
          if (!cancellation.token.isCancellationRequested) {
            cancelledAt = performance.now();
            cancellation.cancel();
          }
        },
      );
      const cancellationLatencyMs = performance.now() - cancelledAt;
      cancellation.dispose();

      assert.equal(result.metrics.cancelled, true);
      assert.ok(result.metrics.readAttempts <= 2);
      assert.ok(cancellationLatencyMs < 500);
      process.stdout.write(
        `SCANNER_CANCELLATION_METRICS ${JSON.stringify({ cancellationLatencyMs: roundMilliseconds(cancellationLatencyMs) })}\n`,
      );
    });
  });

  test('returns deterministic path and match ordering', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      await Promise.all([
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'z.txt'),
          encode('ordered\nordered\n'),
        ),
        vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(caseUri, 'a.txt'),
          encode('ordered\n'),
        ),
      ]);
      await waitForCandidateCount(workspaceFolder, 2);
      const first = await scanWorkspace(workspaceFolder, 'ordered', defaultLimits);
      const second = await scanWorkspace(workspaceFolder, 'ordered', defaultLimits);
      assert.deepEqual(first.matches, second.matches);
      assert.deepEqual(
        first.matches.map((match) => match.relativePath.split('/').at(-1)),
        ['a.txt', 'z.txt', 'z.txt'],
      );
    });
  });

  test('assigns files to the deepest nested workspace root', async () => {
    const outer = requiredWorkspaceFolder('scanner-spike-fixture');
    const nested = requiredWorkspaceFolder('scanner-spike-nested');
    const directory = await mkdtemp(join(nested.uri.fsPath, 'case-'));
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(join(directory, 'owned.txt')),
        encode('NESTED_OWNER_CANARY\n'),
      );
      await waitForCandidateCount(nested, 1);
      const fromOuter = await scanWorkspace(
        outer,
        'NESTED_OWNER_CANARY',
        defaultLimits,
      );
      const fromNested = await scanWorkspace(
        nested,
        'NESTED_OWNER_CANARY',
        defaultLimits,
      );
      assert.equal(fromOuter.metrics.matches, 0);
      assert.ok(fromOuter.metrics.unauthorizedFiles >= 1);
      assert.equal(fromNested.metrics.matches, 1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('omits files changed or removed after candidate selection', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      const changedUri = vscode.Uri.joinPath(caseUri, 'changed.txt');
      const removedUri = vscode.Uri.joinPath(caseUri, 'removed.txt');
      await Promise.all([
        vscode.workspace.fs.writeFile(changedUri, encode('MUTATION_CANARY\n')),
        vscode.workspace.fs.writeFile(removedUri, encode('MUTATION_CANARY\n')),
      ]);
      await waitForCandidateCount(workspaceFolder, 2);
      const touched = new Set<string>();
      const result = await scanWorkspace(
        workspaceFolder,
        'MUTATION_CANARY',
        { ...defaultLimits, concurrency: 1 },
        undefined,
        async (candidate) => {
          if (touched.has(candidate.uri.toString())) {
            return;
          }
          if (candidate.relativePath.endsWith('/changed.txt')) {
            touched.add(candidate.uri.toString());
            await vscode.workspace.fs.writeFile(
              candidate.uri,
              encode('changed after selection with different bytes\n'),
            );
          }
          if (candidate.relativePath.endsWith('/removed.txt')) {
            touched.add(candidate.uri.toString());
            await vscode.workspace.fs.delete(candidate.uri);
          }
        },
      );
      assert.equal(result.metrics.matches, 0);
      assert.equal(result.metrics.changedFiles, 1);
      assert.equal(result.metrics.readFailures, 1);
    });
  });

  test('shares one read-concurrency ceiling across concurrent searches', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(caseUri, `shared-${String(index)}.txt`),
            encode('SHARED_SCHEDULER_CANARY\n'),
          ),
        ),
      );
      await waitForCandidateCount(workspaceFolder, 8);
      const scheduler = new BoundedReadScheduler(2);
      const slowRead = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 15));
      };
      const [first, second] = await Promise.all([
        scanWorkspace(
          workspaceFolder,
          'SHARED_SCHEDULER_CANARY',
          { ...defaultLimits, concurrency: 4 },
          undefined,
          slowRead,
          scheduler,
        ),
        scanWorkspace(
          workspaceFolder,
          'SHARED_SCHEDULER_CANARY',
          { ...defaultLimits, concurrency: 4 },
          undefined,
          slowRead,
          scheduler,
        ),
      ]);
      assert.ok(first.metrics.matches >= 8);
      assert.ok(second.metrics.matches >= 8);
      assert.equal(scheduler.peak, 2);
    });
  });

  test('bounds context and complete serialized match bytes', async () => {
    await withTemporaryScanRoot(async (workspaceFolder, caseUri) => {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(caseUri, 'context.txt'),
        encode(
          Array.from(
            { length: 20 },
            (_, index) => `context-${String(index).padStart(2, '0')} RESPONSE_NEEDLE`,
          ).join('\n'),
        ),
      );
      await waitForCandidateCount(workspaceFolder, 1);
      const result = await scanWorkspace(workspaceFolder, 'RESPONSE_NEEDLE', {
        ...defaultLimits,
        contextLines: 1,
        responseBytes: 420,
      });
      assert.equal(result.metrics.responseLimitReached, true);
      assert.ok(result.metrics.responseBytes <= 420);
      assert.ok(result.matches.length > 0);
      assert.ok(result.matches.every((match) => match.context.length > 0));
    });
  });

  test('binds continuation cursors to query, policy, and workspace', () => {
    const key = randomBytes(32);
    const binding: CursorBinding = {
      policyHash: hashText('literal:case-sensitive:context=1'),
      queryHash: hashText('cursor needle'),
      workspaceHash: hashText('workspace-fingerprint'),
    };
    const cursor = createCursor(
      {
        ...binding,
        character: 4,
        line: 7,
        relativePath: 'src/index.ts',
        version: 1,
      },
      key,
    );
    assert.deepEqual(parseCursor(cursor, binding, key), {
      character: 4,
      line: 7,
      relativePath: 'src/index.ts',
    });
    const [encoded, signature] = cursor.split('.');
    assert.ok(encoded);
    assert.ok(signature);
    const replacement = signature.startsWith('A') ? 'B' : 'A';
    assert.equal(
      parseCursor(`${encoded}.${replacement}${signature.slice(1)}`, binding, key),
      undefined,
    );
    assert.equal(
      parseCursor(cursor, { ...binding, queryHash: hashText('other') }, key),
      undefined,
    );
    assert.equal(
      parseCursor(
        cursor,
        { ...binding, workspaceHash: hashText('other-workspace') },
        key,
      ),
      undefined,
    );
  });
});

interface ScanLimits {
  readonly aggregateBytes: number;
  readonly candidates: number;
  readonly concurrency: number;
  readonly contextLines: number;
  readonly matches: number;
  readonly perFileBytes: number;
  readonly responseBytes: number;
}

interface ScanRoot {
  readonly name: string;
  readonly uri: vscode.Uri;
}

interface ScanMatch {
  readonly character: number;
  readonly context: string;
  readonly line: number;
  readonly relativePath: string;
}

interface ScanMetrics {
  readonly aggregateLimitReached: boolean;
  readonly binaryFiles: number;
  readonly cancelled: boolean;
  readonly candidateLimitReached: boolean;
  readonly candidates: number;
  readonly changedFiles: number;
  readonly discoveryMs: number;
  readonly inspectedBytes: number;
  readonly invalidUtf8Files: number;
  readonly liveDocuments: number;
  readonly matchLimitReached: boolean;
  readonly matches: number;
  readonly nonFileEntries: number;
  readonly oversizedFiles: number;
  readonly readAttempts: number;
  readonly readFailures: number;
  readonly responseBytes: number;
  readonly responseLimitReached: boolean;
  readonly scanMs: number;
  readonly scannedFiles: number;
  readonly unauthorizedFiles: number;
}

interface ScanResult {
  readonly matches: ScanMatch[];
  readonly metrics: ScanMetrics;
}

interface ReadCandidate {
  readonly initialMtime: number;
  readonly initialSize: number;
  readonly relativePath: string;
  readonly uri: vscode.Uri;
}

interface CursorBinding {
  readonly policyHash: string;
  readonly queryHash: string;
  readonly workspaceHash: string;
}

interface CursorPayload extends CursorBinding {
  readonly character: number;
  readonly line: number;
  readonly relativePath: string;
  readonly version: 1;
}

class BoundedReadScheduler {
  readonly #limit: number;
  readonly #waiters: Array<() => void> = [];
  #active = 0;
  #peak = 0;

  public constructor(limit: number) {
    assert.ok(Number.isInteger(limit) && limit > 0);
    this.#limit = limit;
  }

  public get peak(): number {
    return this.#peak;
  }

  public async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    this.#peak = Math.max(this.#peak, this.#active);
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
}

async function scanWorkspace(
  workspaceFolder: ScanRoot,
  query: string,
  limits: ScanLimits,
  token?: vscode.CancellationToken,
  onReadStarted?: (candidate: ReadCandidate) => void | Promise<void>,
  scheduler = new BoundedReadScheduler(limits.concurrency),
): Promise<ScanResult> {
  const canonicalRoot = await realpath(workspaceFolder.uri.fsPath);
  const authorityRoots = await Promise.all(
    (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map(async (folder) => ({
        canonicalPath: await realpath(folder.uri.fsPath),
        uri: folder.uri.toString(),
      })),
  );

  const startedAt = performance.now();
  const candidates = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder.uri, '**/*'),
    defaultExcluded,
    limits.candidates + 1,
    token,
  );
  const discoveryMs = performance.now() - startedAt;
  const limitedCandidates = candidates
    .slice(0, limits.candidates)
    .sort((left, right) => left.toString().localeCompare(right.toString()));

  let aggregateLimitReached = false;
  let inspectedBytes = 0;
  let nonFileEntries = 0;
  let oversizedFiles = 0;
  let unauthorizedFiles = 0;
  const selected: ReadCandidate[] = [];
  for (const uri of limitedCandidates) {
    if (isCancelled(token)) {
      break;
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(uri.fsPath);
    } catch {
      unauthorizedFiles += 1;
      continue;
    }
    const relativePath = relative(canonicalRoot, canonicalPath);
    const owner = deepestContainingRoot(authorityRoots, canonicalPath);
    if (
      owner?.uri !== workspaceFolder.uri.toString() ||
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      unauthorizedFiles += 1;
      continue;
    }
    const canonicalUri = vscode.Uri.file(canonicalPath);
    const stat = await vscode.workspace.fs.stat(canonicalUri);
    if ((stat.type & vscode.FileType.File) === 0) {
      nonFileEntries += 1;
      continue;
    }
    if (stat.size > limits.perFileBytes) {
      oversizedFiles += 1;
      continue;
    }
    if (inspectedBytes + stat.size > limits.aggregateBytes) {
      aggregateLimitReached = true;
      break;
    }
    inspectedBytes += stat.size;
    selected.push({
      initialMtime: stat.mtime,
      initialSize: stat.size,
      relativePath: relativePath.split(sep).join('/'),
      uri: canonicalUri,
    });
  }

  const openDocuments = new Map(
    vscode.workspace.textDocuments.map((document) => [
      document.uri.toString(),
      document,
    ]),
  );
  let binaryFiles = 0;
  let changedFiles = 0;
  let invalidUtf8Files = 0;
  let liveDocuments = 0;
  let matchLimitReached = false;
  let readAttempts = 0;
  let readFailures = 0;
  let responseBytes = 0;
  let responseLimitReached = false;
  const matches: ScanMatch[] = [];
  const scanStartedAt = performance.now();
  for (let index = 0; index < selected.length; index += limits.concurrency) {
    if (
      isCancelled(token) ||
      matches.length >= limits.matches ||
      responseLimitReached
    ) {
      break;
    }
    const batch = selected.slice(index, index + limits.concurrency);
    const texts = await Promise.all(
      batch.map((candidate) =>
        scheduler.run(async () => {
          if (isCancelled(token)) {
            return { candidate, text: undefined };
          }
          readAttempts += 1;
          await onReadStarted?.(candidate);
          const liveDocument = openDocuments.get(candidate.uri.toString());
          if (liveDocument) {
            liveDocuments += 1;
            return { candidate, text: liveDocument.getText() };
          }
          let bytes: Uint8Array;
          try {
            bytes = await vscode.workspace.fs.readFile(candidate.uri);
            const after = await vscode.workspace.fs.stat(candidate.uri);
            if (
              after.mtime !== candidate.initialMtime ||
              after.size !== candidate.initialSize
            ) {
              changedFiles += 1;
              return { candidate, text: undefined };
            }
          } catch {
            readFailures += 1;
            return { candidate, text: undefined };
          }
          if (bytes.subarray(0, 8_192).includes(0)) {
            binaryFiles += 1;
            return { candidate, text: undefined };
          }
          try {
            return {
              candidate,
              text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            };
          } catch {
            invalidUtf8Files += 1;
            return { candidate, text: undefined };
          }
        }),
      ),
    );
    if (isCancelled(token)) {
      break;
    }
    for (const { candidate, text } of texts) {
      if (text === undefined) {
        continue;
      }
      for (const position of literalMatches(text, query, limits.contextLines)) {
        if (matches.length >= limits.matches) {
          matchLimitReached = true;
          break;
        }
        const match = { ...position, relativePath: candidate.relativePath };
        const matchBytes = Buffer.byteLength(JSON.stringify(match), 'utf8');
        if (responseBytes + matchBytes > limits.responseBytes) {
          responseLimitReached = true;
          break;
        }
        responseBytes += matchBytes;
        matches.push(match);
      }
    }
  }
  const scanMs = performance.now() - scanStartedAt;

  return {
    matches,
    metrics: {
      aggregateLimitReached,
      binaryFiles,
      cancelled: isCancelled(token),
      candidateLimitReached: candidates.length > limits.candidates,
      candidates: candidates.length,
      changedFiles,
      discoveryMs: roundMilliseconds(discoveryMs),
      inspectedBytes,
      invalidUtf8Files,
      liveDocuments,
      matchLimitReached,
      matches: matches.length,
      nonFileEntries,
      oversizedFiles,
      readAttempts,
      readFailures,
      responseBytes,
      responseLimitReached,
      scanMs: roundMilliseconds(scanMs),
      scannedFiles: selected.length,
      unauthorizedFiles,
    },
  };
}

function literalMatches(
  text: string,
  needle: string,
  contextLines: number,
): Array<{ character: number; context: string; line: number }> {
  if (needle.length === 0) {
    return [];
  }
  const positions: Array<{ character: number; context: string; line: number }> = [];
  const lines = text.split('\n');
  let line = 0;
  let lineStart = 0;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const match = text.indexOf(needle, offset);
    if (match < 0) {
      break;
    }
    while (true) {
      const newline = text.indexOf('\n', lineStart);
      if (newline < 0 || newline >= match) {
        break;
      }
      line += 1;
      lineStart = newline + 1;
    }
    const contextStart = Math.max(0, line - contextLines);
    const contextEnd = Math.min(lines.length, line + contextLines + 1);
    positions.push({
      character: match - lineStart,
      context: lines.slice(contextStart, contextEnd).join('\n'),
      line,
    });
    offset = match + needle.length;
  }
  return positions;
}

async function withTemporaryScanRoot(
  operation: (workspaceFolder: ScanRoot, caseUri: vscode.Uri) => Promise<void>,
): Promise<void> {
  const fixtureFolder = requiredWorkspaceFolder('scanner-spike-fixture');
  const directory = await mkdtemp(join(fixtureFolder.uri.fsPath, 'case-'));
  try {
    await operation(fixtureFolder, vscode.Uri.file(directory));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function requiredWorkspaceFolder(name: string): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(folder);
  return folder;
}

function deepestContainingRoot(
  roots: ReadonlyArray<{ canonicalPath: string; uri: string }>,
  candidate: string,
): { canonicalPath: string; uri: string } | undefined {
  return roots
    .filter((root) => isContained(root.canonicalPath, candidate))
    .sort((left, right) => right.canonicalPath.length - left.canonicalPath.length)[0];
}

function isContained(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return (
    result.length > 0 &&
    result !== '..' &&
    !result.startsWith(`..${sep}`) &&
    !isAbsolute(result)
  );
}

async function waitForCandidateCount(
  workspaceFolder: ScanRoot,
  minimum: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidates = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder.uri, '**/*'),
      defaultExcluded,
      minimum,
    );
    if (candidates.length >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Temporary scanner files were not indexed.');
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function combineExcludePattern(custom: string | null | undefined): string | null {
  if (custom === null) {
    return null;
  }
  return custom === undefined ? defaultExcluded : `{${defaultExcluded},${custom}}`;
}

function relativeNames(root: vscode.Uri, uris: readonly vscode.Uri[]): string[] {
  return uris
    .map((uri) => relative(root.fsPath, uri.fsPath).split(sep).join('/'))
    .sort();
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function isCancelled(token: vscode.CancellationToken | undefined): boolean {
  return token?.isCancellationRequested === true;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function createCursor(payload: CursorPayload, key: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function parseCursor(
  cursor: string,
  binding: CursorBinding,
  key: Buffer,
): { character: number; line: number; relativePath: string } | undefined {
  const parts = cursor.split('.');
  if (parts.length !== 2) {
    return undefined;
  }
  const [encoded, providedSignature] = parts;
  if (!encoded || !providedSignature) {
    return undefined;
  }
  const expectedSignature = createHmac('sha256', key).update(encoded).digest();
  let decodedSignature: Buffer;
  try {
    decodedSignature = Buffer.from(providedSignature, 'base64url');
  } catch {
    return undefined;
  }
  if (
    decodedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(decodedSignature, expectedSignature)
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed['version'] !== 1 ||
    parsed['policyHash'] !== binding.policyHash ||
    parsed['queryHash'] !== binding.queryHash ||
    parsed['workspaceHash'] !== binding.workspaceHash ||
    typeof parsed['relativePath'] !== 'string' ||
    !Number.isSafeInteger(parsed['line']) ||
    !Number.isSafeInteger(parsed['character'])
  ) {
    return undefined;
  }
  return {
    character: Number(parsed['character']),
    line: Number(parsed['line']),
    relativePath: parsed['relativePath'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
