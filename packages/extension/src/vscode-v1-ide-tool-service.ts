import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  copyFile,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import {
  V1AdditionalToolInvocationSchema,
  V1AdditionalToolResultSchema,
  V1_ADDITIONAL_TOOL_NAMES,
  V1_IDE_TOOL_LIMITS,
  type DocumentRef,
  type ErrorCode,
  type V1AdditionalIpcResult,
  type V1AdditionalToolInvocation,
  type V1AdditionalToolName,
} from '@vscode-mcp/protocol';
import * as vscode from 'vscode';

import type {
  CapabilityGrantController,
  CapabilityGrantToken,
} from './capability-grant-controller.js';
import {
  createWorkspaceIdentity,
  type WorkspaceIdentity,
} from './workspace-identity.js';
import { SingleUseHandleStore } from './single-use-handle-store.js';
import type {
  VisualChangeController,
  PreparedVisualChange,
} from './visual-change-controller.js';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface ToolDispatchResult {
  readonly result: Json;
  readonly truncated: boolean;
  readonly omittedCount: number;
}

interface ServiceOptions {
  readonly grants: CapabilityGrantController;
  readonly isWorkspaceEnabled: (fingerprint: string) => boolean | PromiseLike<boolean>;
  readonly visualChanges: VisualChangeController;
}

interface Access {
  readonly identity: WorkspaceIdentity;
  readonly folders: readonly vscode.WorkspaceFolder[];
}

interface TrackedTask {
  readonly execution: vscode.TaskExecution;
  readonly startedAt: string;
  state: 'running' | 'ended' | 'terminated';
  exitCode: number | null;
  endedAt: string | null;
  timer: ReturnType<typeof setTimeout>;
}

interface TrackedDebug {
  readonly id: string;
  readonly folderUri: string;
  readonly allowUnscopedSession: boolean;
  name: string;
  type: string;
  readonly startedAt: string;
  state: 'running' | 'stopped';
  endedAt: string | null;
  session?: vscode.DebugSession;
}

interface CodeActionPreview {
  readonly edit: vscode.WorkspaceEdit;
  readonly documents: readonly vscode.TextDocument[];
  readonly versions: readonly number[];
}

interface PreparedWorkspaceEdit {
  readonly edit: vscode.WorkspaceEdit;
  readonly documents: readonly vscode.TextDocument[];
  readonly versions: readonly number[];
}

