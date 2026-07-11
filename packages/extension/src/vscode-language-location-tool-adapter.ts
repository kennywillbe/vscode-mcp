import { realpath, stat } from 'node:fs/promises';
import process from 'node:process';

import * as vscode from 'vscode';

import { PROVIDER_OUTPUT_LIMITS } from '@vscode-mcp/protocol/constants';

import {
  type LanguageDefinitionKind,
  type LanguageHostCallItem,
  type LanguageHostDefinitionTarget,
  type LanguageHostDocument,
  type LanguageHostDocumentSymbols,
  type LanguageHostFlatSymbol,
  type LanguageHostHierarchicalSymbol,
  type LanguageHostIncomingCall,
  type LanguageHostOutgoingCall,
  type LanguageHostProviderBatch,
  type LanguageHostRange,
  type LanguageHostReference,
  type LanguageHostWorkspaceSymbol,
  type LanguageLocationToolHost,
  type LanguageLocationWorkspaceAccess,
} from './language-location-tool-host.js';
import { LanguageLocationToolService } from './language-location-tool-service.js';
import {
  saturatingAddProviderCounts,
  snapshotBoundedProviderItems,
  snapshotBoundedProviderItemsWithPrefix,
  type BoundedProviderItems,
} from './provider-output-bounds.js';
import { createWorkspaceAuthorizationPathStrategy } from './workspace-authorizer.js';
import { createWorkspaceIdentity } from './workspace-identity.js';

export interface VsCodeLanguageLocationToolServiceOptions {
  readonly isWorkspaceEnabled: (
    workspaceFingerprint: string,
  ) => boolean | PromiseLike<boolean>;
  readonly now?: () => Date;
}

const DEFINITION_COMMANDS = {
  definition: 'vscode.executeDefinitionProvider',
  declaration: 'vscode.executeDeclarationProvider',
  typeDefinition: 'vscode.executeTypeDefinitionProvider',
  implementation: 'vscode.executeImplementationProvider',
} as const satisfies Record<LanguageDefinitionKind, string>;

const REFERENCE_COMMAND = 'vscode.executeReferenceProvider';
const DOCUMENT_SYMBOL_COMMAND = 'vscode.executeDocumentSymbolProvider';
const WORKSPACE_SYMBOL_COMMAND = 'vscode.executeWorkspaceSymbolProvider';
const PREPARE_CALL_HIERARCHY_COMMAND = 'vscode.prepareCallHierarchy';
const INCOMING_CALLS_COMMAND = 'vscode.provideIncomingCalls';
const OUTGOING_CALLS_COMMAND = 'vscode.provideOutgoingCalls';

