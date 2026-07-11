import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import * as vscode from 'vscode';

suite('vscode-mcp extension', () => {
  test('is installed in the extension development host', () => {
    const extension = vscode.extensions.getExtension('vscode-mcp.vscode-mcp');
    assert.ok(extension);
    assert.equal(extension.packageJSON.version, '1.0.0');
  });

  test('registers the status command', async () => {
    const extension = vscode.extensions.getExtension('vscode-mcp.vscode-mcp');
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('vscode-mcp.showStatus'));
  });

  const testPosix =
    process.platform === 'darwin' || process.platform === 'linux' ? test : test.skip;

  testPosix(
    'serves the complete 39-tool surface through MCP, IPC, and the extension',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspacePath);
      const client = await startMcpClient(workspacePath);

      try {
        const toolsResponse = await client.request('tools/list', {});
        assert.ok(isRecord(toolsResponse));
        const toolItems = toolsResponse['tools'];
        assert.ok(Array.isArray(toolItems));
        const toolNames = toolItems.map((tool) => {
          assert.ok(isRecord(tool));
          return requiredString(tool, 'name');
        });
        assert.equal(toolNames.length, 39);
        assert.equal(toolNames[0], 'list_instances');
        assert.ok(toolNames.includes('search_workspace_text'));
        assert.ok(toolNames.includes('rename_symbol'));
        assert.ok(toolNames.includes('start_debugging'));
        const disabled = await callTool(client, 'list_instances', {});
        assert.deepEqual(instanceDescriptors(disabled), []);
        assert.equal(JSON.stringify(disabled).includes(workspacePath), false);

        await vscode.commands.executeCommand('vscode-mcp.enable');

        const firstInstance = await waitForSingleInstance(client);
        assertNoForbiddenInstanceMetadata(firstInstance);
        const instanceId = requiredString(firstInstance, 'instanceId');
        assert.equal(await registryRecordExists(instanceId), true);
        const folders = firstInstance['workspaceFolders'];
        assert.ok(Array.isArray(folders));
        const firstFolder = folders[0];
        assert.ok(isRecord(firstFolder));
        const workspaceFolderId = requiredString(firstFolder, 'workspaceFolderId');

        const capabilityResponse = await callTool(client, 'get_capability_status', {
          instanceId,
        });
        const capabilityResult = requiredRecord(
          requiredRecord(capabilityResponse, 'structuredContent'),
          'result',
        );
        assert.equal(capabilityResult['read'], true);
        assert.equal(capabilityResult['write'], false);
        assert.equal(capabilityResult['execution'], false);

        const filesResponse = await callTool(client, 'list_workspace_files', {
          instanceId,
          workspaceFolderId,
          limit: 100,
        });
        const filesResult = requiredRecord(
          requiredRecord(filesResponse, 'structuredContent'),
          'result',
        );
        const files = filesResult['files'];
        assert.ok(Array.isArray(files));
        assert.ok(files.includes('index.ts'));

        const readResponse = await callTool(client, 'read_document', {
          instanceId,
          document: {
            kind: 'workspacePath',
            workspaceFolderId,
            relativePath: 'index.ts',
          },
          startLine: 0,
          lineCount: 2,
        });
        const readStructured = requiredRecord(readResponse, 'structuredContent');
        assert.equal(
          recordProperty(readResponse, 'isError'),
          undefined,
          `read_document returned MCP tool error ${
            recordProperty(readResponse, 'isError') === true
              ? toolFailureCode(readResponse)
              : 'UNKNOWN'
          }`,
        );
        assert.equal(readStructured['instanceId'], instanceId);
        const readResult = requiredRecord(readStructured, 'result');
        assert.match(String(readResult['text']), /export function greet/);

        const document = {
          kind: 'workspacePath',
          workspaceFolderId,
          relativePath: 'index.ts',
        };
        const toolCalls: ReadonlyArray<{
          readonly name: string;
          readonly arguments: Record<string, unknown>;
        }> = [
          { name: 'get_editor_context', arguments: { instanceId } },
          {
            name: 'get_diagnostics',
            arguments: { instanceId, document, limit: 10 },
          },
          {
            name: 'get_hover',
            arguments: {
              instanceId,
              document,
              position: { line: 0, character: 16 },
            },
          },
          {
            name: 'get_definition',
            arguments: {
              instanceId,
              document,
              position: { line: 4, character: 1 },
            },
          },
          {
            name: 'find_references',
            arguments: {
              instanceId,
              document,
              position: { line: 0, character: 16 },
              limit: 10,
            },
          },
          {
            name: 'get_document_symbols',
            arguments: { instanceId, document, limit: 10 },
          },
          {
            name: 'search_workspace_symbols',
            arguments: { instanceId, query: 'greet', limit: 10 },
          },
          {
            name: 'get_signature_help',
            arguments: {
              instanceId,
              document,
              position: { line: 4, character: 6 },
            },
          },
          {
            name: 'get_call_hierarchy',
            arguments: {
              instanceId,
              document,
              position: { line: 0, character: 16 },
              limitPerDirection: 10,
            },
          },
          {
            name: 'get_completions',
            arguments: {
              instanceId,
              document,
              position: { line: 4, character: 6 },
              limit: 20,
            },
          },
          {
            name: 'get_code_actions',
            arguments: {
              instanceId,
              document,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 10 },
              },
              limit: 20,
            },
          },
          {
            name: 'get_document_highlights',
            arguments: {
              instanceId,
              document,
              position: { line: 0, character: 16 },
            },
          },
          {
            name: 'get_type_hierarchy',
            arguments: {
              instanceId,
              document,
              position: { line: 0, character: 16 },
              direction: 'both',
            },
          },
          {
            name: 'get_inlay_hints',
            arguments: {
              instanceId,
              document,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 4, character: 20 },
              },
            },
          },
          { name: 'get_folding_ranges', arguments: { instanceId, document } },
          {
            name: 'get_selection_ranges',
            arguments: {
              instanceId,
              document,
              positions: [{ line: 0, character: 16 }],
            },
          },
          { name: 'get_document_links', arguments: { instanceId, document } },
        ];
        for (const toolCall of toolCalls) {
          const response = await callTool(client, toolCall.name, toolCall.arguments);
          assert.equal(
            recordProperty(response, 'isError'),
            undefined,
            `${toolCall.name} returned MCP tool error ${
              recordProperty(response, 'isError') === true
                ? toolFailureCode(response)
                : 'UNKNOWN'
            }`,
          );
          const structured = requiredRecord(response, 'structuredContent');
          assert.equal(structured['instanceId'], instanceId);
        }

        await vscode.commands.executeCommand('vscode-mcp.disable');
        await eventually(async () =>
          (await registryRecordExists(instanceId)) ? null : true,
        );
        const withdrawn = await callTool(client, 'list_instances', {});
        assert.deepEqual(instanceDescriptors(withdrawn), []);
        assert.equal(JSON.stringify(withdrawn).includes(workspacePath), false);
      } finally {
        client.close();
        await vscode.commands.executeCommand('vscode-mcp.disable');
      }
    },
  );

  testPosix(
    'withdraws a changed workspace fingerprint until it is explicitly enabled',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspacePath);
      const workspaceFilePath = vscode.workspace.workspaceFile?.fsPath;
      assert.ok(workspaceFilePath);
      const originalWorkspaceFile = await readFile(workspaceFilePath, 'utf8');
      const addedWorkspacePath = await mkdtemp(
        join(dirname(workspacePath), 'vscode-mcp-host-added-workspace-'),
      );
      const addedWorkspaceUri = vscode.Uri.file(addedWorkspacePath);
      await writeFile(
        join(addedWorkspacePath, 'added.ts'),
        'export const addedWorkspaceFixture = true;\n',
      );
      const client = await startMcpClient(workspacePath);
      let workspaceFolderAdded = false;

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const original = await waitForSingleInstance(client);
        const originalInstanceId = requiredString(original, 'instanceId');
        assert.equal(await registryRecordExists(originalInstanceId), true);
        const originalFolders = original['workspaceFolders'];
        assert.ok(Array.isArray(originalFolders));
        const originalFolderCount = originalFolders.length;

        const insertionIndex = vscode.workspace.workspaceFolders?.length ?? 0;
        workspaceFolderAdded = vscode.workspace.updateWorkspaceFolders(
          insertionIndex,
          0,
          { uri: addedWorkspaceUri, name: 'added-workspace' },
        );
        assert.equal(workspaceFolderAdded, true);
        await waitForWorkspaceFolder(addedWorkspaceUri, true);

        await eventually(async () => {
          const instances = instanceDescriptors(
            await callTool(client, 'list_instances', {}),
          );
          return instances.length === 0 &&
            !(await registryRecordExists(originalInstanceId))
            ? true
            : null;
        });

        await vscode.commands.executeCommand('vscode-mcp.enable');
        const changed = await waitForSingleInstance(client);
        const changedInstanceId = requiredString(changed, 'instanceId');
        assert.notEqual(changedInstanceId, originalInstanceId);
        assert.equal(await registryRecordExists(changedInstanceId), true);
        assert.equal(await registryRecordExists(originalInstanceId), false);
        const changedFolders = changed['workspaceFolders'];
        assert.ok(Array.isArray(changedFolders));
        assert.equal(changedFolders.length, originalFolderCount + 1);
      } finally {
        client.close();
        if (workspaceFolderAdded) {
          await vscode.commands.executeCommand('vscode-mcp.disable');
          const folderIndex = vscode.workspace.workspaceFolders?.findIndex(
            (folder) => folder.uri.toString() === addedWorkspaceUri.toString(),
          );
          if (folderIndex !== undefined && folderIndex >= 0) {
            await removeWorkspaceFolder(addedWorkspaceUri);
            await waitForWorkspaceFolder(addedWorkspaceUri, false);
          }
        }
        await vscode.commands.executeCommand('vscode-mcp.disable');
        await rm(addedWorkspacePath, { recursive: true, force: true });
        // The workspace-folder event precedes VS Code's asynchronous workspace-file
        // save. Let that write finish before restoring the byte-exact fixture.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        await writeFile(workspaceFilePath, originalWorkspaceFile);
        // Restoring the workspace file can enqueue one final configuration refresh.
        // Do not let that intentional listener rotation bleed into the next workflow.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      }
    },
  );

  testPosix(
    'enforces write grants and completes the file/edit lifecycle',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspacePath);
      const caseDirectory = await mkdtemp(join(workspacePath, 'v1-write-case-'));
      const relativeDirectory = basename(caseDirectory);
      const createdPath = `${relativeDirectory}/created.ts`;
      const secondPath = `${relativeDirectory}/second.ts`;
      const movedPath = `${relativeDirectory}/moved.ts`;
      const createdUri = vscode.Uri.file(join(workspacePath, createdPath));
      const secondUri = vscode.Uri.file(join(workspacePath, secondPath));
      const movedUri = vscode.Uri.file(join(workspacePath, movedPath));
      const externalDirectory = await mkdtemp(
        join(dirname(workspacePath), 'vscode-mcp-write-external-'),
      );
      const linkedParent = join(caseDirectory, 'linked-parent');
      await symlink(externalDirectory, linkedParent, 'dir');
      const client = await startMcpClient(workspacePath);

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const instance = await waitForSingleInstance(client);
        const instanceId = requiredString(instance, 'instanceId');
        const folders = instance['workspaceFolders'];
        assert.ok(Array.isArray(folders));
        const folder = folders[0];
        assert.ok(isRecord(folder));
        const workspaceFolderId = requiredString(folder, 'workspaceFolderId');
        const destination = { workspaceFolderId, relativePath: createdPath };

        const denied = await callTool(client, 'create_workspace_file', {
          instanceId,
          destination,
          content: 'export const alpha = 1;\n',
        });
        assertToolFailure(denied, 'WRITE_NOT_ENABLED');

        await vscode.commands.executeCommand('vscode-mcp.enableWrites');
        const created = await callTool(client, 'create_workspace_file', {
          instanceId,
          destination,
          content: 'export const alpha = 1;\n',
        });
        assert.equal(recordProperty(created, 'isError'), undefined);
        const overwrite = await callTool(client, 'create_workspace_file', {
          instanceId,
          destination,
          content: 'overwrite is forbidden\n',
        });
        assertToolFailure(overwrite, 'FILE_ALREADY_EXISTS');
        const missingParent = await callTool(client, 'create_workspace_file', {
          instanceId,
          destination: {
            workspaceFolderId,
            relativePath: `${relativeDirectory}/missing/child.ts`,
          },
          content: 'missing parent\n',
        });
        assertToolFailure(missingParent, 'PARENT_NOT_FOUND');
        const symlinkParent = await callTool(client, 'create_workspace_file', {
          instanceId,
          destination: {
            workspaceFolderId,
            relativePath: `${relativeDirectory}/linked-parent/escape.ts`,
          },
          content: 'must not escape\n',
        });
        assertToolFailure(symlinkParent, 'DIRECTORY_OPERATION_UNSUPPORTED');
        await assert.rejects(access(join(externalDirectory, 'escape.ts')));

        const secondDocument = {
          kind: 'workspacePath',
          workspaceFolderId,
          relativePath: secondPath,
        };
        const secondCreated = await callTool(client, 'create_workspace_file', {
          instanceId,
          destination: { workspaceFolderId, relativePath: secondPath },
          content: 'export const second = 2;\n',
        });
        assert.equal(recordProperty(secondCreated, 'isError'), undefined);

        const document = {
          kind: 'workspacePath',
          workspaceFolderId,
          relativePath: createdPath,
        };
        let snapshot = await readToolDocument(client, instanceId, document);
        let secondSnapshot = await readToolDocument(client, instanceId, secondDocument);
        const staleMulti = await callTool(client, 'apply_text_edits', {
          instanceId,
          documents: [
            {
              document,
              expectedDocumentVersion: requiredNumber(
                snapshot.document,
                'documentVersion',
              ),
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                  newText: '// must-not-apply\n',
                },
              ],
            },
            {
              document: secondDocument,
              expectedDocumentVersion:
                requiredNumber(secondSnapshot.document, 'documentVersion') + 1,
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                  newText: '// stale\n',
                },
              ],
            },
          ],
        });
        assertToolFailure(staleMulti, 'DOCUMENT_VERSION_MISMATCH');
        snapshot = await readToolDocument(client, instanceId, document);
        assert.doesNotMatch(String(snapshot.result['text']), /must-not-apply/);
        const multiEdited = await callTool(client, 'apply_text_edits', {
          instanceId,
          documents: [
            {
              document,
              expectedDocumentVersion: requiredNumber(
                snapshot.document,
                'documentVersion',
              ),
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                  newText: '// multi\n',
                },
              ],
            },
            {
              document: secondDocument,
              expectedDocumentVersion: requiredNumber(
                secondSnapshot.document,
                'documentVersion',
              ),
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 },
                  },
                  newText: '// multi\n',
                },
              ],
            },
          ],
        });
        assert.equal(recordProperty(multiEdited, 'isError'), undefined);
        snapshot = await readToolDocument(client, instanceId, document);
        secondSnapshot = await readToolDocument(client, instanceId, secondDocument);
        assert.match(String(snapshot.result['text']), /multi/);
        assert.match(String(secondSnapshot.result['text']), /multi/);
        const multiRestored = await callTool(client, 'apply_text_edits', {
          instanceId,
          documents: [
            {
              document,
              expectedDocumentVersion: requiredNumber(
                snapshot.document,
                'documentVersion',
              ),
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 1, character: 0 },
                  },
                  newText: '',
                },
              ],
            },
            {
              document: secondDocument,
              expectedDocumentVersion: requiredNumber(
                secondSnapshot.document,
                'documentVersion',
              ),
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 1, character: 0 },
                  },
                  newText: '',
                },
              ],
            },
          ],
        });
        assert.equal(recordProperty(multiRestored, 'isError'), undefined);
        snapshot = await readToolDocument(client, instanceId, document);
        assert.match(String(snapshot.result['text']), /alpha/);
        assert.doesNotMatch(String(snapshot.result['text']), /multi/);
        const initialVersion = requiredNumber(snapshot.document, 'documentVersion');
        const alphaStart = String(snapshot.result['text']).indexOf('alpha');
        assert.ok(alphaStart >= 0);

        const overlapping = await callTool(client, 'apply_text_edits', {
          instanceId,
          documents: [
            {
              document,
              expectedDocumentVersion: initialVersion,
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 },
                  },
                  newText: 'first',
                },
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 },
                  },
                  newText: 'second',
                },
              ],
            },
          ],
        });
        assertToolFailure(overlapping, 'EDIT_CONFLICT');

        const edited = await callTool(client, 'apply_text_edits', {
          instanceId,
          documents: [
            {
              document,
              expectedDocumentVersion: initialVersion,
              edits: [
                {
                  range: {
                    start: { line: 0, character: alphaStart },
                    end: { line: 0, character: alphaStart + 5 },
                  },
                  newText: 'beta',
                },
              ],
            },
          ],
        });
        assert.equal(
          recordProperty(edited, 'isError'),
          undefined,
          recordProperty(edited, 'isError') === true
            ? toolFailureCode(edited)
            : 'unexpected edit response',
        );
        snapshot = await readToolDocument(client, instanceId, document);
        assert.match(String(snapshot.result['text']), /beta/);

        const editedVersion = requiredNumber(snapshot.document, 'documentVersion');
        const reverted = await callTool(client, 'revert_documents', {
          instanceId,
          documents: [{ document, expectedDocumentVersion: editedVersion }],
        });
        assert.equal(recordProperty(reverted, 'isError'), undefined);
        snapshot = await readToolDocument(client, instanceId, document);
        assert.match(String(snapshot.result['text']), /alpha/);

        const actionProvider = vscode.languages.registerCodeActionsProvider(
          { scheme: 'file', language: 'typescript', pattern: `**/${createdPath}` },
          {
            provideCodeActions: () => {
              const safe = new vscode.CodeAction(
                'VS Code MCP safe edit action',
                vscode.CodeActionKind.QuickFix,
              );
              safe.edit = new vscode.WorkspaceEdit();
              safe.edit.replace(
                createdUri,
                new vscode.Range(0, alphaStart, 0, alphaStart + 5),
                'delta',
              );
              const command = new vscode.CodeAction(
                'VS Code MCP command action',
                vscode.CodeActionKind.QuickFix,
              );
              command.command = {
                command: 'vscode-mcp-test.must-not-run',
                title: 'must not run',
              };
              return [safe, command];
            },
          },
        );
        try {
          const actionsResponse = await callTool(client, 'get_code_actions', {
            instanceId,
            document,
            expectedDocumentVersion: requiredNumber(
              snapshot.document,
              'documentVersion',
            ),
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 24 },
            },
            kinds: ['quickfix'],
            limit: 100,
          });
          const actionsResult = requiredRecord(
            requiredRecord(actionsResponse, 'structuredContent'),
            'result',
          );
          const actions = actionsResult['actions'];
          assert.ok(Array.isArray(actions));
          const safeAction = actions.find(
            (candidate) =>
              isRecord(candidate) &&
              candidate['title'] === 'VS Code MCP safe edit action',
          );
          assert.ok(isRecord(safeAction));
          const previewToken = requiredString(safeAction, 'previewToken');
          assert.ok(isRecord(safeAction['preview']));
          const commandAction = actions.find(
            (candidate) =>
              isRecord(candidate) &&
              candidate['title'] === 'VS Code MCP command action',
          );
          assert.ok(isRecord(commandAction));
          assert.equal(commandAction['previewToken'], null);

          const actionApplied = await callTool(client, 'apply_code_action', {
            instanceId,
            previewToken,
          });
          assert.equal(recordProperty(actionApplied, 'isError'), undefined);
          snapshot = await readToolDocument(client, instanceId, document);
          assert.match(String(snapshot.result['text']), /delta/);
          const reused = await callTool(client, 'apply_code_action', {
            instanceId,
            previewToken,
          });
          assertToolFailure(reused, 'PREVIEW_ALREADY_USED');
          const actionReverted = await callTool(client, 'revert_documents', {
            instanceId,
            documents: [
              {
                document,
                expectedDocumentVersion: requiredNumber(
                  snapshot.document,
                  'documentVersion',
                ),
              },
            ],
          });
          assert.equal(recordProperty(actionReverted, 'isError'), undefined);
          snapshot = await readToolDocument(client, instanceId, document);

          const refreshedActions = await callTool(client, 'get_code_actions', {
            instanceId,
            document,
            expectedDocumentVersion: requiredNumber(
              snapshot.document,
              'documentVersion',
            ),
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 24 },
            },
            kinds: ['quickfix'],
            limit: 100,
          });
          const refreshedItems = requiredRecord(
            requiredRecord(refreshedActions, 'structuredContent'),
            'result',
          )['actions'];
          assert.ok(Array.isArray(refreshedItems));
          const refreshedSafe = refreshedItems.find(
            (candidate) =>
              isRecord(candidate) &&
              candidate['title'] === 'VS Code MCP safe edit action',
          );
          assert.ok(isRecord(refreshedSafe));
          const revokedToken = requiredString(refreshedSafe, 'previewToken');
          await vscode.commands.executeCommand('vscode-mcp.disableWrites');
          await vscode.commands.executeCommand('vscode-mcp.enableWrites');
          const revokedPreview = await callTool(client, 'apply_code_action', {
            instanceId,
            previewToken: revokedToken,
          });
          assertToolFailure(revokedPreview, 'PREVIEW_ALREADY_USED');
        } finally {
          actionProvider.dispose();
        }

        const renameVersion = requiredNumber(snapshot.document, 'documentVersion');
        const renamed = await callTool(client, 'rename_symbol', {
          instanceId,
          document,
          expectedDocumentVersion: renameVersion,
          position: { line: 0, character: alphaStart + 1 },
          newName: 'gamma',
        });
        assert.equal(recordProperty(renamed, 'isError'), undefined);
        snapshot = await readToolDocument(client, instanceId, document);
        assert.match(String(snapshot.result['text']), /gamma/);
        const renamedVersion = requiredNumber(snapshot.document, 'documentVersion');
        const renameReverted = await callTool(client, 'revert_documents', {
          instanceId,
          documents: [{ document, expectedDocumentVersion: renamedVersion }],
        });
        assert.equal(recordProperty(renameReverted, 'isError'), undefined);

        const moved = await callTool(client, 'move_workspace_file', {
          instanceId,
          source: document,
          destination: { workspaceFolderId, relativePath: movedPath },
        });
        assert.equal(recordProperty(moved, 'isError'), undefined);
        const movedDocument = { ...document, relativePath: movedPath };
        const movedSnapshot = await readToolDocument(client, instanceId, movedDocument);
        assert.match(String(movedSnapshot.result['text']), /alpha/);

        const deleted = await callTool(client, 'delete_workspace_file', {
          instanceId,
          document: movedDocument,
        });
        assert.equal(recordProperty(deleted, 'isError'), undefined);
        const secondDeleted = await callTool(client, 'delete_workspace_file', {
          instanceId,
          document: secondDocument,
        });
        assert.equal(recordProperty(secondDeleted, 'isError'), undefined);
        const missing = await callTool(client, 'read_document', {
          instanceId,
          document: movedDocument,
        });
        assertToolFailure(missing, 'DOCUMENT_NOT_FOUND');

        await vscode.commands.executeCommand('vscode-mcp.disableWrites');
        const status = await callTool(client, 'get_capability_status', { instanceId });
        const statusResult = requiredRecord(
          requiredRecord(status, 'structuredContent'),
          'result',
        );
        assert.equal(statusResult['write'], false);
      } finally {
        client.close();
        await vscode.commands.executeCommand('vscode-mcp.disable');
        await closeTabsForUris([
          createdUri.toString(),
          secondUri.toString(),
          movedUri.toString(),
        ]);
        await rm(caseDirectory, { force: true, recursive: true });
        await rm(externalDirectory, { force: true, recursive: true });
      }
    },
  );

  testPosix(
    'formats and saves text while rejecting opaque provider resource edits',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');
      const workspace = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspace);
      const caseDirectory = await mkdtemp(
        join(workspace.uri.fsPath, 'v1-format-case-'),
      );
      const relativePath = `${basename(caseDirectory)}/format.vscode-mcp-format`;
      const filePath = join(workspace.uri.fsPath, relativePath);
      const fileUri = vscode.Uri.file(filePath);
      await writeFile(filePath, 'export const value=1;\n', 'utf8');
      const formatter = vscode.languages.registerDocumentFormattingEditProvider(
        { scheme: 'file', pattern: `**/${relativePath}` },
        {
          provideDocumentFormattingEdits: (document) => [
            vscode.TextEdit.replace(
              new vscode.Range(
                new vscode.Position(0, 0),
                document.positionAt(document.getText().length),
              ),
              'export const value = 1;\n',
            ),
          ],
        },
      );
      const opaqueActions = vscode.languages.registerCodeActionsProvider(
        { scheme: 'file', pattern: `**/${relativePath}` },
        {
          provideCodeActions: () => {
            const action = new vscode.CodeAction(
              'Opaque resource operation',
              vscode.CodeActionKind.QuickFix,
            );
            action.edit = new vscode.WorkspaceEdit();
            action.edit.createFile(vscode.Uri.joinPath(workspace.uri, 'forbidden.ts'));
            return [action];
          },
        },
      );
      const client = await startMcpClient(workspace.uri.fsPath);

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const instance = await waitForSingleInstance(client);
        let instanceId = requiredString(instance, 'instanceId');
        const folders = instance['workspaceFolders'];
        assert.ok(Array.isArray(folders));
        const folder = folders[0];
        assert.ok(isRecord(folder));
        const workspaceFolderId = requiredString(folder, 'workspaceFolderId');
        const document = { kind: 'workspacePath', workspaceFolderId, relativePath };
        await vscode.commands.executeCommand('vscode-mcp.enableWrites');
        instanceId = await eventually(async () => {
          const current = await waitForSingleInstance(client);
          const candidateId = requiredString(current, 'instanceId');
          const capability = await callTool(client, 'get_capability_status', {
            instanceId: candidateId,
          });
          const structured = recordProperty(capability, 'structuredContent');
          const result = isRecord(structured)
            ? recordProperty(structured, 'result')
            : undefined;
          return isRecord(result) && result['write'] === true ? candidateId : null;
        });
        let snapshot = await readToolDocument(client, instanceId, document);
        const formatted = await callTool(client, 'format_document', {
          instanceId,
          document,
          expectedDocumentVersion: requiredNumber(snapshot.document, 'documentVersion'),
          options: { tabSize: 2, insertSpaces: true },
        });
        assert.equal(
          recordProperty(formatted, 'isError'),
          undefined,
          JSON.stringify(formatted),
        );
        snapshot = await readToolDocument(client, instanceId, document);
        assert.equal(snapshot.result['text'], 'export const value = 1;\n');

        const saved = await callTool(client, 'save_documents', {
          instanceId,
          documents: [
            {
              document,
              expectedDocumentVersion: requiredNumber(
                snapshot.document,
                'documentVersion',
              ),
            },
          ],
        });
        assert.equal(recordProperty(saved, 'isError'), undefined);
        assert.equal(await readFile(filePath, 'utf8'), 'export const value = 1;\n');

        const actions = await callTool(client, 'get_code_actions', {
          instanceId,
          document,
          expectedDocumentVersion: requiredNumber(snapshot.document, 'documentVersion'),
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          kinds: ['quickfix'],
          limit: 100,
        });
        const actionItems = requiredRecord(
          requiredRecord(actions, 'structuredContent'),
          'result',
        )['actions'];
        assert.ok(Array.isArray(actionItems));
        const opaque = actionItems.find(
          (candidate) =>
            isRecord(candidate) && candidate['title'] === 'Opaque resource operation',
        );
        assert.ok(isRecord(opaque));
        assert.equal(opaque['previewToken'], null);
        await assert.rejects(access(join(workspace.uri.fsPath, 'forbidden.ts')));
      } finally {
        client.close();
        formatter.dispose();
        opaqueActions.dispose();
        await vscode.commands.executeCommand('vscode-mcp.disable');
        await closeTabsForUris([fileUri.toString()]);
        await rm(caseDirectory, { force: true, recursive: true });
        await rm(join(workspace.uri.fsPath, 'forbidden.ts'), { force: true });
      }
    },
  );

  testPosix(
    'lists and runs only configured tasks under the execution grant',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');
      const workspace = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspace);
      const closeEmitter = new vscode.EventEmitter<number>();
      const writeEmitter = new vscode.EventEmitter<string>();
      let taskOpenCount = 0;
      let taskTimer: NodeJS.Timeout | undefined;
      let ambiguous = false;
      const terminal: vscode.Pseudoterminal = {
        onDidClose: closeEmitter.event,
        onDidWrite: writeEmitter.event,
        open: () => {
          taskOpenCount += 1;
          writeEmitter.fire('configured task executed\r\n');
          taskTimer = setTimeout(
            () => closeEmitter.fire(0),
            taskOpenCount === 1 ? 20 : 10_000,
          );
        },
        close: () => {
          if (taskTimer !== undefined) clearTimeout(taskTimer);
          closeEmitter.fire(0);
        },
      };
      const provider = vscode.tasks.registerTaskProvider('vscode-mcp-test', {
        provideTasks: () => {
          const task = () =>
            new vscode.Task(
              { type: 'vscode-mcp-test' },
              workspace,
              'Agent Workflow Task',
              'vscode-mcp-test',
              new vscode.CustomExecution(async () => terminal),
              [],
            );
          return ambiguous ? [task(), task()] : [task()];
        },
        resolveTask: () => undefined,
      });
      const client = await startMcpClient(workspace.uri.fsPath);

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const instance = await waitForSingleInstance(client);
        const instanceId = requiredString(instance, 'instanceId');
        const listed = await callTool(client, 'list_tasks', { instanceId });
        const listedResult = requiredRecord(
          requiredRecord(listed, 'structuredContent'),
          'result',
        );
        const tasks = listedResult['tasks'];
        assert.ok(Array.isArray(tasks));
        const task = tasks.find(
          (candidate) =>
            isRecord(candidate) && candidate['name'] === 'Agent Workflow Task',
        );
        assert.ok(isRecord(task));
        const taskId = requiredString(task, 'id');

        const denied = await callTool(client, 'run_task', { instanceId, taskId });
        assertToolFailure(denied, 'EXECUTION_NOT_ENABLED');
        await vscode.commands.executeCommand('vscode-mcp.enableExecution');
        const forged = await callTool(client, 'run_task', {
          instanceId,
          taskId: '00000000-0000-4000-8000-000000000000',
        });
        assertToolFailure(forged, 'TASK_NOT_FOUND');
        ambiguous = true;
        const ambiguousRun = await callTool(client, 'run_task', {
          instanceId,
          taskId,
        });
        assertToolFailure(ambiguousRun, 'TASK_AMBIGUOUS');
        ambiguous = false;
        const started = await callTool(client, 'run_task', { instanceId, taskId });
        const startResult = requiredRecord(
          requiredRecord(started, 'structuredContent'),
          'result',
        );
        const executionId = requiredString(startResult, 'executionId');
        const ended = await eventually(async () => {
          const response = await callTool(client, 'get_task_execution', {
            instanceId,
            executionId,
          });
          const result = requiredRecord(
            requiredRecord(response, 'structuredContent'),
            'result',
          );
          return result['state'] === 'ended' ? result : null;
        });
        assert.equal(ended['exitCode'], 0);
        const hanging = await callTool(client, 'run_task', { instanceId, taskId });
        const hangingResult = requiredRecord(
          requiredRecord(hanging, 'structuredContent'),
          'result',
        );
        const hangingExecutionId = requiredString(hangingResult, 'executionId');
        await vscode.commands.executeCommand('vscode-mcp.disableExecution');
        const terminated = await callTool(client, 'get_task_execution', {
          instanceId,
          executionId: hangingExecutionId,
        });
        const terminatedResult = requiredRecord(
          requiredRecord(terminated, 'structuredContent'),
          'result',
        );
        assert.equal(terminatedResult['state'], 'terminated');
        const revoked = await callTool(client, 'run_task', { instanceId, taskId });
        assertToolFailure(revoked, 'EXECUTION_NOT_ENABLED');
      } finally {
        client.close();
        provider.dispose();
        closeEmitter.dispose();
        writeEmitter.dispose();
        await vscode.commands.executeCommand('vscode-mcp.disable');
      }
    },
  );

  testPosix(
    'starts and stops only a named tracked debug configuration',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');
      const workspace = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspace);
      const vscodeDirectory = join(workspace.uri.fsPath, '.vscode');
      const launchPath = join(vscodeDirectory, 'launch.json');
      const programPath = join(workspace.uri.fsPath, '.vscode-mcp-debug-fixture.js');
      await mkdir(vscodeDirectory, { recursive: true });
      await writeFile(programPath, 'setTimeout(() => {}, 10_000);\n', 'utf8');
      await writeFile(
        launchPath,
        JSON.stringify({
          version: '0.2.0',
          configurations: [
            {
              name: 'VS Code MCP Inline Debug',
              type: 'node',
              request: 'launch',
              program: programPath,
            },
          ],
        }),
        'utf8',
      );
      const client = await startMcpClient(workspace.uri.fsPath);

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const instance = await waitForSingleInstance(client);
        const instanceId = requiredString(instance, 'instanceId');
        const folders = instance['workspaceFolders'];
        assert.ok(Array.isArray(folders));
        const folder = folders[0];
        assert.ok(isRecord(folder));
        const workspaceFolderId = requiredString(folder, 'workspaceFolderId');
        const stateResult = await eventually(async () => {
          const state = await callTool(client, 'get_debug_state', { instanceId });
          const result = requiredRecord(
            requiredRecord(state, 'structuredContent'),
            'result',
          );
          const items = result['configurations'];
          return Array.isArray(items) &&
            items.some(
              (item) => isRecord(item) && item['name'] === 'VS Code MCP Inline Debug',
            )
            ? result
            : null;
        });
        const configurations = stateResult['configurations'];
        assert.ok(Array.isArray(configurations));
        assert.ok(
          configurations.some(
            (item) => isRecord(item) && item['name'] === 'VS Code MCP Inline Debug',
          ),
        );

        const denied = await callTool(client, 'start_debugging', {
          instanceId,
          workspaceFolderId,
          configurationName: 'VS Code MCP Inline Debug',
        });
        assertToolFailure(denied, 'EXECUTION_NOT_ENABLED');
        await vscode.commands.executeCommand('vscode-mcp.enableExecution');
        const unknown = await callTool(client, 'start_debugging', {
          instanceId,
          workspaceFolderId,
          configurationName: 'Not a configured debug target',
          noDebug: true,
        });
        assertToolFailure(unknown, 'DEBUG_CONFIGURATION_NOT_FOUND');
        const started = await callTool(client, 'start_debugging', {
          instanceId,
          workspaceFolderId,
          configurationName: 'VS Code MCP Inline Debug',
          noDebug: true,
        });
        assert.equal(
          recordProperty(started, 'isError'),
          undefined,
          JSON.stringify(started),
        );
        const startedResult = requiredRecord(
          requiredRecord(started, 'structuredContent'),
          'result',
        );
        const debugSessionId = requiredString(startedResult, 'debugSessionId');
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
        const stopped = await callTool(client, 'stop_debugging', {
          instanceId,
          debugSessionId,
        });
        assert.equal(recordProperty(stopped, 'isError'), undefined);
        const staleStop = await callTool(client, 'stop_debugging', {
          instanceId,
          debugSessionId,
        });
        assertToolFailure(staleStop, 'DEBUG_SESSION_NOT_FOUND');
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
        const restarted = await callTool(client, 'start_debugging', {
          instanceId,
          workspaceFolderId,
          configurationName: 'VS Code MCP Inline Debug',
          noDebug: true,
        });
        assert.equal(recordProperty(restarted, 'isError'), undefined);
        await vscode.commands.executeCommand('vscode-mcp.disableExecution');
        const revokedState = await callTool(client, 'get_debug_state', { instanceId });
        const revokedStateResult = requiredRecord(
          requiredRecord(revokedState, 'structuredContent'),
          'result',
        );
        const sessions = revokedStateResult['sessions'];
        assert.ok(Array.isArray(sessions));
        assert.ok(
          sessions.some(
            (session) => isRecord(session) && session['state'] === 'stopped',
          ),
        );
      } finally {
        client.close();
        await vscode.commands.executeCommand('vscode-mcp.disable');
        await rm(launchPath, { force: true });
        await rm(programPath, { force: true });
        await rm(vscodeDirectory, { force: true, recursive: true });
      }
    },
  );

  testPosix(
    'filters external locations returned by a real language provider',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspacePath);
      const fixtureName = '.vscode-mcp-host-definition-provider.txt';
      const fixturePath = join(workspacePath, fixtureName);
      const fixtureUri = vscode.Uri.file(fixturePath);
      const externalDirectory = await mkdtemp(
        join(dirname(workspacePath), 'vscode-mcp-host-provider-external-'),
      );
      const externalPath = join(externalDirectory, 'external-definition.txt');
      const externalUri = vscode.Uri.file(externalPath);
      await writeFile(fixturePath, 'internal provider target\n');
      await writeFile(externalPath, 'VSCODE_MCP_EXTERNAL_PROVIDER_CANARY\n');
      const document = await vscode.workspace.openTextDocument(fixtureUri);
      let providerInvocations = 0;
      const provider = vscode.languages.registerDefinitionProvider(
        {
          scheme: 'file',
          language: document.languageId,
          pattern: `**/${fixtureName}`,
        },
        {
          provideDefinition: () => {
            providerInvocations += 1;
            return [
              new vscode.Location(
                fixtureUri,
                new vscode.Range(0, 0, 0, 'internal'.length),
              ),
              new vscode.Location(externalUri, new vscode.Range(0, 0, 0, 1)),
            ];
          },
        },
      );
      const client = await startMcpClient(workspacePath);

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const instance = await waitForSingleInstance(client);
        const instanceId = requiredString(instance, 'instanceId');
        const response = await callTool(client, 'get_definition', {
          instanceId,
          document: { kind: 'uri', uri: fixtureUri.toString() },
          position: { line: 0, character: 0 },
          limit: 10,
        });
        assert.equal(recordProperty(response, 'isError'), undefined);
        assert.equal(providerInvocations, 1);

        const structured = requiredRecord(response, 'structuredContent');
        const result = requiredRecord(structured, 'result');
        const locations = result['locations'];
        assert.ok(Array.isArray(locations));
        assert.equal(locations.length, 1);
        const location = locations[0];
        assert.ok(isRecord(location));
        assert.equal(location['uri'], fixtureUri.toString());

        const warnings = structured['warnings'];
        assert.ok(Array.isArray(warnings));
        const externalWarning = warnings.find(
          (warning) =>
            isRecord(warning) && warning['code'] === 'EXTERNAL_LOCATIONS_OMITTED',
        );
        assert.ok(isRecord(externalWarning));
        assert.equal(externalWarning['omittedCount'], 1);
        const serialized = JSON.stringify(response);
        assert.equal(serialized.includes(externalUri.toString()), false);
        assert.equal(serialized.includes(externalPath), false);
        assert.equal(serialized.includes('VSCODE_MCP_EXTERNAL_PROVIDER_CANARY'), false);
      } finally {
        provider.dispose();
        client.close();
        await vscode.commands.executeCommand('vscode-mcp.disable');
        await closeTabsForUris([fixtureUri.toString()]);
        await rm(fixturePath, { force: true });
        await rm(externalDirectory, { recursive: true, force: true });
      }
    },
  );

  testPosix(
    'bounds and reports oversized additive language-provider output',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspacePath);
      const fixtureName = '.vscode-mcp-completion-bound.txt';
      const fixturePath = join(workspacePath, fixtureName);
      const fixtureUri = vscode.Uri.file(fixturePath);
      await writeFile(fixturePath, 'completion fixture\n');
      const provider = vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', language: 'plaintext', pattern: `**/${fixtureName}` },
        {
          provideCompletionItems: () =>
            new vscode.CompletionList(
              Array.from({ length: 600 }, (_value, index) => {
                const item = new vscode.CompletionItem(`candidate-${index}`);
                item.documentation = new vscode.MarkdownString(
                  `${'x'.repeat(10_000)}](command:must-not-survive)`,
                );
                return item;
              }),
              true,
            ),
        },
      );
      const client = await startMcpClient(workspacePath);
      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const instance = await waitForSingleInstance(client);
        const response = await callTool(client, 'get_completions', {
          instanceId: requiredString(instance, 'instanceId'),
          document: { kind: 'uri', uri: fixtureUri.toString() },
          position: { line: 0, character: 0 },
          limit: 50,
        });
        assert.equal(
          recordProperty(response, 'isError'),
          undefined,
          JSON.stringify(response),
        );
        const structured = requiredRecord(response, 'structuredContent');
        assert.equal(structured['truncated'], true);
        assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') < 448 * 1024);
        assert.equal(
          JSON.stringify(response).includes('command:must-not-survive'),
          false,
        );
      } finally {
        client.close();
        provider.dispose();
        await vscode.commands.executeCommand('vscode-mcp.disable');
        await rm(fixturePath, { force: true });
      }
    },
  );

  testPosix(
    'rejects arbitrary authenticated IPC dispatch without invoking VS Code commands',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspacePath);
      const bridge = await startMcpClient(workspacePath);
      const commandId = 'vscode-mcp.host-test.mutation-canary';
      let commandInvocations = 0;
      const command = vscode.commands.registerCommand(commandId, () => {
        commandInvocations += 1;
      });
      let ipc: FramedJsonRpcClient | undefined;

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        ipc = await eventually(async () => {
          let candidate: FramedJsonRpcClient | undefined;
          try {
            const instance = await waitForSingleInstance(bridge);
            const instanceId = requiredString(instance, 'instanceId');
            const record = await readRegistryConnectionRecord(instanceId);
            candidate = await FramedJsonRpcClient.connect(record.endpointPath);
            const hello = await candidate.request('vscode-mcp/hello', {
              protocolVersion: record.protocolVersion,
              toolContractVersion: record.toolContractVersion,
              instanceId: record.instanceId,
              authToken: record.authToken,
              client: {
                name: 'vscode-mcp-bridge',
                version: record.toolContractVersion,
              },
            });
            if (isRecord(hello['result'])) return candidate;
          } catch {
            // A just-withdrawn listener is an expected lifecycle race. Rediscover.
          }
          candidate?.close();
          return null;
        });

        const arbitraryMethod = await ipc.request(commandId, {
          command: commandId,
          executable: '/bin/sh',
          action: 'save-and-reveal',
        });
        assertJsonRpcError(arbitraryMethod, -32_601);

        const arbitraryTool = await ipc.request('vscode-mcp/callTool', {
          tool: commandId,
          arguments: {
            command: commandId,
            executable: '/bin/sh',
            action: 'save-and-reveal',
          },
        });
        assertJsonRpcError(arbitraryTool, -32_602);
        assert.equal(commandInvocations, 0);

        const valid = await ipc.request('vscode-mcp/callTool', {
          tool: 'get_editor_context',
          arguments: {},
        });
        const validResult = requiredRecord(valid, 'result');
        assert.equal(validResult['outcome'], 'success');
        assert.equal(commandInvocations, 0);

        const close = await ipc.request('vscode-mcp/closeSession', {});
        assert.deepEqual(close['result'], { closed: true });
      } finally {
        ipc?.close();
        command.dispose();
        bridge.close();
        await vscode.commands.executeCommand('vscode-mcp.disable');
      }
    },
  );

  testPosix(
    'enforces workspace authority and filters inaccessible editor state',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspacePath);
      const externalDirectory = await mkdtemp(
        join(dirname(workspacePath), `${basename(workspacePath)}-prefix-trap-`),
      );
      const externalPath = join(externalDirectory, 'outside-secret.ts');
      const symlinkName = '.vscode-mcp-host-symlink-escape.ts';
      const symlinkPath = join(workspacePath, symlinkName);
      const externalCanary = 'VSCODE_MCP_EXTERNAL_CONTENT_CANARY';
      await writeFile(externalPath, `export const secret = '${externalCanary}';\n`);
      await rm(symlinkPath, { force: true });
      await symlink(externalPath, symlinkPath, 'file');

      const virtualScheme = 'vscode-mcp-host-test';
      const virtualUri = vscode.Uri.parse(`${virtualScheme}:/hidden-document`);
      const virtualProvider = vscode.workspace.registerTextDocumentContentProvider(
        virtualScheme,
        {
          provideTextDocumentContent: () => 'VSCODE_MCP_VIRTUAL_CONTENT_CANARY',
        },
      );
      let virtualHoverInvocations = 0;
      const virtualHoverProvider = vscode.languages.registerHoverProvider(
        { scheme: virtualScheme },
        {
          provideHover: () => {
            virtualHoverInvocations += 1;
            return new vscode.Hover('VSCODE_MCP_UNSUPPORTED_PROVIDER_CANARY');
          },
        },
      );
      const client = await startMcpClient(workspacePath);

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const instance = await waitForSingleInstance(client);
        const instanceId = requiredString(instance, 'instanceId');
        const folders = instance['workspaceFolders'];
        assert.ok(Array.isArray(folders));
        const folder = folders[0];
        assert.ok(isRecord(folder));
        const workspaceFolderId = requiredString(folder, 'workspaceFolderId');

        const fabricatedFolder = await callTool(client, 'read_document', {
          instanceId,
          document: {
            kind: 'workspacePath',
            workspaceFolderId: 'bridge-claimed-authority',
            relativePath: 'index.ts',
          },
        });
        assertToolFailure(fabricatedFolder, 'WORKSPACE_FOLDER_NOT_FOUND');

        const symlinkEscape = await callTool(client, 'read_document', {
          instanceId,
          document: {
            kind: 'workspacePath',
            workspaceFolderId,
            relativePath: symlinkName,
          },
        });
        assertToolFailure(symlinkEscape, 'DOCUMENT_OUTSIDE_WORKSPACE');

        const prefixTrap = await callTool(client, 'read_document', {
          instanceId,
          document: { kind: 'uri', uri: vscode.Uri.file(externalPath).toString() },
        });
        assertToolFailure(prefixTrap, 'DOCUMENT_OUTSIDE_WORKSPACE');
        const rejectedText = JSON.stringify([symlinkEscape, prefixTrap]);
        assert.equal(rejectedText.includes(externalCanary), false);
        assert.equal(rejectedText.includes(externalPath), false);

        const unsupportedUris = [
          'untitled:/host-test',
          'vscode-remote://ssh-remote+host-test/workspace/index.ts',
          'vscode-settings:/settings.json',
          'git:/repository/index.ts?ref=host-test',
          'vscode-notebook-cell:/notebook.ipynb#cell-1',
          'output:/host-test',
          'vscode-extension:/publisher.extension/file.ts',
          virtualUri.toString(),
        ];
        for (const uri of unsupportedUris) {
          const response = await callTool(client, 'get_hover', {
            instanceId,
            document: { kind: 'uri', uri },
            position: { line: 0, character: 0 },
          });
          assertToolFailure(response, 'UNSUPPORTED_URI_SCHEME');
        }
        assert.equal(virtualHoverInvocations, 0);

        const externalDocument = await vscode.workspace.openTextDocument(
          vscode.Uri.file(externalPath),
        );
        await vscode.window.showTextDocument(externalDocument, { preview: false });
        const virtualDocument = await vscode.workspace.openTextDocument(virtualUri);
        await vscode.window.showTextDocument(virtualDocument, { preview: false });

        const context = await callTool(client, 'get_editor_context', { instanceId });
        const contextStructured = requiredRecord(context, 'structuredContent');
        const contextResult = requiredRecord(contextStructured, 'result');
        assert.equal(contextResult['activeEditor'], null);
        const omitted = requiredRecord(contextResult, 'omitted');
        assert.ok(requiredNumber(omitted, 'editors') >= 1);
        assert.ok(requiredNumber(omitted, 'documents') >= 2);
        assert.ok(requiredNumber(omitted, 'tabs') >= 2);

        const contextText = JSON.stringify(context);
        assert.equal(contextText.includes(externalPath), false);
        assert.equal(contextText.includes(externalCanary), false);
        assert.equal(contextText.includes(virtualUri.toString()), false);
        assert.equal(contextText.includes('VSCODE_MCP_VIRTUAL_CONTENT_CANARY'), false);

        await closeTabsForUris([
          vscode.Uri.file(externalPath).toString(),
          virtualUri.toString(),
        ]);
      } finally {
        virtualHoverProvider.dispose();
        virtualProvider.dispose();
        client.close();
        await vscode.commands.executeCommand('vscode-mcp.disable');
        await closeTabsForUris([
          vscode.Uri.file(externalPath).toString(),
          virtualUri.toString(),
        ]);
        await rm(symlinkPath, { force: true });
        await rm(externalDirectory, { recursive: true, force: true });
      }
    },
  );

  testPosix(
    'discards stale provider results and withdraws active work on disable',
    async function () {
      this.timeout(60_000);
      await vscode.commands.executeCommand('vscode-mcp.disable');

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspacePath);
      const providerFixtureName = '.vscode-mcp-hover-provider-race.txt';
      const providerFixturePath = join(workspacePath, providerFixtureName);
      const providerUri = vscode.Uri.file(providerFixturePath);
      await writeFile(providerFixturePath, 'vscode-mcp provider race fixture\n');
      const document = await vscode.workspace.openTextDocument(providerUri);
      assert.equal(document.languageId, 'plaintext');
      const originalText = document.getText();
      const providerSelector: vscode.DocumentSelector = {
        scheme: 'file',
        language: 'plaintext',
        pattern: `**/${providerFixtureName}`,
      };
      const client = await startMcpClient(workspacePath);

      try {
        await vscode.commands.executeCommand('vscode-mcp.enable');
        const instance = await waitForSingleInstance(client);
        const instanceId = requiredString(instance, 'instanceId');

        const versionRace = deferredProvider('VSCODE_MCP_STALE_VERSION_CANARY');
        const versionProvider = vscode.languages.registerHoverProvider(
          providerSelector,
          { provideHover: versionRace.provideHover },
        );
        try {
          const request = callTool(client, 'get_hover', {
            instanceId,
            document: { kind: 'uri', uri: providerUri.toString() },
            position: { line: 0, character: 0 },
            expectedDocumentVersion: document.version,
          });
          await waitForProviderEntry(versionRace.entered, request);

          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            providerUri,
            document.positionAt(document.getText().length),
            '\n// vscode-mcp host version race',
          );
          assert.equal(await vscode.workspace.applyEdit(edit), true);

          versionRace.release();
          await withDeadline(versionRace.returned, 2_000, 'version provider return');
          const response = await withDeadline(request, 8_000, 'version-race response');
          assertToolFailure(response, 'DOCUMENT_CHANGED_DURING_REQUEST');
          assert.equal(
            JSON.stringify(response).includes('VSCODE_MCP_STALE_VERSION_CANARY'),
            false,
          );
        } finally {
          versionRace.release();
          versionProvider.dispose();
          await restoreDocument(document, originalText);
        }

        const disableRace = deferredProvider('VSCODE_MCP_DISABLED_RESULT_CANARY');
        const disableProvider = vscode.languages.registerHoverProvider(
          providerSelector,
          { provideHover: disableRace.provideHover },
        );
        try {
          const request = callTool(client, 'get_hover', {
            instanceId,
            document: { kind: 'uri', uri: providerUri.toString() },
            position: { line: 0, character: 0 },
            expectedDocumentVersion: document.version,
          });
          await waitForProviderEntry(disableRace.entered, request);

          const disable = vscode.commands.executeCommand('vscode-mcp.disable');
          await withDeadline(disable, 8_000, 'disable command');
          const response = await withDeadline(request, 8_000, 'disable-race response');
          assertToolFailure(response, 'INSTANCE_DISCONNECTED');
          assert.equal(
            JSON.stringify(response).includes('VSCODE_MCP_DISABLED_RESULT_CANARY'),
            false,
          );
          assert.equal(await registryRecordExists(instanceId), false);
          assert.deepEqual(
            instanceDescriptors(await callTool(client, 'list_instances', {})),
            [],
          );

          disableRace.release();
          await vscode.commands.executeCommand('vscode-mcp.enable');
          const restarted = await waitForSingleInstance(client);
          const restartedInstanceId = requiredString(restarted, 'instanceId');
          assert.notEqual(restartedInstanceId, instanceId);
          assert.equal(await registryRecordExists(restartedInstanceId), true);

          const folders = restarted['workspaceFolders'];
          assert.ok(Array.isArray(folders));
          const folder = folders[0];
          assert.ok(isRecord(folder));
          const read = await callTool(client, 'read_document', {
            instanceId: restartedInstanceId,
            document: {
              kind: 'workspacePath',
              workspaceFolderId: requiredString(folder, 'workspaceFolderId'),
              relativePath: 'index.ts',
            },
            lineCount: 1,
          });
          assert.equal(recordProperty(read, 'isError'), undefined);
        } finally {
          disableRace.release();
          disableProvider.dispose();
        }
      } finally {
        client.close();
        await vscode.commands.executeCommand('vscode-mcp.disable');
        await restoreDocument(document, originalText);
        await closeTabsForUris([providerUri.toString()]);
        await rm(providerFixturePath, { force: true });
      }
    },
  );
});