export class VsCodeV1IdeToolService implements vscode.Disposable {
  readonly #grants: CapabilityGrantController;
  readonly #isWorkspaceEnabled: ServiceOptions['isWorkspaceEnabled'];
  readonly #visualChanges: VisualChangeController;
  readonly #disposables: vscode.Disposable[] = [];
  readonly #taskIds = new Map<string, string>();
  readonly #tasks = new Map<string, TrackedTask>();
  readonly #debug = new Map<string, TrackedDebug>();
  readonly #previews = new SingleUseHandleStore<CodeActionPreview>({
    maximumHandles: V1_IDE_TOOL_LIMITS.previewHandles,
    lifetimeMs: V1_IDE_TOOL_LIMITS.previewLifetimeMs,
    createToken: randomUUID,
  });

  public constructor(options: ServiceOptions) {
    this.#grants = options.grants;
    this.#isWorkspaceEnabled = options.isWorkspaceEnabled;
    this.#visualChanges = options.visualChanges;
    this.#disposables.push(
      vscode.tasks.onDidEndTaskProcess((event) => {
        for (const tracked of this.#tasks.values()) {
          if (tracked.execution === event.execution) {
            if (tracked.state !== 'terminated') tracked.state = 'ended';
            tracked.exitCode = event.exitCode ?? null;
            tracked.endedAt = new Date().toISOString();
            clearTimeout(tracked.timer);
          }
        }
      }),
      vscode.debug.onDidStartDebugSession((session) => {
        for (const tracked of this.#debug.values()) {
          if (
            tracked.session === undefined &&
            tracked.state === 'running' &&
            debugSessionMatches(tracked, session)
          ) {
            tracked.session = session;
            tracked.type = session.type;
            break;
          }
        }
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        for (const tracked of this.#debug.values()) {
          if (tracked.session?.id === session.id) {
            tracked.state = 'stopped';
            tracked.endedAt = new Date().toISOString();
          }
        }
      }),
    );
  }

  public dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
    for (const tracked of this.#tasks.values()) {
      clearTimeout(tracked.timer);
      tracked.execution.terminate();
    }
    for (const tracked of this.#debug.values()) {
      if (tracked.session !== undefined)
        void vscode.debug.stopDebugging(tracked.session);
    }
    this.#tasks.clear();
    this.#debug.clear();
    this.#previews.clear();
    this.#taskIds.clear();
  }

  public handleCapabilityRevoked(capability: 'write' | 'execution'): void {
    if (capability === 'write') {
      this.#previews.clear();
      return;
    }
    for (const tracked of this.#tasks.values()) {
      if (tracked.state === 'running') {
        tracked.execution.terminate();
        tracked.state = 'terminated';
        tracked.endedAt = new Date().toISOString();
      }
      clearTimeout(tracked.timer);
    }
    for (const tracked of this.#debug.values()) {
      if (tracked.state === 'running' && tracked.session !== undefined) {
        void vscode.debug.stopDebugging(tracked.session);
      }
      tracked.state = 'stopped';
      tracked.endedAt = new Date().toISOString();
    }
  }

  public async callTool(
    untrusted: unknown,
    signal: AbortSignal,
  ): Promise<V1AdditionalIpcResult> {
    const parsed = V1AdditionalToolInvocationSchema.safeParse(untrusted);
    if (!parsed.success) {
      const name = recognizedName(untrusted);
      if (name === null) throw new Error('The 1.0 IDE invocation is not recognized.');
      return failure(name, 'INVALID_ARGUMENT', 'The tool arguments are invalid.');
    }
    try {
      if (signal.aborted)
        throw new IdeToolError('CANCELLED', 'The request was cancelled.', true);
      const access = await currentAccess(this.#isWorkspaceEnabled);
      const dispatched = await this.dispatch(parsed.data, access, signal);
      const envelope = isDispatchResult(dispatched)
        ? dispatched
        : { result: dispatched, truncated: false, omittedCount: 0 };
      return V1AdditionalToolResultSchema.parse({
        outcome: 'success',
        tool: parsed.data.tool,
        observedAt: new Date().toISOString(),
        truncated: envelope.truncated,
        warnings: envelope.truncated
          ? [
              {
                code: 'RESULTS_TRUNCATED',
                message: 'Provider results were reduced to the 1.0 output limits.',
                omittedCount: envelope.omittedCount,
              },
            ]
          : [],
        result: envelope.result,
      });
    } catch (error) {
      if (signal.aborted)
        return failure(
          parsed.data.tool,
          'CANCELLED',
          'The request was cancelled.',
          true,
        );
      if (error instanceof IdeToolError) {
        return failure(parsed.data.tool, error.code, error.message, error.retryable);
      }
      return failure(
        parsed.data.tool,
        'INTERNAL_ERROR',
        'The IDE operation failed internally.',
      );
    }
  }

  private async dispatch(
    invocation: V1AdditionalToolInvocation,
    access: Access,
    signal: AbortSignal,
  ): Promise<Json | ToolDispatchResult> {
    switch (invocation.tool) {
      case 'get_capability_status':
        return this.capabilityStatus();
      case 'get_completions':
      case 'get_code_actions':
      case 'get_document_highlights':
      case 'get_type_hierarchy':
      case 'get_inlay_hints':
      case 'get_folding_ranges':
      case 'get_selection_ranges':
      case 'get_document_links':
        return this.languageTool(invocation, access, signal);
      case 'apply_text_edits':
        return this.applyRequestedEdits(invocation.arguments, access, signal);
      case 'create_workspace_file':
        return this.createFile(invocation.arguments, access);
      case 'move_workspace_file':
        return this.moveFile(invocation.arguments, access);
      case 'delete_workspace_file':
        return this.deleteFile(invocation.arguments, access);
      case 'save_documents':
        return this.saveDocuments(invocation.arguments, access, false);
      case 'revert_documents':
        return this.saveDocuments(invocation.arguments, access, true);
      case 'rename_symbol':
        return this.renameSymbol(invocation.arguments, access, signal);
      case 'format_document':
        return this.formatDocument(invocation.arguments, access, signal);
      case 'apply_code_action':
        return this.applyCodeAction(invocation.arguments.previewToken, access, signal);
      case 'list_tasks':
        return this.listTasks(access);
      case 'run_task':
        return this.runTask(invocation.arguments.taskId, access);
      case 'get_task_execution':
        return this.taskExecution(invocation.arguments.executionId, access);
      case 'terminate_task':
        return this.terminateTask(invocation.arguments.executionId);
      case 'get_debug_state':
        return this.debugState(access);
      case 'start_debugging':
        return this.startDebugging(invocation.arguments, access);
      case 'stop_debugging':
        return this.stopDebugging(invocation.arguments.debugSessionId);
    }
  }

  private capabilityStatus(): Json {
    const state = this.#grants.snapshot();
    return {
      read: true,
      write: state.write,
      execution: state.execution,
      writeGeneration: state.writeGeneration,
      executionGeneration: state.executionGeneration,
    };
  }

  private async languageTool(
    invocation: Extract<
      V1AdditionalToolInvocation,
      {
        tool:
          | 'get_completions'
          | 'get_code_actions'
          | 'get_document_highlights'
          | 'get_type_hierarchy'
          | 'get_inlay_hints'
          | 'get_folding_ranges'
          | 'get_selection_ranges'
          | 'get_document_links';
      }
    >,
    access: Access,
    signal: AbortSignal,
  ): Promise<ToolDispatchResult> {
    const document = await openAuthorizedDocument(
      invocation.arguments.document,
      access,
    );
    checkVersion(document, invocation.arguments.expectedDocumentVersion);
    const version = document.version;
    const uri = document.uri;
    let value: unknown;
    switch (invocation.tool) {
      case 'get_completions':
        value = await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          uri,
          position(invocation.arguments.position),
          undefined,
          Math.min(
            invocation.arguments.limit ?? V1_IDE_TOOL_LIMITS.completions,
            V1_IDE_TOOL_LIMITS.completions,
          ),
        );
        break;
      case 'get_code_actions':
        value = await vscode.commands.executeCommand<
          (vscode.CodeAction | vscode.Command)[]
        >(
          'vscode.executeCodeActionProvider',
          uri,
          range(invocation.arguments.range),
          invocation.arguments.kinds?.[0],
          invocation.arguments.limit ?? V1_IDE_TOOL_LIMITS.codeActions,
        );
        break;
      case 'get_document_highlights':
        value = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
          'vscode.executeDocumentHighlights',
          uri,
          position(invocation.arguments.position),
        );
        break;
      case 'get_type_hierarchy': {
        const roots =
          (await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
            'vscode.prepareTypeHierarchy',
            uri,
            position(invocation.arguments.position),
          )) ?? [];
        const root = roots[0];
        const supertypes =
          root === undefined || invocation.arguments.direction === 'subtypes'
            ? []
            : ((await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
                'vscode.provideSupertypes',
                root,
              )) ?? []);
        const subtypes =
          root === undefined || invocation.arguments.direction === 'supertypes'
            ? []
            : ((await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
                'vscode.provideSubtypes',
                root,
              )) ?? []);
        value = { roots, supertypes, subtypes };
        break;
      }
      case 'get_inlay_hints':
        value = await vscode.commands.executeCommand<vscode.InlayHint[]>(
          'vscode.executeInlayHintProvider',
          uri,
          range(invocation.arguments.range),
        );
        break;
      case 'get_folding_ranges':
        value = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
          'vscode.executeFoldingRangeProvider',
          uri,
        );
        break;
      case 'get_selection_ranges':
        value = await vscode.commands.executeCommand<vscode.SelectionRange[]>(
          'vscode.executeSelectionRangeProvider',
          uri,
          invocation.arguments.positions.map(position),
        );
        break;
      case 'get_document_links':
        value = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
          'vscode.executeLinkProvider',
          uri,
        );
        break;
    }
    if (signal.aborted)
      throw new IdeToolError('CANCELLED', 'The request was cancelled.', true);
    checkVersion(document, version);
    if (invocation.tool === 'get_code_actions') {
      return this.normalizeCodeActions(value, access, version);
    }
    let selectedValue = value;
    let preOmitted = 0;
    if (
      invocation.tool === 'get_completions' &&
      value instanceof vscode.CompletionList
    ) {
      const limit = Math.min(
        invocation.arguments.limit ?? V1_IDE_TOOL_LIMITS.completions,
        V1_IDE_TOOL_LIMITS.completions,
      );
      selectedValue = {
        isIncomplete: value.isIncomplete,
        items: value.items.slice(0, limit),
      };
      preOmitted = Math.max(0, value.items.length - limit);
    } else if (
      invocation.tool === 'get_type_hierarchy' &&
      typeof value === 'object' &&
      value !== null &&
      'roots' in value &&
      'supertypes' in value &&
      'subtypes' in value
    ) {
      const limit = invocation.arguments.limit ?? V1_IDE_TOOL_LIMITS.providerItems;
      const roots = Array.isArray(value.roots) ? value.roots : [];
      const supertypes = Array.isArray(value.supertypes) ? value.supertypes : [];
      const subtypes = Array.isArray(value.subtypes) ? value.subtypes : [];
      selectedValue = {
        roots: roots.slice(0, limit),
        supertypes: supertypes.slice(0, limit),
        subtypes: subtypes.slice(0, limit),
      };
      preOmitted =
        Math.max(0, roots.length - limit) +
        Math.max(0, supertypes.length - limit) +
        Math.max(0, subtypes.length - limit);
    } else if (Array.isArray(value)) {
      const requestedLimit =
        'limit' in invocation.arguments &&
        typeof invocation.arguments.limit === 'number'
          ? invocation.arguments.limit
          : V1_IDE_TOOL_LIMITS.providerItems;
      selectedValue = value.slice(0, requestedLimit);
      preOmitted = Math.max(0, value.length - requestedLimit);
    }
    const normalized = normalizeProviderValue(selectedValue, access);
    const omittedCount = preOmitted + normalized.omittedCount;
    return {
      result: {
        document: documentIdentity(document, access),
        items: normalized.value,
      },
      truncated: omittedCount > 0,
      omittedCount,
    };
  }

  private async normalizeCodeActions(
    value: unknown,
    access: Access,
    version: number,
  ): Promise<ToolDispatchResult> {
    const sourceActions = Array.isArray(value) ? value : [];
    const actions = sourceActions.slice(0, V1_IDE_TOOL_LIMITS.codeActions);
    const result: Json[] = [];
    let previewBudget = 128 * 1024;
    for (const candidate of actions) {
      if (!(candidate instanceof vscode.CodeAction)) continue;
      let previewToken: string | null = null;
      let preview: Json = null;
      if (candidate.command === undefined && candidate.edit !== undefined) {
        const safeEdit = await prepareTextOnlyWorkspaceEdit(candidate.edit, access);
        if (safeEdit !== null) {
          const grant = this.#grants.capture('write');
          if (grant !== null) {
            previewToken = this.#previews.create(
              {
                edit: safeEdit.edit,
                documents: safeEdit.documents,
                versions: safeEdit.versions,
              },
              grant.generation,
              access.identity.fingerprint,
            );
            if (previewToken !== null) {
              const summarized = summarizeWorkspaceEdit(
                safeEdit.edit,
                access,
                previewBudget,
              );
              preview = summarized.value;
              previewBudget -= summarized.usedBytes;
            }
          }
        }
      }
      result.push({
        title: candidate.title.slice(0, 512),
        kind: candidate.kind?.value ?? null,
        preferred: candidate.isPreferred ?? false,
        disabledReason: candidate.disabled?.reason?.slice(0, 1_024) ?? null,
        previewToken,
        preview,
        documentVersion: version,
      });
    }
    return {
      result: { actions: result },
      truncated: sourceActions.length > actions.length,
      omittedCount: Math.max(0, sourceActions.length - actions.length),
    };
  }

  private async applyRequestedEdits(
    args: Extract<
      V1AdditionalToolInvocation,
      { tool: 'apply_text_edits' }
    >['arguments'],
    access: Access,
    signal: AbortSignal,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'write');
    const edit = new vscode.WorkspaceEdit();
    const documents: vscode.TextDocument[] = [];
    for (const group of args.documents) {
      const document = await openAuthorizedDocument(group.document, access);
      checkVersion(document, group.expectedDocumentVersion);
      validateEdits(document, group.edits);
      edit.set(
        document.uri,
        group.edits.map((item) => new vscode.TextEdit(range(item.range), item.newText)),
      );
      documents.push(document);
    }
    await ensureEditorTabs(documents);
    const visual = this.#visualChanges.prepareWorkspaceEdit(
      'apply_text_edits',
      edit,
      documents,
    );
    finalWriteCheck(
      this.#grants,
      grant,
      documents,
      args.documents.map((group) => group.expectedDocumentVersion),
      signal,
    );
    const applied = await this.applyEditWithVisual(edit, visual);
    if (!applied)
      throw new IdeToolError(
        'EDIT_CONFLICT',
        'VS Code rejected the text edit transaction.',
      );
    return {
      applied: true,
      documents: documents.map((document, index) => ({
        document: documentIdentity(document, access),
        versionBefore: args.documents[index]?.expectedDocumentVersion ?? null,
        versionAfter: document.version,
        editCount: args.documents[index]?.edits.length ?? 0,
        isDirty: document.isDirty,
      })),
    };
  }

  private async createFile(
    args: Extract<
      V1AdditionalToolInvocation,
      { tool: 'create_workspace_file' }
    >['arguments'],
    access: Access,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'write');
    const destination = await resolveNewPath(args.destination, access);
    if (!this.#grants.isCurrent(grant)) throw grantChanged('write');
    let handle;
    try {
      handle = await open(destination.path, 'wx', 0o600);
    } catch (error) {
      if (isNodeCode(error, 'EEXIST'))
        throw new IdeToolError(
          'FILE_ALREADY_EXISTS',
          'The destination already exists.',
        );
      throw error;
    }
    try {
      await handle.writeFile(args.content, 'utf8');
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(destination.path).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await this.recordCreatedFile(destination.path);
    return { created: args.destination };
  }

  private async moveFile(
    args: Extract<
      V1AdditionalToolInvocation,
      { tool: 'move_workspace_file' }
    >['arguments'],
    access: Access,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'write');
    const source = await existingRegularPath(args.source, access);
    const destination = await resolveNewPath(args.destination, access);
    if (source.folderId !== destination.folderId)
      throw new IdeToolError(
        'DOCUMENT_OUTSIDE_WORKSPACE',
        'Source and destination must use the same workspace root.',
      );
    const visualBefore = await readVisualSnapshot(source.path);
    if (!this.#grants.isCurrent(grant)) throw grantChanged('write');
    try {
      await copyFile(source.path, destination.path, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (isNodeCode(error, 'EEXIST')) {
        throw new IdeToolError(
          'FILE_ALREADY_EXISTS',
          'The destination already exists.',
        );
      }
      throw error;
    }
    try {
      await unlink(source.path);
    } catch (error) {
      await unlink(destination.path).catch(() => undefined);
      throw error;
    }
    await this.recordMovedFile(source.path, destination.path, visualBefore);
    return { moved: true, destination: args.destination };
  }

  private async deleteFile(
    args: Extract<
      V1AdditionalToolInvocation,
      { tool: 'delete_workspace_file' }
    >['arguments'],
    access: Access,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'write');
    const source = await existingRegularPath(args.document, access);
    const visualBefore = await readVisualSnapshot(source.path);
    if (!this.#grants.isCurrent(grant)) throw grantChanged('write');
    await unlink(source.path);
    this.recordFileOperation(
      'delete_workspace_file',
      vscode.Uri.file(source.path),
      'deleted',
      visualBefore,
    );
    return {
      deleted: true,
      document: {
        workspaceFolderId: source.folderId,
        relativePath: source.relativePath,
      },
    };
  }

  private async saveDocuments(
    args: Extract<
      V1AdditionalToolInvocation,
      { tool: 'save_documents' | 'revert_documents' }
    >['arguments'],
    access: Access,
    revert: boolean,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'write');
    const documents: vscode.TextDocument[] = [];
    for (const item of args.documents) {
      const document = await openAuthorizedDocument(item.document, access);
      checkVersion(document, item.expectedDocumentVersion);
      documents.push(document);
    }
    if (!this.#grants.isCurrent(grant)) throw grantChanged('write');
    if (revert) {
      await this.revertDocumentsToDisk(
        documents,
        args.documents.map((item) => item.expectedDocumentVersion),
        grant,
      );
      return {
        affected: documents.map((document) => documentIdentity(document, access)),
        operation: 'revert',
      };
    }
    for (const [index, document] of documents.entries()) {
      if (!this.#grants.isCurrent(grant)) throw grantChanged('write');
      checkVersion(document, args.documents[index]?.expectedDocumentVersion);
      if (!(await document.save())) {
        throw new IdeToolError('EDIT_CONFLICT', 'VS Code could not save a document.');
      }
    }
    return {
      affected: documents.map((document) => documentIdentity(document, access)),
      operation: 'save',
    };
  }

  private async revertDocumentsToDisk(
    documents: readonly vscode.TextDocument[],
    expectedVersions: readonly number[],
    grant: CapabilityGrantToken,
  ): Promise<void> {
    const snapshots: DiskSnapshot[] = [];
    for (const document of documents) {
      snapshots.push(await readDiskSnapshot(document.uri.fsPath));
    }
    for (const [index, document] of documents.entries()) {
      const snapshot = snapshots[index];
      if (snapshot === undefined)
        throw new IdeToolError('INTERNAL_ERROR', 'A revert snapshot is missing.');
      const current = await lstat(document.uri.fsPath);
      if (!sameFileSnapshot(current, snapshot)) {
        throw new IdeToolError(
          'DOCUMENT_CHANGED_DURING_REQUEST',
          'A saved file changed before the revert commit.',
          true,
        );
      }
    }
    if (!this.#grants.isCurrent(grant)) throw grantChanged('write');
    documents.forEach((document, index) =>
      checkVersion(document, expectedVersions[index]),
    );
    const edit = new vscode.WorkspaceEdit();
    documents.forEach((document, index) => {
      const snapshot = snapshots[index];
      if (snapshot !== undefined) {
        edit.replace(
          document.uri,
          new vscode.Range(
            new vscode.Position(0, 0),
            document.positionAt(document.getText().length),
          ),
          snapshot.text,
        );
      }
    });
    const visual = this.#visualChanges.prepareWorkspaceEdit(
      'revert_documents',
      edit,
      documents,
    );
    if (!(await this.applyEditWithVisual(edit, visual))) {
      throw new IdeToolError('EDIT_CONFLICT', 'VS Code rejected the revert edit.');
    }
    for (const document of documents) {
      if (!(await document.save())) {
        throw new IdeToolError(
          'EDIT_CONFLICT',
          'VS Code could not finalize the revert.',
        );
      }
    }
  }

  private async renameSymbol(
    args: Extract<V1AdditionalToolInvocation, { tool: 'rename_symbol' }>['arguments'],
    access: Access,
    signal: AbortSignal,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'write');
    const document = await openAuthorizedDocument(args.document, access);
    checkVersion(document, args.expectedDocumentVersion);
    const provider = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider',
      document.uri,
      position(args.position),
      args.newName,
    );
    if (provider === undefined)
      throw new IdeToolError('PROVIDER_UNAVAILABLE', 'No rename result was available.');
    const prepared = await prepareTextOnlyWorkspaceEdit(provider, access);
    if (prepared === null)
      throw new IdeToolError(
        'OPAQUE_PROVIDER_EDIT',
        'The rename result could not be represented as authorized text edits.',
      );
    const originalIndex = prepared.documents.findIndex(
      (item) => item.uri.toString() === document.uri.toString(),
    );
    if (
      originalIndex < 0 ||
      prepared.versions[originalIndex] !== args.expectedDocumentVersion
    )
      throw new IdeToolError(
        'DOCUMENT_CHANGED_DURING_REQUEST',
        'The rename source changed during provider preparation.',
        true,
      );
    await ensureEditorTabs(prepared.documents);
    const visual = this.#visualChanges.prepareWorkspaceEdit(
      'rename_symbol',
      prepared.edit,
      prepared.documents,
    );
    finalWriteCheck(this.#grants, grant, prepared.documents, prepared.versions, signal);
    if (!(await this.applyEditWithVisual(prepared.edit, visual)))
      throw new IdeToolError('EDIT_CONFLICT', 'VS Code rejected the rename edits.');
    return { renamed: true, document: documentIdentity(document, access) };
  }

  private async formatDocument(
    args: Extract<V1AdditionalToolInvocation, { tool: 'format_document' }>['arguments'],
    access: Access,
    signal: AbortSignal,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'write');
    const document = await openAuthorizedDocument(args.document, access);
    checkVersion(document, args.expectedDocumentVersion);
    const editorConfig = vscode.workspace.getConfiguration('editor', document.uri);
    const configuredTabSize = editorConfig.get<number>('tabSize');
    const configuredInsertSpaces = editorConfig.get<boolean>('insertSpaces');
    const options = args.options ?? {
      tabSize:
        configuredTabSize !== undefined &&
        Number.isInteger(configuredTabSize) &&
        configuredTabSize > 0 &&
        configuredTabSize <= 32
          ? configuredTabSize
          : 4,
      insertSpaces: configuredInsertSpaces ?? true,
    };
    const edits =
      args.range === undefined
        ? await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatDocumentProvider',
            document.uri,
            options,
          )
        : await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatRangeProvider',
            document.uri,
            range(args.range),
            options,
          );
    const requested = edits ?? [];
    validateEdits(
      document,
      requested.map((edit) => ({
        range: plainRange(edit.range),
        newText: edit.newText,
      })),
    );
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(document.uri, requested);
    await ensureEditorTabs([document]);
    const visual = this.#visualChanges.prepareWorkspaceEdit(
      'format_document',
      workspaceEdit,
      [document],
    );
    finalWriteCheck(
      this.#grants,
      grant,
      [document],
      [args.expectedDocumentVersion],
      signal,
    );
    if (!(await this.applyEditWithVisual(workspaceEdit, visual)))
      throw new IdeToolError('EDIT_CONFLICT', 'VS Code rejected the formatting edits.');
    return {
      formatted: true,
      editCount: requested.length,
      document: documentIdentity(document, access),
    };
  }

  private async applyCodeAction(
    token: string,
    access: Access,
    signal: AbortSignal,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'write');
    const taken = this.#previews.take(
      token,
      grant.generation,
      access.identity.fingerprint,
    );
    if (taken.status !== 'ok') {
      if (taken.status === 'missing')
        throw new IdeToolError(
          'PREVIEW_ALREADY_USED',
          'The preview token is unknown or already used.',
        );
      if (taken.status === 'expired')
        throw new IdeToolError('PREVIEW_EXPIRED', 'The preview token expired.');
      throw grantChanged('write');
    }
    const preview = taken.value;
    await ensureEditorTabs(preview.documents);
    const visual = this.#visualChanges.prepareWorkspaceEdit(
      'apply_code_action',
      preview.edit,
      preview.documents,
    );
    finalWriteCheck(this.#grants, grant, preview.documents, preview.versions, signal);
    if (!(await this.applyEditWithVisual(preview.edit, visual)))
      throw new IdeToolError(
        'EDIT_CONFLICT',
        'VS Code rejected the code action edits.',
      );
    return { applied: true, workspace: access.identity.fingerprint.slice(0, 16) };
  }

  private commitVisual(prepared: PreparedVisualChange): void {
    try {
      this.#visualChanges.commitPrepared(prepared);
    } catch {
      // Visual attribution is best-effort UI and cannot change a committed mutation's
      // public success/failure semantics.
    }
  }

  private async applyEditWithVisual(
    edit: vscode.WorkspaceEdit,
    visual: PreparedVisualChange,
  ): Promise<boolean> {
    try {
      this.#visualChanges.armPrepared(visual);
    } catch {
      // Visual attribution is best-effort and cannot prevent the mutation commit.
    }
    let applied = false;
    try {
      applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
    } finally {
      if (!applied) {
        try {
          this.#visualChanges.cancelPrepared(visual);
        } catch {
          // Visual cleanup cannot replace the original mutation outcome.
        }
      }
    }
    if (applied) this.commitVisual(visual);
    return applied;
  }

  private async recordCreatedFile(path: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: true,
      });
      this.#visualChanges.recordWholeDocument(
        'create_workspace_file',
        document,
        'created',
      );
    } catch {
      // The file operation already committed; visual attribution is best-effort.
    }
  }

  private async recordMovedFile(
    sourcePath: string,
    destinationPath: string,
    beforeText?: string,
  ): Promise<void> {
    try {
      const uri = vscode.Uri.file(destinationPath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: true,
      });
      this.#visualChanges.recordMove(vscode.Uri.file(sourcePath), uri, beforeText);
    } catch {
      // The file operation already committed; visual attribution is best-effort.
    }
  }

  private recordFileOperation(
    tool: 'move_workspace_file' | 'delete_workspace_file',
    uri: vscode.Uri,
    kind: 'moved' | 'deleted',
    beforeText?: string,
  ): void {
    try {
      this.#visualChanges.recordFileOperation(tool, uri, kind, beforeText);
    } catch {
      // The file operation already committed; visual attribution is best-effort.
    }
  }

  private async listTasks(access: Access): Promise<ToolDispatchResult> {
    this.#taskIds.clear();
    const candidates = (await vscode.tasks.fetchTasks()).filter((task) =>
      taskInAccess(task, access),
    );
    const tasks = candidates.slice(0, V1_IDE_TOOL_LIMITS.listedTasks);
    return {
      result: {
        tasks: tasks.map((task) => {
          const fingerprint = taskFingerprint(task);
          const id = randomUUID();
          this.#taskIds.set(id, fingerprint);
          return {
            id,
            name: task.name.slice(0, 512),
            source: task.source.slice(0, 512),
            runner: safeTaskRunner(task),
            group: task.group?.id ?? null,
            background: task.isBackground,
            problemMatcherCount: task.problemMatchers.length,
          };
        }),
      },
      truncated: candidates.length > tasks.length,
      omittedCount: candidates.length - tasks.length,
    };
  }

  private async runTask(taskId: string, access: Access): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'execution');
    const activeTasks = [...this.#tasks.values()].filter(
      (task) => task.state === 'running',
    ).length;
    if (activeTasks >= V1_IDE_TOOL_LIMITS.trackedTasks)
      throw new IdeToolError(
        'TASK_LIMIT_REACHED',
        'The tracked task limit was reached.',
      );
    const fingerprint = this.#taskIds.get(taskId);
    if (fingerprint === undefined)
      throw new IdeToolError('TASK_NOT_FOUND', 'The task ID is unknown.');
    const matches = (await vscode.tasks.fetchTasks()).filter(
      (task) => taskInAccess(task, access) && taskFingerprint(task) === fingerprint,
    );
    if (matches.length === 0)
      throw new IdeToolError('TASK_NOT_FOUND', 'The task no longer exists.');
    if (matches.length > 1)
      throw new IdeToolError(
        'TASK_AMBIGUOUS',
        'The task is no longer uniquely identifiable.',
      );
    if (!this.#grants.isCurrent(grant)) throw grantChanged('execution');
    const execution = await vscode.tasks.executeTask(matches[0]!);
    const executionId = randomUUID();
    const timer = setTimeout(() => {
      execution.terminate();
      const tracked = this.#tasks.get(executionId);
      if (tracked !== undefined) tracked.state = 'terminated';
    }, V1_IDE_TOOL_LIMITS.taskLifetimeMs);
    this.#tasks.set(executionId, {
      execution,
      startedAt: new Date().toISOString(),
      state: 'running',
      exitCode: null,
      endedAt: null,
      timer,
    });
    return { executionId, state: 'running' };
  }

  private taskExecution(executionId: string, access: Access): Json {
    const tracked = this.#tasks.get(executionId);
    if (tracked === undefined)
      throw new IdeToolError('EXECUTION_NOT_FOUND', 'The task execution is unknown.');
    const diagnostics = vscode.languages
      .getDiagnostics()
      .filter(([uri]) => uriInAccess(uri, access))
      .flatMap(([uri, entries]) =>
        entries.slice(0, 200).map((diagnostic) => ({
          document: workspaceUri(uri, access),
          severity: diagnostic.severity,
          message: boundedText(diagnostic.message, 1_024),
          range: plainRange(diagnostic.range),
        })),
      )
      .slice(0, 200);
    return {
      executionId,
      state: tracked.state,
      startedAt: tracked.startedAt,
      endedAt: tracked.endedAt,
      exitCode: tracked.exitCode,
      diagnostics,
    };
  }

  private terminateTask(executionId: string): Json {
    requiredGrant(this.#grants, 'execution');
    const tracked = this.#tasks.get(executionId);
    if (tracked === undefined)
      throw new IdeToolError('EXECUTION_NOT_FOUND', 'The task execution is unknown.');
    tracked.execution.terminate();
    tracked.state = 'terminated';
    tracked.endedAt = new Date().toISOString();
    clearTimeout(tracked.timer);
    return { executionId, state: tracked.state };
  }

  private debugState(access: Access): ToolDispatchResult {
    const configurations: Json[] = [];
    for (const folder of access.folders) {
      const launch = vscode.workspace.getConfiguration('launch', folder.uri);
      const untrusted = launch.get<unknown>('configurations');
      if (!Array.isArray(untrusted)) continue;
      for (const item of untrusted.slice(0, 100)) {
        if (typeof item !== 'object' || item === null) continue;
        const name = 'name' in item && typeof item.name === 'string' ? item.name : null;
        const type = 'type' in item && typeof item.type === 'string' ? item.type : null;
        const request =
          'request' in item && typeof item.request === 'string' ? item.request : null;
        if (name !== null) {
          configurations.push({
            workspaceFolderId: workspaceFolderId(folder, access),
            name: boundedText(name, 1_024),
            type: type === null ? null : boundedText(type, 256),
            request: request === null ? null : boundedText(request, 64),
            startable: true,
          });
        }
      }
      const compounds = launch.get<unknown>('compounds');
      if (Array.isArray(compounds)) {
        for (const item of compounds.slice(0, 100)) {
          if (
            typeof item === 'object' &&
            item !== null &&
            'name' in item &&
            typeof item.name === 'string'
          ) {
            configurations.push({
              workspaceFolderId: workspaceFolderId(folder, access),
              name: boundedText(item.name, 1_024),
              type: 'compound',
              request: null,
              startable: false,
            });
          }
        }
      }
    }
    const selectedConfigurations = configurations.slice(0, 200);
    const omittedCount = configurations.length - selectedConfigurations.length;
    return {
      result: {
        configurations: selectedConfigurations,
        sessions: [...this.#debug.entries()].map(([id, item]) => ({
          id,
          name: item.name,
          type: item.type,
          state: item.state,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
        })),
      },
      truncated: omittedCount > 0,
      omittedCount,
    };
  }

  private async startDebugging(
    args: Extract<V1AdditionalToolInvocation, { tool: 'start_debugging' }>['arguments'],
    access: Access,
  ): Promise<Json> {
    const grant = requiredGrant(this.#grants, 'execution');
    const activeDebug = [...this.#debug.values()].filter(
      (session) => session.state === 'running',
    ).length;
    if (activeDebug >= V1_IDE_TOOL_LIMITS.trackedDebugSessions)
      throw new IdeToolError(
        'TASK_LIMIT_REACHED',
        'The tracked debug-session limit was reached.',
      );
    const folder = access.folders.find(
      (item) => workspaceFolderId(item, access) === args.workspaceFolderId,
    );
    if (folder === undefined)
      throw new IdeToolError(
        'WORKSPACE_FOLDER_NOT_FOUND',
        'The workspace folder was not found.',
      );
    const configured = configuredDebugTargets(folder).filter(
      (target) => target.name === args.configurationName,
    );
    if (configured.length !== 1)
      throw new IdeToolError(
        'DEBUG_CONFIGURATION_NOT_FOUND',
        'The named debug configuration is missing or ambiguous.',
      );
    if (!this.#grants.isCurrent(grant)) throw grantChanged('execution');
    const id = randomUUID();
    const tracked: TrackedDebug = {
      id,
      folderUri: folder.uri.toString(),
      allowUnscopedSession: access.folders.length === 1,
      name: args.configurationName,
      type: configured[0]!.type,
      startedAt: new Date().toISOString(),
      state: 'running',
      endedAt: null,
    };
    this.#debug.set(id, tracked);
    const started = await vscode.debug.startDebugging(folder, args.configurationName, {
      noDebug: args.noDebug ?? false,
    });
    if (!started) {
      this.#debug.delete(id);
      throw new IdeToolError(
        'DEBUG_CONFIGURATION_NOT_FOUND',
        'VS Code could not start the named configuration.',
      );
    }
    const active = vscode.debug.activeDebugSession;
    if (
      tracked.session === undefined &&
      active !== undefined &&
      debugSessionMatches(tracked, active)
    ) {
      tracked.session = active;
      tracked.name = active.name;
      tracked.type = active.type;
    }
    const deadline = Date.now() + 2_000;
    while (tracked.session === undefined && Date.now() < deadline) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    if (tracked.session === undefined) {
      this.#debug.delete(id);
      throw new IdeToolError(
        'DEBUG_CONFIGURATION_NOT_FOUND',
        'VS Code started no observable session for the named configuration.',
      );
    }
    return { debugSessionId: id, state: 'running' };
  }

  private async stopDebugging(id: string): Promise<Json> {
    requiredGrant(this.#grants, 'execution');
    const tracked = this.#debug.get(id);
    if (tracked === undefined || tracked.state !== 'running')
      throw new IdeToolError(
        'DEBUG_SESSION_NOT_FOUND',
        'The debug session is unknown or no longer running.',
      );
    if (tracked.session !== undefined)
      await vscode.debug.stopDebugging(tracked.session);
    tracked.state = 'stopped';
    tracked.endedAt = new Date().toISOString();
    return { debugSessionId: id, state: 'stopped' };
  }
}

function configuredDebugTargets(
  folder: vscode.WorkspaceFolder,
): { readonly name: string; readonly type: string }[] {
  const launch = vscode.workspace.getConfiguration('launch', folder.uri);
  const configurations = launch.get<unknown>('configurations');
  if (!Array.isArray(configurations)) return [];
  const targets: { name: string; type: string }[] = [];
  for (const item of configurations.slice(0, 100)) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'name' in item &&
      typeof item.name === 'string' &&
      'type' in item &&
      typeof item.type === 'string'
    ) {
      targets.push({ name: item.name, type: item.type });
    }
  }
  return targets;
}