/** Creates the production adapter while leaving extension lifecycle ownership to main. */
export function createVsCodeLanguageLocationToolService(
  options: VsCodeLanguageLocationToolServiceOptions,
): LanguageLocationToolService {
  const serviceOptions = {
    host: new VsCodeLanguageLocationToolHost(),
    getWorkspaceAccess: () => currentWorkspaceAccess(options.isWorkspaceEnabled),
    realpath,
    pathStrategy: createWorkspaceAuthorizationPathStrategy(
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return new LanguageLocationToolService(serviceOptions);
}

class VsCodeLanguageLocationToolHost implements LanguageLocationToolHost {
  public *openDocuments(): Iterable<LanguageHostDocument> {
    const documents = vscode.workspace.textDocuments;
    const rawIndexLimit = Math.min(
      documents.length,
      PROVIDER_OUTPUT_LIMITS.openDocuments.itemsMax,
    );
    for (let index = 0; index < rawIndexLimit; index += 1) {
      const document = documents[index];
      if (document !== undefined) {
        yield wrapDocument(document);
      }
    }
  }

  public async statFile(canonicalPath: string): Promise<{
    readonly size: number;
    readonly isFile: boolean;
  }> {
    const fileStat = await stat(canonicalPath);
    return { size: fileStat.size, isFile: fileStat.isFile() };
  }

  public async openTextDocument(uri: string): Promise<LanguageHostDocument> {
    return wrapDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.parse(uri, true)),
    );
  }

  public async provideDefinition(
    kind: LanguageDefinitionKind,
    uri: string,
    position: { readonly line: number; readonly character: number },
  ): Promise<LanguageHostProviderBatch<LanguageHostDefinitionTarget>> {
    const raw = await vscode.commands.executeCommand<unknown>(
      DEFINITION_COMMANDS[kind],
      vscode.Uri.parse(uri, true),
      new vscode.Position(position.line, position.character),
    );
    return mapProviderArray(
      raw,
      PROVIDER_OUTPUT_LIMITS.definition.itemsMax,
      mapDefinitionTarget,
    );
  }

  public async provideReferences(
    uri: string,
    position: { readonly line: number; readonly character: number },
  ): Promise<LanguageHostProviderBatch<LanguageHostReference>> {
    const raw = await vscode.commands.executeCommand<unknown>(
      REFERENCE_COMMAND,
      vscode.Uri.parse(uri, true),
      new vscode.Position(position.line, position.character),
    );
    return mapProviderArray(
      raw,
      PROVIDER_OUTPUT_LIMITS.references.itemsMax,
      mapReference,
    );
  }

  public async provideDocumentSymbols(
    uri: string,
  ): Promise<LanguageHostDocumentSymbols> {
    const raw = await vscode.commands.executeCommand<unknown>(
      DOCUMENT_SYMBOL_COMMAND,
      vscode.Uri.parse(uri, true),
    );
    return normalizeDocumentSymbolProviderOutput(raw);
  }

  public async provideWorkspaceSymbols(
    query: string,
  ): Promise<LanguageHostProviderBatch<LanguageHostWorkspaceSymbol>> {
    const raw = await vscode.commands.executeCommand<unknown>(
      WORKSPACE_SYMBOL_COMMAND,
      query,
    );
    return mapProviderArray(
      raw,
      PROVIDER_OUTPUT_LIMITS.workspaceSymbols.itemsMax,
      mapWorkspaceSymbol,
    );
  }

  public async prepareCallHierarchy(
    uri: string,
    position: { readonly line: number; readonly character: number },
  ): Promise<LanguageHostProviderBatch<LanguageHostCallItem>> {
    const raw = await vscode.commands.executeCommand<unknown>(
      PREPARE_CALL_HIERARCHY_COMMAND,
      vscode.Uri.parse(uri, true),
      new vscode.Position(position.line, position.character),
    );
    return mapProviderArray(
      raw,
      PROVIDER_OUTPUT_LIMITS.callHierarchy.rootsMax,
      mapCallItem,
    );
  }

  public async provideIncomingCalls(
    item: LanguageHostCallItem,
  ): Promise<LanguageHostProviderBatch<LanguageHostIncomingCall>> {
    const raw = await vscode.commands.executeCommand<unknown>(
      INCOMING_CALLS_COMMAND,
      item.providerHandle,
    );
    return mapCallProviderArray(raw, mapIncomingCall);
  }

  public async provideOutgoingCalls(
    item: LanguageHostCallItem,
  ): Promise<LanguageHostProviderBatch<LanguageHostOutgoingCall>> {
    const raw = await vscode.commands.executeCommand<unknown>(
      OUTGOING_CALLS_COMMAND,
      item.providerHandle,
    );
    return mapCallProviderArray(raw, mapOutgoingCall);
  }
}