async function startMcpClient(workspacePath: string): Promise<JsonLineMcpClient> {
  const bridgePath =
    process.env['VSCODE_MCP_SERVER_PATH'] ??
    resolve(__dirname, '../../server/dist/cli.mjs');
  const bridge = spawn('node', [bridgePath], {
    cwd: workspacePath,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new JsonLineMcpClient(bridge);
  await once(bridge, 'spawn');
  const initialize = await client.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'vscode-mcp-integration-test', version: '1.0.0' },
  });
  assert.equal(recordProperty(initialize, 'protocolVersion'), '2025-11-25');
  const serverInfo = requiredRecord(initialize, 'serverInfo');
  assert.equal(serverInfo['name'], 'vscode-mcp');
  assert.equal(serverInfo['version'], '1.0.0');
  client.notify('notifications/initialized', {});
  return client;
}

function callTool(
  client: JsonLineMcpClient,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  return client.request('tools/call', { name, arguments: arguments_ });
}

async function readToolDocument(
  client: JsonLineMcpClient,
  instanceId: string,
  documentReference: Record<string, unknown>,
): Promise<{
  readonly result: Record<string, unknown>;
  readonly document: Record<string, unknown>;
}> {
  const response = await callTool(client, 'read_document', {
    instanceId,
    document: documentReference,
  });
  assert.equal(recordProperty(response, 'isError'), undefined);
  const result = requiredRecord(
    requiredRecord(response, 'structuredContent'),
    'result',
  );
  return { result, document: requiredRecord(result, 'document') };
}