function debugSessionMatches(
  tracked: Pick<TrackedDebug, 'allowUnscopedSession' | 'folderUri' | 'name'>,
  session: vscode.DebugSession,
): boolean {
  return (
    tracked.name === session.name &&
    (tracked.folderUri === session.workspaceFolder?.uri.toString() ||
      (session.workspaceFolder === undefined && tracked.allowUnscopedSession))
  );
}

function summarizeWorkspaceEdit(
  edit: vscode.WorkspaceEdit,
  access: Access,
  byteBudget: number,
): { readonly value: Json; readonly usedBytes: number } {
  const documents: Json[] = [];
  let usedBytes = 0;
  let omittedEdits = 0;
  for (const [uri, edits] of edit.entries()) {
    const identity = workspaceUri(uri, access);
    if (identity === null) continue;
    const changes: Json[] = [];
    for (const change of edits) {
      const text = boundedText(change.newText, 2_048);
      const cost = Buffer.byteLength(text, 'utf8') + 128;
      if (usedBytes + cost > byteBudget || changes.length >= 64) {
        omittedEdits += 1;
        continue;
      }
      changes.push({ range: plainRange(change.range), newText: text });
      usedBytes += cost;
    }
    documents.push({ ...identity, changes, totalEditCount: edits.length });
  }
  return { value: { documents, omittedEdits }, usedBytes };
}

