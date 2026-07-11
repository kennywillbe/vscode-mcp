import { realpath, stat } from 'node:fs/promises';
import process from 'node:process';

import { PROVIDER_OUTPUT_LIMITS, TOOL_LIMITS } from '@vscode-mcp/protocol/constants';
import * as vscode from 'vscode';

import type {
  EditorHostDocument,
  EditorToolWorkspaceAccess,
} from './editor-tool-host.js';
import type {
  DiagnosticsProviderReadLimits,
  LanguageHostOpenDocuments,
  LanguageToolHost,
} from './language-tool-host.js';
import { LanguageToolService } from './language-tool-service.js';
import {
  snapshotBoundedProviderItems,
  type BoundedProviderItems,
} from './provider-output-bounds.js';
import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import { createWorkspaceIdentity } from './workspace-identity.js';

/** The only VS Code commands this adapter can invoke. Neither is caller-controlled. */
export const VSCODE_LANGUAGE_PROVIDER_COMMANDS = {
  hover: 'vscode.executeHoverProvider',
  signatureHelp: 'vscode.executeSignatureHelpProvider',
} as const;

export interface VsCodeLanguageToolServiceOptions {
  readonly isWorkspaceEnabled: (
    workspaceFingerprint: string,
  ) => boolean | PromiseLike<boolean>;
  readonly now?: () => Date;
}