function instanceDescriptors(response: unknown): unknown[] {
  const structured = requiredRecord(response, 'structuredContent');
  const result = requiredRecord(structured, 'result');
  const instances = result['instances'];
  assert.ok(Array.isArray(instances));
  return instances;
}

async function waitForSingleInstance(
  client: JsonLineMcpClient,
): Promise<Record<string, unknown>> {
  return eventually(async () => {
    const instances = instanceDescriptors(await callTool(client, 'list_instances', {}));
    const instance = instances.length === 1 ? instances[0] : undefined;
    if (!isRecord(instance)) {
      return null;
    }
    const capability = await callTool(client, 'get_capability_status', {
      instanceId: requiredString(instance, 'instanceId'),
    });
    return recordProperty(capability, 'isError') === true ? null : instance;
  });
}

function assertNoForbiddenInstanceMetadata(instance: Record<string, unknown>): void {
  const forbidden = new Set([
    'authToken',
    'canonicalPath',
    'endpoint',
    'pid',
    'registryPath',
    'workspaceFingerprint',
  ]);
  const pending: unknown[] = [instance];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false);
      pending.push(nested);
    }
  }
}

async function registryRecordExists(instanceId: string): Promise<boolean> {
  for (const directory of registryDirectories()) {
    try {
      await access(join(directory, `${instanceId}.json`));
      return true;
    } catch {
      // The extension may use the other accepted runtime-directory candidate.
    }
  }
  return false;
}