class IdeToolError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

interface DiskSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly text: string;
}

async function readVisualSnapshot(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2 * 1024 * 1024)
      return undefined;
    const bytes = await readFile(path);
    if (bytes.byteLength > 2 * 1024 * 1024) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function readDiskSnapshot(path: string): Promise<DiskSnapshot> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 10 * 1024 * 1024) {
    throw new IdeToolError(
      'UNSUPPORTED_DOCUMENT',
      'Only bounded regular non-symlink files can be reverted.',
    );
  }
  const handle = await open(path, 'r');
  let bytes: Uint8Array;
  let after;
  try {
    const before = await handle.stat();
    bytes = await handle.readFile();
    after = await handle.stat();
    if (!sameFileSnapshot(before, after)) {
      throw new IdeToolError(
        'DOCUMENT_CHANGED_DURING_REQUEST',
        'The saved file changed while it was being read.',
        true,
      );
    }
  } finally {
    await handle.close();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new IdeToolError(
      'UNSUPPORTED_DOCUMENT',
      'The saved file is not valid UTF-8 text.',
    );
  }
  return {
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeMs: after.mtimeMs,
    text,
  };
}

function sameFileSnapshot(
  left: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
  },
  right: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function failure(
  tool: V1AdditionalToolName,
  code: ErrorCode,
  message: string,
  retryable = false,
): V1AdditionalIpcResult {
  return { outcome: 'toolError', tool, error: { code, message, retryable } };
}