/** Pure bounded conversion used by the production command adapter and host tests. */
export function normalizeDocumentSymbolProviderOutput(
  raw: unknown,
): LanguageHostDocumentSymbols {
  if (raw === null || raw === undefined) {
    return { state: 'noResult' };
  }
  if (!Array.isArray(raw)) {
    return {
      state: 'result',
      shape: 'hierarchical',
      items: [null],
      omittedCount: 0,
    };
  }

  const detected = detectDocumentSymbolShape(raw);
  if (detected.shape === 'flat') {
    const bounded = snapshotBoundedProviderItemsWithPrefix(
      raw,
      detected.inspectedPrefix,
      PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax,
      mapFlatSymbol,
    );
    return { state: 'result', shape: 'flat', ...bounded };
  }
  const bounded = mapHierarchicalSymbols(raw, detected.inspectedPrefix);
  return { state: 'result', shape: 'hierarchical', ...bounded };
}

function mapProviderArray<Item>(
  raw: unknown,
  maximumItems: number,
  mapper: (value: unknown) => Item | null,
): LanguageHostProviderBatch<Item> {
  if (raw === null || raw === undefined) {
    return { state: 'noResult' };
  }
  if (!Array.isArray(raw)) {
    return { state: 'result', items: [null], omittedCount: 0 };
  }
  return {
    state: 'result',
    ...snapshotBoundedProviderItems(raw, maximumItems, mapper),
  };
}

function mapDefinitionTarget(value: unknown): LanguageHostDefinitionTarget | null {
  if (value instanceof vscode.Location) {
    return {
      shape: 'location',
      uri: value.uri.toString(),
      range: wrapRange(value.range),
    };
  }
  if (
    isRecord(value) &&
    value['targetUri'] instanceof vscode.Uri &&
    value['targetRange'] instanceof vscode.Range &&
    value['targetSelectionRange'] instanceof vscode.Range &&
    (value['originSelectionRange'] === undefined ||
      value['originSelectionRange'] instanceof vscode.Range)
  ) {
    return {
      shape: 'locationLink',
      targetUri: value['targetUri'].toString(),
      targetRange: wrapRange(value['targetRange']),
      targetSelectionRange: wrapRange(value['targetSelectionRange']),
      originSelectionRange:
        value['originSelectionRange'] instanceof vscode.Range
          ? wrapRange(value['originSelectionRange'])
          : null,
    };
  }
  return null;
}

function mapReference(value: unknown): LanguageHostReference | null {
  return value instanceof vscode.Location
    ? { uri: value.uri.toString(), range: wrapRange(value.range) }
    : null;
}

type DocumentSymbolShapeDetection = {
  readonly shape: 'flat' | 'hierarchical';
  readonly inspectedPrefix: readonly unknown[];
};

interface MutableHierarchicalSymbol extends LanguageHostHierarchicalSymbol {
  readonly children: Array<LanguageHostHierarchicalSymbol | null>;
}

interface HierarchicalSourceFrame {
  readonly source: readonly unknown[];
  readonly inspectedPrefix: readonly unknown[];
  readonly depth: number;
  readonly output: Array<LanguageHostHierarchicalSymbol | null>;
  index: number;
}

/** Detects the legacy flat/provider shape without searching an unbounded array. */
function detectDocumentSymbolShape(
  raw: readonly unknown[],
): DocumentSymbolShapeDetection {
  const inspectedPrefix: unknown[] = [];
  const count = Math.min(raw.length, PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax);
  for (let index = 0; index < count; index += 1) {
    const item = raw[index];
    inspectedPrefix.push(item);
    if (item instanceof vscode.SymbolInformation) {
      return { shape: 'flat', inspectedPrefix };
    }
    if (item instanceof vscode.DocumentSymbol) {
      return { shape: 'hierarchical', inspectedPrefix };
    }
  }
  return { shape: 'hierarchical', inspectedPrefix };
}

/**
 * Copies a hierarchical result in preorder with one global node budget. When a whole
 * unvisited subtree is skipped, its root contributes exactly one omission.
 */