interface RegistryConnectionRecord {
  readonly instanceId: string;
  readonly protocolVersion: number;
  readonly toolContractVersion: string;
  readonly authToken: string;
  readonly endpointPath: string;
}

async function readRegistryConnectionRecord(
  instanceId: string,
): Promise<RegistryConnectionRecord> {
  for (const directory of registryDirectories()) {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(directory, `${instanceId}.json`), 'utf8'),
      );
      assert.ok(isRecord(parsed));
      assert.equal(parsed['instanceId'], instanceId);
      assert.ok(typeof parsed['protocolVersion'] === 'number');
      assert.ok(typeof parsed['toolContractVersion'] === 'string');
      assert.ok(typeof parsed['authToken'] === 'string');
      const endpoint = parsed['endpoint'];
      assert.ok(isRecord(endpoint));
      assert.equal(endpoint['kind'], 'unix');
      assert.ok(typeof endpoint['path'] === 'string');
      return {
        instanceId,
        protocolVersion: parsed['protocolVersion'],
        toolContractVersion: parsed['toolContractVersion'],
        authToken: parsed['authToken'],
        endpointPath: endpoint['path'],
      };
    } catch {
      // The extension may use the other accepted runtime-directory candidate.
    }
  }
  throw new Error('The extension-host registry record was not available.');
}