function recognizedName(value: unknown): V1AdditionalToolName | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tool' in value) ||
    typeof value.tool !== 'string'
  )
    return null;
  return V1_ADDITIONAL_TOOL_NAMES.find((name) => name === value.tool) ?? null;
}

async function currentAccess(
  enabled: ServiceOptions['isWorkspaceEnabled'],
): Promise<Access> {
  const folders = vscode.workspace.workspaceFolders;
  if (
    !vscode.workspace.isTrusted ||
    vscode.env.remoteName !== undefined ||
    vscode.env.uiKind !== vscode.UIKind.Desktop ||
    folders === undefined ||
    folders.length === 0 ||
    folders.some((folder) => folder.uri.scheme !== 'file')
  ) {
    throw new IdeToolError('WORKSPACE_UNTRUSTED', 'The workspace is not eligible.');
  }
  const identity = await createWorkspaceIdentity({
    displayName: vscode.workspace.name ?? folders[0]!.name,
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
  if (!(await enabled(identity.fingerprint)))
    throw new IdeToolError(
      'WORKSPACE_UNTRUSTED',
      'MCP access is disabled for this workspace.',
    );
  return { identity, folders };
}

async function openAuthorizedDocument(
  reference: DocumentRef,
  access: Access,
): Promise<vscode.TextDocument> {
  const path = await authorizedExistingPath(reference, access);
  return vscode.workspace.openTextDocument(vscode.Uri.file(path.path));
}

async function authorizedExistingPath(
  reference: DocumentRef,
  access: Access,
): Promise<{
  path: string;
  requestedPath: string;
  folderId: string;
  relativePath: string;
}> {
  let requested: string;
  let requiredFolder: string | null = null;
  if (reference.kind === 'workspacePath') {
    const folder = access.identity.folders.find(
      (item) => item.workspaceFolderId === reference.workspaceFolderId,
    );
    if (folder === undefined)
      throw new IdeToolError(
        'WORKSPACE_FOLDER_NOT_FOUND',
        'The workspace folder was not found.',
      );
    requested = join(folder.canonicalPath, ...validSegments(reference.relativePath));
    requiredFolder = folder.workspaceFolderId;
  } else {
    const uri = vscode.Uri.parse(reference.uri, true);
    if (uri.scheme !== 'file')
      throw new IdeToolError(
        'UNSUPPORTED_URI_SCHEME',
        'Only local file documents are supported.',
      );
    if (
      (uri.authority.length > 0 && uri.authority !== 'localhost') ||
      uri.query.length > 0 ||
      uri.fragment.length > 0
    ) {
      throw new IdeToolError(
        'UNSUPPORTED_DOCUMENT',
        'File URIs with authorities, queries, or fragments are unsupported.',
      );
    }
    requested = uri.fsPath;
  }
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    throw new IdeToolError('DOCUMENT_NOT_FOUND', 'The document was not found.');
  }
  const owner = access.identity.folders
    .filter(
      (folder) =>
        requiredFolder === null || folder.workspaceFolderId === requiredFolder,
    )
    .map((folder) => ({
      folder,
      relativePath: relative(folder.canonicalPath, canonical),
    }))
    .filter(
      (item) =>
        item.relativePath !== '' &&
        !item.relativePath.startsWith(`..${sep}`) &&
        item.relativePath !== '..',
    )
    .sort((a, b) => b.folder.canonicalPath.length - a.folder.canonicalPath.length)[0];
  if (owner === undefined)
    throw new IdeToolError(
      'DOCUMENT_OUTSIDE_WORKSPACE',
      'The document is outside the selected workspace.',
    );
  return {
    path: canonical,
    requestedPath: requested,
    folderId: owner.folder.workspaceFolderId,
    relativePath: owner.relativePath.split(sep).join('/'),
  };
}

async function existingRegularPath(reference: DocumentRef, access: Access) {
  const target = await authorizedExistingPath(reference, access);
  const stat = await lstat(target.requestedPath);
  if (target.requestedPath !== target.path || !stat.isFile() || stat.isSymbolicLink())
    throw new IdeToolError(
      'DIRECTORY_OPERATION_UNSUPPORTED',
      'Only canonical regular non-symlink files are supported.',
    );
  return target;
}

async function resolveNewPath(
  destination: { workspaceFolderId: string; relativePath: string },
  access: Access,
) {
  const folder = access.identity.folders.find(
    (item) => item.workspaceFolderId === destination.workspaceFolderId,
  );
  if (folder === undefined)
    throw new IdeToolError(
      'WORKSPACE_FOLDER_NOT_FOUND',
      'The workspace folder was not found.',
    );
  const candidate = join(
    folder.canonicalPath,
    ...validSegments(destination.relativePath),
  );
  let parent: string;
  try {
    parent = await realpath(dirname(candidate));
  } catch {
    throw new IdeToolError(
      'PARENT_NOT_FOUND',
      'The destination parent does not exist.',
    );
  }
  if (parent !== dirname(candidate)) {
    throw new IdeToolError(
      'DIRECTORY_OPERATION_UNSUPPORTED',
      'Destination parents must not traverse symlinks.',
    );
  }
  const parentRelative = relative(folder.canonicalPath, parent);
  if (parentRelative === '..' || parentRelative.startsWith(`..${sep}`))
    throw new IdeToolError(
      'DOCUMENT_OUTSIDE_WORKSPACE',
      'The destination parent is outside the workspace.',
    );
  return {
    path: join(parent, candidate.slice(dirname(candidate).length + 1)),
    folderId: folder.workspaceFolderId,
  };
}

function validSegments(value: string): string[] {
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  )
    throw new IdeToolError(
      'INVALID_ARGUMENT',
      'The workspace-relative path is invalid.',
    );
  const segments = value.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  )
    throw new IdeToolError(
      'INVALID_ARGUMENT',
      'The workspace-relative path is invalid.',
    );
  return segments;
}

