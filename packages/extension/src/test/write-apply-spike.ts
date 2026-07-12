import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import * as vscode from 'vscode';

suite('version-checked text edit feasibility spike', () => {
  test('applies to a live buffer without silently saving disk content', async () => {
    await withTemporaryCase(async (caseUri) => {
      const uri = vscode.Uri.joinPath(caseUri, 'single.txt');
      await vscode.workspace.fs.writeFile(uri, encode('before\n'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const initialVersion = document.version;

      try {
        const outcome = await applyVersionCheckedTextEdits({
          document,
          edits: [{ newText: 'after', range: new vscode.Range(0, 0, 0, 6) }],
          expectedVersion: initialVersion,
          isWriteGranted: () => true,
        });
        assert.equal(outcome.status, 'applied');
        assert.equal(document.getText(), 'after\n');
        assert.equal(document.isDirty, true);
        assert.ok(document.version > initialVersion);
        assert.equal(await readFile(uri.fsPath, 'utf8'), 'before\n');
      } finally {
        await revertAndClose(document);
      }
    });
  });

  test('rejects stale versions, overlapping edits, and revoked grants', async () => {
    await withTemporaryCase(async (caseUri) => {
      const uri = vscode.Uri.joinPath(caseUri, 'guards.txt');
      await vscode.workspace.fs.writeFile(uri, encode('abcdef\n'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const initialVersion = document.version;
      const userEdit = new vscode.WorkspaceEdit();
      userEdit.insert(uri, new vscode.Position(0, 0), 'user:');
      assert.equal(await vscode.workspace.applyEdit(userEdit), true);

      try {
        const stale = await applyVersionCheckedTextEdits({
          document,
          edits: [{ newText: 'agent:', range: new vscode.Range(0, 0, 0, 0) }],
          expectedVersion: initialVersion,
          isWriteGranted: () => true,
        });
        assert.equal(stale.status, 'stale');

        const overlapping = await applyVersionCheckedTextEdits({
          document,
          edits: [
            { newText: 'x', range: new vscode.Range(0, 0, 0, 4) },
            { newText: 'y', range: new vscode.Range(0, 2, 0, 5) },
          ],
          expectedVersion: document.version,
          isWriteGranted: () => true,
        });
        assert.equal(overlapping.status, 'invalid');

        let granted = true;
        const revoked = await applyVersionCheckedTextEdits({
          beforeFinalCheck: async () => {
            granted = false;
          },
          document,
          edits: [{ newText: 'agent:', range: new vscode.Range(0, 0, 0, 0) }],
          expectedVersion: document.version,
          isWriteGranted: () => granted,
        });
        assert.equal(revoked.status, 'not-granted');
        assert.equal(document.getText(), 'user:abcdef\n');
      } finally {
        await revertAndClose(document);
      }
    });
  });

  test('rechecks versions after asynchronous preparation but before commit', async () => {
    await withTemporaryCase(async (caseUri) => {
      const uri = vscode.Uri.joinPath(caseUri, 'recheck.txt');
      await vscode.workspace.fs.writeFile(uri, encode('base\n'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const initialVersion = document.version;

      try {
        const outcome = await applyVersionCheckedTextEdits({
          beforeFinalCheck: async () => {
            const userEdit = new vscode.WorkspaceEdit();
            userEdit.insert(uri, new vscode.Position(0, 0), 'user:');
            assert.equal(await vscode.workspace.applyEdit(userEdit), true);
          },
          document,
          edits: [{ newText: 'agent:', range: new vscode.Range(0, 0, 0, 0) }],
          expectedVersion: initialVersion,
          isWriteGranted: () => true,
        });
        assert.equal(outcome.status, 'stale');
        assert.equal(document.getText(), 'user:base\n');
      } finally {
        await revertAndClose(document);
      }
    });
  });

  test('uses all-or-nothing behavior for text-only workspace edits', async () => {
    await withTemporaryCase(async (caseUri) => {
      const firstUri = vscode.Uri.joinPath(caseUri, 'first.txt');
      const secondUri = vscode.Uri.joinPath(caseUri, 'second.txt');
      await Promise.all([
        vscode.workspace.fs.writeFile(firstUri, encode('first\n')),
        vscode.workspace.fs.writeFile(secondUri, encode('second\n')),
      ]);
      const first = await vscode.workspace.openTextDocument(firstUri);
      const second = await vscode.workspace.openTextDocument(secondUri);
      try {
        const success = new vscode.WorkspaceEdit();
        success.replace(firstUri, new vscode.Range(0, 0, 0, 5), 'FIRST');
        success.replace(secondUri, new vscode.Range(0, 0, 0, 6), 'SECOND');
        assert.equal(await vscode.workspace.applyEdit(success), true);
        assert.equal(first.getText(), 'FIRST\n');
        assert.equal(second.getText(), 'SECOND\n');

        await revertDocument(first);
        await revertDocument(second);
        const failure = new vscode.WorkspaceEdit();
        failure.replace(firstUri, new vscode.Range(0, 0, 0, 5), 'changed');
        failure.replace(
          vscode.Uri.parse('unsupported-write-spike:/missing.txt'),
          new vscode.Range(0, 0, 0, 0),
          'invalid',
        );
        assert.equal(await vscode.workspace.applyEdit(failure), false);
        assert.equal(first.getText(), 'first\n');
      } finally {
        await revertAndClose(first);
        await revertAndClose(second);
      }
    });
  });

  test('cancels before commit but does not pretend to undo after commit starts', async () => {
    await withTemporaryCase(async (caseUri) => {
      const uri = vscode.Uri.joinPath(caseUri, 'cancel.txt');
      await vscode.workspace.fs.writeFile(uri, encode('base\n'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      try {
        const before = new vscode.CancellationTokenSource();
        before.cancel();
        const cancelled = await applyVersionCheckedTextEdits({
          document,
          edits: [{ newText: 'x', range: new vscode.Range(0, 0, 0, 0) }],
          expectedVersion: document.version,
          token: before.token,
          isWriteGranted: () => true,
        });
        before.dispose();
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(document.getText(), 'base\n');

        const after = new vscode.CancellationTokenSource();
        const startedAt = performance.now();
        const committed = await applyVersionCheckedTextEdits({
          afterApplyStarted: () => after.cancel(),
          document,
          edits: [{ newText: 'agent:', range: new vscode.Range(0, 0, 0, 0) }],
          expectedVersion: document.version,
          token: after.token,
          isWriteGranted: () => true,
        });
        const elapsedMs = performance.now() - startedAt;
        after.dispose();
        assert.equal(committed.status, 'applied');
        assert.equal(document.getText(), 'agent:base\n');
        process.stdout.write(
          `WRITE_SPIKE_COMMIT_METRICS ${JSON.stringify({ cancelAfterCommitStartedMs: roundMilliseconds(elapsedMs) })}\n`,
        );
      } finally {
        await revertAndClose(document);
      }
    });
  });

  test('demonstrates why no asynchronous gap is allowed after the final version check', async () => {
    await withTemporaryCase(async (caseUri) => {
      const uri = vscode.Uri.joinPath(caseUri, 'race.txt');
      await vscode.workspace.fs.writeFile(uri, encode('base\n'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      try {
        const outcome = await applyVersionCheckedTextEdits({
          afterFinalCheck: async () => {
            const userEdit = new vscode.WorkspaceEdit();
            userEdit.insert(uri, new vscode.Position(0, 0), 'user:');
            assert.equal(await vscode.workspace.applyEdit(userEdit), true);
          },
          document,
          edits: [{ newText: 'agent:', range: new vscode.Range(0, 0, 0, 0) }],
          expectedVersion: document.version,
          isWriteGranted: () => true,
        });
        assert.equal(outcome.status, 'applied');
        assert.equal(document.getText(), 'agent:user:base\n');
        process.stdout.write(
          `WRITE_SPIKE_RACE_OBSERVED ${JSON.stringify({ asyncGapAllowedBothEdits: true })}\n`,
        );
      } finally {
        await revertAndClose(document);
      }
    });
  });
});

interface RequestedEdit {
  readonly newText: string;
  readonly range: vscode.Range;
}

interface ApplyOptions {
  readonly afterApplyStarted?: () => void;
  readonly afterFinalCheck?: () => Promise<void>;
  readonly beforeFinalCheck?: () => Promise<void>;
  readonly document: vscode.TextDocument;
  readonly edits: readonly RequestedEdit[];
  readonly expectedVersion: number;
  readonly isWriteGranted: () => boolean;
  readonly token?: vscode.CancellationToken;
}

type ApplyOutcome =
  | { readonly status: 'applied'; readonly version: number }
  | {
      readonly status: 'cancelled' | 'failed' | 'invalid' | 'not-granted' | 'stale';
    };

async function applyVersionCheckedTextEdits(
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  if (!options.isWriteGranted()) {
    return { status: 'not-granted' };
  }
  if (isCancelled(options.token)) {
    return { status: 'cancelled' };
  }
  if (options.document.version !== options.expectedVersion) {
    return { status: 'stale' };
  }
  if (!validNonOverlappingEdits(options.document, options.edits)) {
    return { status: 'invalid' };
  }

  await options.beforeFinalCheck?.();
  if (!options.isWriteGranted()) {
    return { status: 'not-granted' };
  }
  if (isCancelled(options.token)) {
    return { status: 'cancelled' };
  }
  if (options.document.version !== options.expectedVersion) {
    return { status: 'stale' };
  }

  await options.afterFinalCheck?.();
  if (isCancelled(options.token)) {
    return { status: 'cancelled' };
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(
    options.document.uri,
    options.edits.map((edit) => new vscode.TextEdit(edit.range, edit.newText)),
  );
  const applyPromise = vscode.workspace.applyEdit(workspaceEdit, {
    isRefactoring: true,
  });
  options.afterApplyStarted?.();
  if (!(await applyPromise)) {
    return { status: 'failed' };
  }
  return { status: 'applied', version: options.document.version };
}

function validNonOverlappingEdits(
  document: vscode.TextDocument,
  edits: readonly RequestedEdit[],
): boolean {
  const offsets = edits
    .map((edit) => ({
      end: document.offsetAt(edit.range.end),
      start: document.offsetAt(edit.range.start),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  return offsets.every(
    (edit, index) =>
      edit.start <= edit.end &&
      (index === 0 || (offsets[index - 1]?.end ?? 0) <= edit.start),
  );
}

async function withTemporaryCase(
  operation: (caseUri: vscode.Uri) => Promise<void>,
): Promise<void> {
  const fixture = requiredWorkspaceFolder('scanner-spike-fixture');
  const directory = await mkdtemp(join(fixture.uri.fsPath, 'write-case-'));
  try {
    await operation(vscode.Uri.file(directory));
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

async function revertDocument(document: vscode.TextDocument): Promise<void> {
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('workbench.action.files.revert');
}

async function revertAndClose(document: vscode.TextDocument): Promise<void> {
  if (document.isClosed) {
    return;
  }
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function isCancelled(token: vscode.CancellationToken | undefined): boolean {
  return token?.isCancellationRequested === true;
}