/** Creates the production language-tool adapter while leaving lifecycle to main. */
export function createVsCodeLanguageToolService(
  options: VsCodeLanguageToolServiceOptions,
): LanguageToolService {
  return new LanguageToolService({
    host: new VsCodeLanguageToolHost(),
    getWorkspaceAccess: () => currentWorkspaceAccess(options.isWorkspaceEnabled),
    realpath,
    pathStrategy: createWorkspaceAuthorizationPathStrategy(
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

class VsCodeLanguageToolHost implements LanguageToolHost {
  public openDocuments(): LanguageHostOpenDocuments {
    const providerDocuments = vscode.workspace.textDocuments;
    const availableCount = Math.min(
      providerDocuments.length,
      PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax,
    );
    return {
      availableCount,
      omittedCount: providerDocuments.length - availableCount,
      *[Symbol.iterator](): Iterator<EditorHostDocument> {
        for (let index = 0; index < availableCount; index += 1) {
          const document = providerDocuments[index];
          if (document !== undefined) {
            yield wrapDocument(document);
          }
        }
      },
    };
  }

  public async statFile(canonicalPath: string): Promise<{
    readonly size: number;
    readonly isFile: boolean;
  }> {
    const fileStat = await stat(canonicalPath);
    return { size: fileStat.size, isFile: fileStat.isFile() };
  }

  public async openTextDocument(uri: string): Promise<EditorHostDocument> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(uri, true),
    );
    return wrapDocument(document);
  }

  public onDocumentChanged(listener: (uri: string) => void): {
    dispose(): void;
  } {
    return vscode.workspace.onDidChangeTextDocument((event) => {
      listener(event.document.uri.toString());
    });
  }

  public diagnostics(
    uri: string,
    limits: DiagnosticsProviderReadLimits,
  ): BoundedProviderItems<unknown> {
    const providerDiagnostics = vscode.languages.getDiagnostics(
      vscode.Uri.parse(uri, true),
    );
    // VS Code owns the provider call and its initial array allocation. This boundary
    // caps every extension-owned property read and normalized copy after that return.
    let remainingRelatedInformation = Math.min(
      limits.relatedInformation,
      PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerRequestMax,
    );
    return snapshotBoundedProviderItems(
      providerDiagnostics,
      Math.min(limits.items, PROVIDER_OUTPUT_LIMITS.diagnostics.itemsPerRequestMax),
      (diagnostic) => {
        const relatedInformationLimit = Math.min(
          remainingRelatedInformation,
          PROVIDER_OUTPUT_LIMITS.diagnostics.relatedInformationPerItemMax,
        );
        const wrapped = wrapDiagnostic(diagnostic, relatedInformationLimit);
        remainingRelatedInformation -= wrapped.relatedInformation.items.length;
        return wrapped;
      },
    );
  }

  public onDiagnosticsChanged(listener: (uris: BoundedProviderItems<string>) => void): {
    dispose(): void;
  } {
    return vscode.languages.onDidChangeDiagnostics((event) => {
      listener(
        snapshotBoundedProviderItems(
          event.uris,
          TOOL_LIMITS.diagnostics.documentsMax,
          (uri) => uri.toString(),
        ),
      );
    });
  }

  public async provideHover(
    uri: string,
    position: { readonly line: number; readonly character: number },
  ): Promise<BoundedProviderItems<unknown> | undefined> {
    const result = await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
      VSCODE_LANGUAGE_PROVIDER_COMMANDS.hover,
      vscode.Uri.parse(uri, true),
      new vscode.Position(position.line, position.character),
    );
    if (result === undefined) {
      return undefined;
    }
    // VS Code necessarily creates the command result first; only a bounded prefix is
    // inspected or copied by this extension after the provider returns.
    let remainingContents = PROVIDER_OUTPUT_LIMITS.hover.contentsPerRequestMax;
    return snapshotBoundedProviderItems(
      result,
      PROVIDER_OUTPUT_LIMITS.hover.entriesMax,
      (hover) => {
        const contentsLimit = Math.min(
          remainingContents,
          PROVIDER_OUTPUT_LIMITS.hover.contentsPerEntryMax,
        );
        const wrapped = wrapHover(hover, contentsLimit);
        remainingContents -= wrapped.contents.items.length;
        return wrapped;
      },
    );
  }

  public async provideSignatureHelp(
    uri: string,
    position: { readonly line: number; readonly character: number },
    triggerCharacter: string | undefined,
  ): Promise<unknown> {
    const commandArguments: unknown[] = [
      vscode.Uri.parse(uri, true),
      new vscode.Position(position.line, position.character),
    ];
    if (triggerCharacter !== undefined) {
      commandArguments.push(triggerCharacter);
    }
    const result = await vscode.commands.executeCommand<
      vscode.SignatureHelp | undefined
    >(VSCODE_LANGUAGE_PROVIDER_COMMANDS.signatureHelp, ...commandArguments);
    return result === undefined ? undefined : wrapSignatureHelp(result);
  }
}

async function currentWorkspaceAccess(
  isWorkspaceEnabled: VsCodeLanguageToolServiceOptions['isWorkspaceEnabled'],
): Promise<EditorToolWorkspaceAccess> {
  if (
    !vscode.workspace.isTrusted ||
    vscode.env.remoteName !== undefined ||
    vscode.env.uiKind !== vscode.UIKind.Desktop ||
    process.env['SNAP'] !== undefined ||
    process.env['FLATPAK_ID'] !== undefined
  ) {
    return { eligible: false };
  }

  const folders = vscode.workspace.workspaceFolders;
  if (
    folders === undefined ||
    folders.length === 0 ||
    folders.some((folder) => folder.uri.scheme !== 'file')
  ) {
    return { eligible: false };
  }

  const identity = await createWorkspaceIdentity({
    displayName: vscode.workspace.name ?? folders[0]?.name ?? 'workspace',
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
  return (await isWorkspaceEnabled(identity.fingerprint))
    ? { eligible: true, identity }
    : { eligible: false };
}

function wrapDocument(document: vscode.TextDocument): EditorHostDocument {
  return {
    get uri(): string {
      return document.uri.toString();
    },
    get languageId(): string {
      return document.languageId;
    },
    get version(): number {
      return document.version;
    },
    get isDirty(): boolean {
      return document.isDirty;
    },
    get lineCount(): number {
      return document.lineCount;
    },
    get eol(): 'LF' | 'CRLF' {
      return document.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF';
    },
    lineText(line: number): string {
      return document.lineAt(line).text;
    },
  };
}

function wrapDiagnostic(
  diagnostic: vscode.Diagnostic,
  relatedInformationLimit: number,
): {
  readonly range: ReturnType<typeof wrapRange>;
  readonly severity: unknown;
  readonly message: string;
  readonly source: string | null;
  readonly code: unknown;
  readonly tags: BoundedProviderItems<unknown>;
  readonly relatedInformation: BoundedProviderItems<unknown>;
} {
  const tags = diagnostic.tags;
  const relatedInformation = diagnostic.relatedInformation;
  return {
    range: wrapRange(diagnostic.range),
    severity: diagnosticSeverityName(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? null,
    code: wrapDiagnosticCode(diagnostic.code),
    tags: snapshotBoundedProviderItems(
      tags ?? [],
      PROVIDER_OUTPUT_LIMITS.diagnostics.tagsPerItemMax,
      diagnosticTagName,
    ),
    relatedInformation: snapshotBoundedProviderItems(
      relatedInformation ?? [],
      relatedInformationLimit,
      (information) => ({
        uri: information.location.uri.toString(),
        range: wrapRange(information.location.range),
        message: information.message,
      }),
    ),
  };
}

function wrapDiagnosticCode(code: vscode.Diagnostic['code']): unknown {
  if (code === undefined) {
    return null;
  }
  if (typeof code === 'string' || typeof code === 'number') {
    return code;
  }
  return { value: code.value, targetUri: code.target.toString() };
}

function diagnosticSeverityName(severity: vscode.DiagnosticSeverity): unknown {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return severity;
  }
}

function diagnosticTagName(tag: vscode.DiagnosticTag): unknown {
  switch (tag) {
    case vscode.DiagnosticTag.Unnecessary:
      return 'unnecessary';
    case vscode.DiagnosticTag.Deprecated:
      return 'deprecated';
    default:
      return tag;
  }
}

function wrapHover(
  hover: vscode.Hover,
  contentsLimit: number,
): {
  readonly range: ReturnType<typeof wrapRange> | null;
  readonly contents: BoundedProviderItems<unknown>;
} {
  return {
    range: hover.range === undefined ? null : wrapRange(hover.range),
    contents: snapshotBoundedProviderItems(
      hover.contents,
      contentsLimit,
      wrapHoverContent,
    ),
  };
}

function wrapHoverContent(
  content: vscode.MarkdownString | vscode.MarkedString,
): unknown {
  if (content instanceof vscode.MarkdownString) {
    return { kind: 'markdown', value: content.value };
  }
  if (typeof content === 'string') {
    return { kind: 'plaintext', value: content };
  }
  return { kind: 'plaintext', value: content.value };
}

function wrapSignatureHelp(help: vscode.SignatureHelp): unknown {
  return {
    activeSignature: help.activeSignature,
    activeParameter: help.activeParameter,
    signatures: snapshotBoundedProviderItems(
      help.signatures,
      PROVIDER_OUTPUT_LIMITS.signatureHelp.signaturesMax,
      (signature) => ({
        label: signature.label,
        documentation: wrapDocumentation(signature.documentation),
        activeParameter: signature.activeParameter,
        parameters: snapshotBoundedProviderItems(
          signature.parameters,
          PROVIDER_OUTPUT_LIMITS.signatureHelp.parametersPerSignatureMax,
          (parameter) => ({
            label:
              typeof parameter.label === 'string'
                ? parameter.label
                : [parameter.label[0], parameter.label[1]],
            documentation: wrapDocumentation(parameter.documentation),
          }),
        ),
      }),
    ),
  };
}

function wrapDocumentation(
  documentation: string | vscode.MarkdownString | undefined,
): unknown {
  if (documentation === undefined) {
    return null;
  }
  return documentation instanceof vscode.MarkdownString
    ? { kind: 'markdown', value: documentation.value }
    : { kind: 'plaintext', value: documentation };
}

function wrapRange(range: vscode.Range): {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
} {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}