function requiredGrant(
  grants: CapabilityGrantController,
  capability: 'write' | 'execution',
): CapabilityGrantToken {
  const token = grants.capture(capability);
  if (token === null)
    throw new IdeToolError(
      capability === 'write' ? 'WRITE_NOT_ENABLED' : 'EXECUTION_NOT_ENABLED',
      `${capability === 'write' ? 'Write' : 'Execution'} access is not enabled.`,
    );
  return token;
}

function grantChanged(capability: 'write' | 'execution'): IdeToolError {
  return new IdeToolError(
    capability === 'write' ? 'WRITE_GRANT_CHANGED' : 'EXECUTION_GRANT_CHANGED',
    `The ${capability} grant changed during the operation.`,
    true,
  );
}

function finalWriteCheck(
  grants: CapabilityGrantController,
  token: CapabilityGrantToken,
  documents: readonly vscode.TextDocument[],
  versions: readonly number[],
  signal: AbortSignal,
): void {
  if (signal.aborted)
    throw new IdeToolError('CANCELLED', 'The request was cancelled.', true);
  if (!grants.isCurrent(token)) throw grantChanged('write');
  documents.forEach((document, index) => checkVersion(document, versions[index]));
}

function checkVersion(
  document: vscode.TextDocument,
  expected: number | undefined,
): void {
  if (expected !== undefined && document.version !== expected)
    throw new IdeToolError(
      'DOCUMENT_VERSION_MISMATCH',
      'The document version does not match the requested snapshot.',
      true,
    );
}