function mapHierarchicalSymbols(
  raw: readonly unknown[],
  inspectedPrefix: readonly unknown[],
): BoundedProviderItems<LanguageHostHierarchicalSymbol | null> {
  const items: Array<LanguageHostHierarchicalSymbol | null> = [];
  const frames: HierarchicalSourceFrame[] = [
    { source: raw, inspectedPrefix, depth: 0, output: items, index: 0 },
  ];
  const visited = new WeakSet<object>();
  let visitedNodeCount = 0;
  let omittedCount = 0;

  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (frame === undefined) {
      break;
    }
    if (frame.index >= frame.source.length) {
      frames.pop();
      continue;
    }
    if (visitedNodeCount >= PROVIDER_OUTPUT_LIMITS.documentSymbols.nodesMax) {
      omittedCount = saturatingAddProviderCounts(
        omittedCount,
        countPendingSubtreeRoots(frames),
      );
      break;
    }

    const index = frame.index;
    frame.index += 1;
    visitedNodeCount += 1;
    const value =
      index < frame.inspectedPrefix.length
        ? frame.inspectedPrefix[index]
        : frame.source[index];
    if (!(value instanceof vscode.DocumentSymbol) || visited.has(value)) {
      frame.output.push(null);
      continue;
    }

    visited.add(value);
    const children: Array<LanguageHostHierarchicalSymbol | null> = [];
    const mapped: MutableHierarchicalSymbol = {
      name: value.name,
      detail: value.detail,
      kind: symbolKindName(value.kind),
      range: wrapRange(value.range),
      selectionRange: wrapRange(value.selectionRange),
      deprecated: hasDeprecatedSymbolTag(value.tags),
      children,
    };
    frame.output.push(mapped);

    if (!Array.isArray(value.children)) {
      children.push(null);
      continue;
    }
    if (value.children.length === 0) {
      continue;
    }
    if (frame.depth >= PROVIDER_OUTPUT_LIMITS.documentSymbols.depthMax) {
      omittedCount = saturatingAddProviderCounts(omittedCount, value.children.length);
      continue;
    }
    frames.push({
      source: value.children,
      inspectedPrefix: [],
      depth: frame.depth + 1,
      output: children,
      index: 0,
    });
  }

  return { items, omittedCount };
}

function countPendingSubtreeRoots(frames: readonly HierarchicalSourceFrame[]): number {
  let count = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame !== undefined) {
      count = saturatingAddProviderCounts(count, frame.source.length - frame.index);
    }
  }
  return count;
}

function mapFlatSymbol(value: unknown): LanguageHostFlatSymbol | null {
  if (!(value instanceof vscode.SymbolInformation)) {
    return null;
  }
  return {
    name: value.name,
    kind: symbolKindName(value.kind),
    containerName: value.containerName,
    uri: value.location.uri.toString(),
    range: wrapRange(value.location.range),
    deprecated: hasDeprecatedSymbolTag(value.tags),
  };
}

function mapWorkspaceSymbol(value: unknown): LanguageHostWorkspaceSymbol | null {
  if (!(value instanceof vscode.SymbolInformation)) {
    return null;
  }
  return {
    name: value.name,
    kind: symbolKindName(value.kind),
    containerName: value.containerName,
    uri: value.location.uri.toString(),
    range: wrapRange(value.location.range),
  };
}

function mapCallItem(value: unknown): LanguageHostCallItem | null {
  if (!(value instanceof vscode.CallHierarchyItem)) {
    return null;
  }
  return {
    name: value.name,
    detail: value.detail ?? '',
    kind: symbolKindName(value.kind),
    uri: value.uri.toString(),
    range: wrapRange(value.range),
    selectionRange: wrapRange(value.selectionRange),
    providerHandle: value,
  };
}

interface MappedCall<Item> {
  readonly item: Item;
  readonly inspectedRangeCount: number;
  readonly omittedRangeCount: number;
}