function registryDirectories(): string[] {
  const directories: string[] = [];
  const xdgRuntimeDirectory = process.env['XDG_RUNTIME_DIR'];
  if (xdgRuntimeDirectory !== undefined) {
    directories.push(join(xdgRuntimeDirectory, 'vscode-mcp', 'instances'));
  }
  if (typeof process.getuid === 'function') {
    directories.push(join(tmpdir(), `vscode-mcp-${process.getuid()}`, 'instances'));
  }
  return directories;
}

async function waitForWorkspaceFolder(
  uri: vscode.Uri,
  expectedPresent: boolean,
): Promise<void> {
  await eventually(async () => {
    const present = (vscode.workspace.workspaceFolders ?? []).some(
      (folder) => folder.uri.toString() === uri.toString(),
    );
    return present === expectedPresent ? true : null;
  });
}

async function removeWorkspaceFolder(uri: vscode.Uri): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const index = vscode.workspace.workspaceFolders?.findIndex(
      (folder) => folder.uri.toString() === uri.toString(),
    );
    if (index === undefined || index < 0) {
      return;
    }
    if (vscode.workspace.updateWorkspaceFolders(index, 1)) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('The extension host did not accept workspace-folder cleanup.');
}

function assertJsonRpcError(
  response: Record<string, unknown>,
  expectedCode: number,
): void {
  const error = requiredRecord(response, 'error');
  assert.equal(error['code'], expectedCode);
  assert.equal('result' in response, false);
}