async function ensureEditorTabs(
  documents: readonly vscode.TextDocument[],
): Promise<void> {
  for (const document of documents) {
    await vscode.window.showTextDocument(document, { preview: false });
  }
}

function validateEdits(
  document: vscode.TextDocument,
  edits: readonly {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  }[],
): void {
  if (edits.length > V1_IDE_TOOL_LIMITS.editsPerDocument)
    throw new IdeToolError(
      'EDIT_LIMIT_REACHED',
      'The per-document edit limit was exceeded.',
    );
  const spans = edits
    .map((edit) => {
      const requested = range(edit.range);
      const validated = document.validateRange(requested);
      if (!validated.isEqual(requested))
        throw new IdeToolError(
          'POSITION_OUT_OF_RANGE',
          'An edit range is outside the document.',
        );
      return {
        start: document.offsetAt(requested.start),
        end: document.offsetAt(requested.end),
      };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < spans.length; index += 1)
    if (spans[index - 1]!.end > spans[index]!.start)
      throw new IdeToolError('EDIT_CONFLICT', 'Text edits overlap.');
}

async function prepareTextOnlyWorkspaceEdit(
  source: vscode.WorkspaceEdit,
  access: Access,
): Promise<PreparedWorkspaceEdit | null> {
  const output = new vscode.WorkspaceEdit();
  const documents: vscode.TextDocument[] = [];
  const versions: number[] = [];
  let count = 0;
  let bytes = 0;
  const entries = source.entries();
  if (source.size !== entries.length) return null;
  for (const [uri, edits] of entries) {
    if (!uriInAccess(uri, access) || edits.length === 0) return null;
    let canonical: string;
    try {
      const stats = await lstat(uri.fsPath);
      if (!stats.isFile() || stats.isSymbolicLink()) return null;
      canonical = await realpath(uri.fsPath);
    } catch {
      return null;
    }
    if (!pathInCanonicalAccess(canonical, access)) return null;
    const document = await vscode.workspace.openTextDocument(uri);
    validateEdits(
      document,
      edits.map((edit) => ({ range: plainRange(edit.range), newText: edit.newText })),
    );
    count += edits.length;
    for (const edit of edits) bytes += Buffer.byteLength(edit.newText, 'utf8');
    if (
      count > V1_IDE_TOOL_LIMITS.editsTotal ||
      edits.length > V1_IDE_TOOL_LIMITS.editsPerDocument ||
      bytes > V1_IDE_TOOL_LIMITS.replacementBytesTotal
    )
      return null;
    output.set(
      uri,
      edits.map((edit) => new vscode.TextEdit(edit.range, edit.newText)),
    );
    documents.push(document);
    versions.push(document.version);
  }
  return count === 0 ? null : { edit: output, documents, versions };
}

function pathInCanonicalAccess(path: string, access: Access): boolean {
  return access.identity.folders.some((folder) => {
    const value = relative(folder.canonicalPath, path);
    return value !== '' && value !== '..' && !value.startsWith(`..${sep}`);
  });
}

function normalizeProviderValue(
  value: unknown,
  access: Access,
): { readonly value: Json; readonly omittedCount: number } {
  const seen = new WeakSet<object>();
  let omittedCount = 0;
  let remainingBytes = 192 * 1024;
  const consumeText = (value: string, maximumBytes: number): string => {
    const selected = boundedText(value, Math.min(maximumBytes, remainingBytes));
    remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(selected, 'utf8'));
    if (selected.length < value.length) omittedCount += 1;
    return selected;
  };
  const normalize = (item: unknown, depth: number): Json => {
    if (remainingBytes === 0) {
      omittedCount += 1;
      return null;
    }
    if (depth > 8 || item === undefined) {
      if (item !== undefined) omittedCount += 1;
      return null;
    }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return consumeText(item, 4_096);
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (item instanceof vscode.Uri)
      return uriInAccess(item, access) ? workspaceUri(item, access) : null;
    if (item instanceof vscode.MarkdownString) {
      return {
        value: consumeText(
          item.value.replaceAll(/\]\(\s*command:[^)]+\)/giu, '](command omitted)'),
          16_384,
        ),
      };
    }
    if (item instanceof vscode.Position)
      return { line: item.line, character: item.character };
    if (item instanceof vscode.Range) return plainRange(item);
    if (Array.isArray(item)) {
      const selected = item.slice(0, V1_IDE_TOOL_LIMITS.providerItems);
      omittedCount += item.length - selected.length;
      const values: Json[] = [];
      for (const entry of selected) {
        if (remainingBytes < 16) {
          omittedCount += selected.length - values.length;
          break;
        }
        remainingBytes -= 16;
        values.push(normalize(entry, depth + 1));
      }
      return values;
    }
    if (typeof item === 'object') {
      if (seen.has(item)) return null;
      seen.add(item);
      const result: { [key: string]: Json } = {};
      const keys = Object.keys(item).sort();
      omittedCount += Math.max(0, keys.length - 32);
      for (const key of keys.slice(0, 32)) {
        if (remainingBytes < Buffer.byteLength(key, 'utf8') + 16) {
          omittedCount += 1;
          continue;
        }
        remainingBytes -= Buffer.byteLength(key, 'utf8') + 16;
        if (['command', 'arguments', 'data', 'edit'].includes(key)) continue;
        const normalized = normalize((item as Record<string, unknown>)[key], depth + 1);
        if (normalized !== null) result[key] = normalized;
      }
      return result;
    }
    return null;
  };
  return { value: normalize(value, 0), omittedCount };
}