function mapCallProviderArray<Item>(
  raw: unknown,
  mapper: (value: unknown, remainingRangeBudget: number) => MappedCall<Item> | null,
): LanguageHostProviderBatch<Item> {
  if (raw === null || raw === undefined) {
    return { state: 'noResult' };
  }
  if (!Array.isArray(raw)) {
    return { state: 'result', items: [null], omittedCount: 0 };
  }

  let remainingRangeBudget =
    PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerDirectionMax;
  let omittedRangeCount = 0;
  const boundedCalls = snapshotBoundedProviderItems(
    raw,
    PROVIDER_OUTPUT_LIMITS.callHierarchy.callsPerDirectionMax,
    (value): Item | null => {
      const call = mapper(value, remainingRangeBudget);
      if (call === null) {
        return null;
      }
      remainingRangeBudget -= call.inspectedRangeCount;
      omittedRangeCount = saturatingAddProviderCounts(
        omittedRangeCount,
        call.omittedRangeCount,
      );
      return call.item;
    },
  );
  return {
    state: 'result',
    items: boundedCalls.items,
    omittedCount: saturatingAddProviderCounts(
      boundedCalls.omittedCount,
      omittedRangeCount,
    ),
  };
}

function mapIncomingCall(
  value: unknown,
  remainingRangeBudget: number,
): MappedCall<LanguageHostIncomingCall> | null {
  if (!(value instanceof vscode.CallHierarchyIncomingCall)) {
    return null;
  }
  const providerItem = mapCallItem(value.from);
  if (providerItem === null || !Array.isArray(value.fromRanges)) {
    return null;
  }
  const boundedRanges = mapCallSiteRanges(value.fromRanges, remainingRangeBudget);
  return {
    item: { from: providerItem, callSiteRanges: boundedRanges.items },
    inspectedRangeCount: boundedRanges.items.length,
    omittedRangeCount: boundedRanges.omittedCount,
  };
}

function mapOutgoingCall(
  value: unknown,
  remainingRangeBudget: number,
): MappedCall<LanguageHostOutgoingCall> | null {
  if (!(value instanceof vscode.CallHierarchyOutgoingCall)) {
    return null;
  }
  const providerItem = mapCallItem(value.to);
  if (providerItem === null || !Array.isArray(value.fromRanges)) {
    return null;
  }
  const boundedRanges = mapCallSiteRanges(value.fromRanges, remainingRangeBudget);
  return {
    item: { to: providerItem, callSiteRanges: boundedRanges.items },
    inspectedRangeCount: boundedRanges.items.length,
    omittedRangeCount: boundedRanges.omittedCount,
  };
}

function mapCallSiteRanges(
  ranges: readonly unknown[],
  remainingRangeBudget: number,
): BoundedProviderItems<LanguageHostRange | null> {
  const maximumRanges = Math.min(
    PROVIDER_OUTPUT_LIMITS.callHierarchy.callSiteRangesPerItemMax,
    remainingRangeBudget,
  );
  return snapshotBoundedProviderItems(ranges, maximumRanges, mapCallSiteRange);
}

function mapCallSiteRange(value: unknown): LanguageHostRange | null {
  return value instanceof vscode.Range ? wrapRange(value) : null;
}

function hasDeprecatedSymbolTag(
  tags: readonly vscode.SymbolTag[] | undefined,
): boolean {
  if (!Array.isArray(tags)) {
    return false;
  }
  const maximumTags = Math.min(tags.length, 8);
  for (let index = 0; index < maximumTags; index += 1) {
    if (tags[index] === vscode.SymbolTag.Deprecated) {
      return true;
    }
  }
  return false;
}

function wrapDocument(document: vscode.TextDocument): LanguageHostDocument {
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

function wrapRange(range: vscode.Range): LanguageHostRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? `SymbolKind${kind}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function currentWorkspaceAccess(
  isWorkspaceEnabled: VsCodeLanguageLocationToolServiceOptions['isWorkspaceEnabled'],
): Promise<LanguageLocationWorkspaceAccess> {
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