function assertToolFailure(response: unknown, expectedCode: string): void {
  assert.equal(recordProperty(response, 'isError'), true);
  assert.equal(toolFailureCode(response), expectedCode);
}

function toolFailureCode(response: unknown): string {
  const structured = requiredRecord(response, 'structuredContent');
  const error = requiredRecord(structured, 'error');
  return requiredString(error, 'code');
}

async function closeTabsForUris(uris: readonly string[]): Promise<void> {
  const expected = new Set(uris);
  const tabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        expected.has(tab.input.uri.toString()),
    ),
  );
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

function deferredProvider(canary: string): {
  readonly entered: Promise<void>;
  readonly returned: Promise<void>;
  readonly provideHover: vscode.HoverProvider['provideHover'];
  readonly release: () => void;
} {
  let resolveEntered: (() => void) | undefined;
  let resolveReturned: (() => void) | undefined;
  let resolveRelease: (() => void) | undefined;
  const entered = new Promise<void>((resolveEnteredPromise) => {
    resolveEntered = resolveEnteredPromise;
  });
  const released = new Promise<void>((resolveReleasePromise) => {
    resolveRelease = resolveReleasePromise;
  });
  const returned = new Promise<void>((resolveReturnedPromise) => {
    resolveReturned = resolveReturnedPromise;
  });
  let didEnter = false;
  let didRelease = false;

  return {
    entered,
    returned,
    async provideHover() {
      if (!didEnter) {
        didEnter = true;
        resolveEntered?.();
      }
      await released;
      resolveReturned?.();
      return new vscode.Hover(new vscode.MarkdownString(canary));
    },
    release() {
      if (!didRelease) {
        didRelease = true;
        resolveRelease?.();
      }
    },
  };
}