function isDispatchResult(
  value: Json | ToolDispatchResult,
): value is ToolDispatchResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'result' in value &&
    'truncated' in value &&
    'omittedCount' in value
  );
}

function documentIdentity(document: vscode.TextDocument, access: Access): Json {
  return {
    ...workspaceUri(document.uri, access),
    languageId: document.languageId,
    documentVersion: document.version,
    isDirty: document.isDirty,
  };
}

function workspaceUri(
  uri: vscode.Uri,
  access: Access,
): { workspaceFolderId: string; relativePath: string } | null {
  const owner = access.identity.folders
    .map((folder) => ({ folder, value: relative(folder.canonicalPath, uri.fsPath) }))
    .filter(
      (item) =>
        item.value !== '' && item.value !== '..' && !item.value.startsWith(`..${sep}`),
    )
    .sort((a, b) => b.folder.canonicalPath.length - a.folder.canonicalPath.length)[0];
  return owner === undefined
    ? null
    : {
        workspaceFolderId: owner.folder.workspaceFolderId,
        relativePath: owner.value.split(sep).join('/'),
      };
}

function uriInAccess(uri: vscode.Uri, access: Access): boolean {
  return uri.scheme === 'file' && workspaceUri(uri, access) !== null;
}
function position(value: { line: number; character: number }): vscode.Position {
  return new vscode.Position(value.line, value.character);
}
function range(value: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): vscode.Range {
  return new vscode.Range(position(value.start), position(value.end));
}
function plainRange(value: vscode.Range): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  return {
    start: { line: value.start.line, character: value.start.character },
    end: { line: value.end.line, character: value.end.character },
  };
}
function workspaceFolderId(
  folder: vscode.WorkspaceFolder,
  access: Access,
): string | null {
  return (
    access.identity.folders.find((item) => item.uri === folder.uri.toString())
      ?.workspaceFolderId ?? null
  );
}
function taskFingerprint(task: vscode.Task): string {
  const scope =
    typeof task.scope === 'object'
      ? task.scope.uri.toString()
      : String(task.scope ?? 'global');
  return createHash('sha256')
    .update(
      JSON.stringify([
        task.name,
        task.source,
        task.definition.type,
        scope,
        task.group?.id ?? null,
        safeTaskRunner(task),
      ]),
    )
    .digest('hex');
}

type SafeTaskRunner = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'node' | 'vp';

function safeTaskRunner(task: vscode.Task): SafeTaskRunner | null {
  const execution = task.execution;
  if (execution instanceof vscode.ProcessExecution) {
    return allowlistedTaskRunner(execution.process);
  }
  if (execution instanceof vscode.ShellExecution && execution.command !== undefined) {
    return allowlistedTaskRunner(
      typeof execution.command === 'string'
        ? execution.command
        : execution.command.value,
    );
  }
  return null;
}

function allowlistedTaskRunner(command: string): SafeTaskRunner | null {
  const executable = command.split(/[\\/]/).at(-1)?.toLowerCase();
  switch (executable) {
    case 'npm':
    case 'yarn':
    case 'pnpm':
    case 'bun':
    case 'node':
    case 'vp':
      return executable;
    default:
      return null;
  }
}
function taskInAccess(task: vscode.Task, access: Access): boolean {
  const scope = task.scope;
  return (
    scope === vscode.TaskScope.Workspace ||
    (typeof scope === 'object' &&
      'uri' in scope &&
      access.folders.some((folder) => folder.uri.toString() === scope.uri.toString()))
  );
}
function isNodeCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function boundedText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(value.slice(0, candidate), 'utf8') <= maximumBytes) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  return value.slice(0, lower);
}