async function restoreDocument(
  document: vscode.TextDocument,
  originalText: string,
): Promise<void> {
  if (document.getText() !== originalText) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      ),
      originalText,
    );
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  if (document.isDirty) {
    assert.equal(await document.save(), true);
  }
}

async function withDeadline<Value>(
  operation: PromiseLike<Value>,
  timeoutMs: number,
  label = 'operation',
): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`The extension-host ${label} exceeded its test deadline.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForProviderEntry(
  entered: Promise<void>,
  request: Promise<unknown>,
): Promise<void> {
  await withDeadline(
    Promise.race([
      entered,
      request.then((response) => {
        const outcome =
          recordProperty(response, 'isError') === true
            ? toolFailureCode(response)
            : 'SUCCESS';
        throw new Error(
          `The MCP request completed before the test provider ran (${outcome}).`,
        );
      }),
    ]),
    5_000,
  );
}

class JsonLineMcpClient {
  private nextId = 1;
  private pendingText = '';
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleData(chunk));
    child.once('exit', () => {
      for (const operation of this.pending.values()) {
        operation.reject(new Error('The MCP bridge exited before responding.'));
      }
      this.pending.clear();
    });
  }

  public request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return response;
  }

  public notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  public close(): void {
    this.child.stdin.end();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private write(message: object): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  private handleData(chunk: string): void {
    this.pendingText += chunk;
    while (true) {
      const lineEnd = this.pendingText.indexOf('\n');
      if (lineEnd < 0) {
        return;
      }
      const line = this.pendingText.slice(0, lineEnd).replace(/\r$/, '');
      this.pendingText = this.pendingText.slice(lineEnd + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed['id'] !== 'number') {
      return;
    }
    const operation = this.pending.get(parsed['id']);
    if (operation === undefined) {
      return;
    }
    this.pending.delete(parsed['id']);
    if ('error' in parsed) {
      operation.reject(new Error('The MCP bridge returned an error response.'));
    } else {
      operation.resolve(parsed['result']);
    }
  }
}

class FramedJsonRpcClient {
  private nextId = 0;
  private pendingBytes = Buffer.alloc(0);
  private expectedBodyBytes: number | undefined;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', () => {
      this.rejectPending('The extension-host IPC session failed.');
    });
    socket.on('close', () => {
      this.rejectPending('The extension-host IPC session closed before responding.');
    });
  }

  public static async connect(endpointPath: string): Promise<FramedJsonRpcClient> {
    const socket = createConnection(endpointPath);
    await once(socket, 'connect');
    return new FramedJsonRpcClient(socket);
  }

  public request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<Record<string, unknown>>(
      (resolveResponse, rejectResponse) => {
        this.pending.set(id, {
          resolve: resolveResponse,
          reject: rejectResponse,
        });
      },
    );
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      'utf8',
    );
    this.socket.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
        body,
      ]),
    );
    return response;
  }

  public close(): void {
    this.socket.destroy();
  }

  private handleData(chunk: Buffer): void {
    this.pendingBytes = Buffer.concat([this.pendingBytes, chunk]);
    while (true) {
      if (this.expectedBodyBytes === undefined) {
        const headerEnd = this.pendingBytes.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          return;
        }
        const header = this.pendingBytes.subarray(0, headerEnd).toString('ascii');
        const contentLength = /^Content-Length: ([0-9]+)$/m.exec(header)?.[1];
        if (contentLength === undefined) {
          this.rejectPending('The extension-host IPC response header was invalid.');
          this.close();
          return;
        }
        this.expectedBodyBytes = Number(contentLength);
        this.pendingBytes = this.pendingBytes.subarray(headerEnd + 4);
      }

      if (this.pendingBytes.byteLength < this.expectedBodyBytes) {
        return;
      }
      const body = this.pendingBytes.subarray(0, this.expectedBodyBytes);
      this.pendingBytes = this.pendingBytes.subarray(this.expectedBodyBytes);
      this.expectedBodyBytes = undefined;
      this.handleMessage(body);
    }
  }

  private handleMessage(body: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      this.rejectPending('The extension-host IPC response body was invalid.');
      this.close();
      return;
    }
    if (!isRecord(parsed) || typeof parsed['id'] !== 'number') {
      return;
    }
    const operation = this.pending.get(parsed['id']);
    if (operation === undefined) {
      return;
    }
    this.pending.delete(parsed['id']);
    operation.resolve(parsed);
  }

  private rejectPending(message: string): void {
    for (const operation of this.pending.values()) {
      operation.reject(new Error(message));
    }
    this.pending.clear();
  }
}

async function eventually<Value>(
  operation: () => Promise<Value | null>,
): Promise<Value> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== null) {
      return value;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('The expected MCP result was not available before the deadline.');
}

function requiredRecord(value: unknown, property: string): Record<string, unknown> {
  const propertyValue = isRecord(value) ? value[property] : undefined;
  assert.ok(isRecord(propertyValue));
  return propertyValue;
}

function recordProperty(value: unknown, property: string): unknown {
  return isRecord(value) ? value[property] : undefined;
}

function requiredString(value: Record<string, unknown>, property: string): string {
  const propertyValue = value[property];
  assert.ok(typeof propertyValue === 'string');
  return propertyValue;
}

function requiredNumber(value: Record<string, unknown>, property: string): number {
  const propertyValue = value[property];
  assert.ok(typeof propertyValue === 'number');
  return propertyValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
