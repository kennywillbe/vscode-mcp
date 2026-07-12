import { Buffer } from 'node:buffer';

import { PROTOCOL_LIMITS } from '@vscode-mcp/protocol/constants';
import {
  IpcCallToolResultSchema,
  IpcToolSuccessSchema,
  type IpcCallToolResult,
} from '@vscode-mcp/protocol/ipc-schemas';
import type {
  FindReferencesResult,
  GetCallHierarchyResult,
  GetDiagnosticsResult,
  GetEditorContextResult,
  GetHoverResult,
  GetSignatureHelpResult,
  Warning,
} from '@vscode-mcp/protocol/tool-schemas';

/**
 * Leaves room for the bridge to add the public success envelope, instance ID, and
 * text fallback before enforcing the canonical 512 KiB MCP result ceiling.
 */
export const EXTENSION_SUCCESS_BUDGET_BYTES =
  PROTOCOL_LIMITS.mcpResultBytes - 12 * 1024;

const OUTPUT_LIMIT_WARNING_MESSAGE =
  'Some results were omitted to enforce the serialized output limit.';

type IpcToolSuccess = Extract<IpcCallToolResult, { outcome: 'success' }>;
type ExtensionToolName = IpcToolSuccess['payload']['tool'];

/**
 * Applies the final, tool-independent output budget before an extension result is
 * serialized onto IPC. Tool services still own their narrower contract limits.
 *
 * The drop order is deliberately visible here: optional nested provider data first,
 * then collection tails, then the smallest schema-valid representation. Every drop
 * is surfaced through the canonical RESULTS_TRUNCATED warning.
 */
export function hardenIpcToolSuccess(
  value: IpcToolSuccess,
  maximumBytes = EXTENSION_SUCCESS_BUDGET_BYTES,
): IpcCallToolResult {
  const success = IpcToolSuccessSchema.parse(value);
  if (serializedBytes(success) <= maximumBytes) {
    return success;
  }

  reduceToolResult(success, maximumBytes);

  const validated = IpcToolSuccessSchema.safeParse(success);
  if (validated.success && serializedBytes(validated.data) <= maximumBytes) {
    return validated.data;
  }

  return minimumOutputFailure(success.payload.tool);
}

function reduceToolResult(success: IpcToolSuccess, maximumBytes: number): void {
  switch (success.payload.tool) {
    case 'get_editor_context':
      reduceEditorContext(success, success.payload.result, maximumBytes);
      return;
    case 'read_document':
      // The contract's 256 KiB text ceiling keeps a valid read result below this
      // module's conservative budget. There is no semantically safe second crop.
      return;
    case 'get_diagnostics':
      reduceDiagnostics(success, success.payload.result, maximumBytes);
      return;
    case 'get_hover':
      reduceHover(success, success.payload.result, maximumBytes);
      return;
    case 'get_definition': {
      const result = success.payload.result;
      retainLargestPrefix(success, maximumBytes, result.locations, (locations) => {
        result.locations = locations;
      });
      return;
    }
    case 'find_references':
      reduceReferences(success, success.payload.result, maximumBytes);
      return;
    case 'get_document_symbols': {
      const result = success.payload.result;
      retainLargestPrefix(success, maximumBytes, result.symbols, (symbols) => {
        result.symbols = symbols;
      });
      return;
    }
    case 'search_workspace_symbols': {
      const result = success.payload.result;
      retainLargestPrefix(success, maximumBytes, result.symbols, (symbols) => {
        result.symbols = symbols;
      });
      return;
    }
    case 'get_signature_help':
      reduceSignatureHelp(success, success.payload.result, maximumBytes);
      return;
    case 'get_call_hierarchy':
      reduceCallHierarchy(success, success.payload.result, maximumBytes);
  }
}

function reduceEditorContext(
  success: IpcToolSuccess,
  result: GetEditorContextResult,
  maximumBytes: number,
): void {
  const originalTabOmissions = result.omitted.tabs;
  retainLargestPrefix(
    success,
    maximumBytes,
    result.tabs,
    (tabs) => {
      result.tabs = tabs;
    },
    (kept, total) => {
      result.omitted.tabs = originalTabOmissions + (total - kept);
    },
  );
  if (fits(success, maximumBytes)) {
    return;
  }

  const originalDocumentOmissions = result.omitted.documents;
  retainLargestPrefix(
    success,
    maximumBytes,
    result.openDocuments,
    (documents) => {
      result.openDocuments = documents;
    },
    (kept, total) => {
      result.omitted.documents = originalDocumentOmissions + (total - kept);
    },
  );
  if (fits(success, maximumBytes)) {
    return;
  }

  const originalEditorOmissions = result.omitted.editors;
  retainLargestPrefix(
    success,
    maximumBytes,
    result.visibleEditors,
    (editors) => {
      result.visibleEditors = editors;
    },
    (kept, total) => {
      result.omitted.editors = originalEditorOmissions + (total - kept);
    },
  );
  if (fits(success, maximumBytes) || result.activeEditor === null) {
    return;
  }

  result.activeEditor = null;
  result.omitted.editors += 1;
  addOutputOmissions(success, 1);
}

function reduceDiagnostics(
  success: IpcToolSuccess,
  result: GetDiagnosticsResult,
  maximumBytes: number,
): void {
  const documents = result.documents;
  let relatedInformationCount = 0;
  for (const document of documents) {
    for (const diagnostic of document.diagnostics) {
      relatedInformationCount += diagnostic.relatedInformation.length;
      diagnostic.relatedInformation = [];
    }
  }
  addOutputOmissions(success, relatedInformationCount);
  if (fits(success, maximumBytes)) {
    return;
  }

  const diagnosticGroups = documents.map((document) => [...document.diagnostics]);
  const diagnosticCount = diagnosticGroups.reduce(
    (total, diagnostics) => total + diagnostics.length,
    0,
  );
  retainLargestFlattenedPrefix(success, maximumBytes, diagnosticCount, (kept) => {
    let remaining = kept;
    for (const [index, document] of documents.entries()) {
      const group = diagnosticGroups[index] ?? [];
      const groupLength = Math.min(remaining, group.length);
      document.diagnostics = group.slice(0, groupLength);
      remaining -= groupLength;
    }
  });
  if (fits(success, maximumBytes)) {
    return;
  }

  retainLargestPrefix(success, maximumBytes, documents, (retainedDocuments) => {
    result.documents = retainedDocuments;
  });
}

function reduceHover(
  success: IpcToolSuccess,
  result: GetHoverResult,
  maximumBytes: number,
): void {
  const hovers = result.hovers;
  const contentGroups = hovers.map((hover) => [...hover.contents]);
  const contentCount = contentGroups.reduce(
    (total, contents) => total + contents.length,
    0,
  );
  retainLargestFlattenedPrefix(success, maximumBytes, contentCount, (kept) => {
    let remaining = kept;
    for (const [index, hover] of hovers.entries()) {
      const group = contentGroups[index] ?? [];
      const groupLength = Math.min(remaining, group.length);
      hover.contents = group.slice(0, groupLength);
      remaining -= groupLength;
    }
  });
  if (fits(success, maximumBytes)) {
    return;
  }

  retainLargestPrefix(success, maximumBytes, hovers, (retainedHovers) => {
    result.hovers = retainedHovers;
  });
}

function reduceReferences(
  success: IpcToolSuccess,
  result: FindReferencesResult,
  maximumBytes: number,
): void {
  const references = result.references;
  let contextCount = 0;
  for (const reference of references) {
    if (reference.context !== null) {
      reference.context = null;
      contextCount += 1;
    }
  }
  addOutputOmissions(success, contextCount);
  if (fits(success, maximumBytes)) {
    return;
  }

  retainLargestPrefix(success, maximumBytes, references, (retainedReferences) => {
    result.references = retainedReferences;
  });
}

function reduceSignatureHelp(
  success: IpcToolSuccess,
  result: GetSignatureHelpResult,
  maximumBytes: number,
): void {
  let documentationCount = 0;
  for (const signature of result.signatures) {
    if (signature.documentation !== null) {
      signature.documentation = null;
      documentationCount += 1;
    }
    for (const parameter of signature.parameters) {
      if (parameter.documentation !== null) {
        parameter.documentation = null;
        documentationCount += 1;
      }
    }
  }
  addOutputOmissions(success, documentationCount);
  if (fits(success, maximumBytes)) {
    return;
  }

  const originalActiveParameter = result.activeParameter;
  const parameterGroups = result.signatures.map((signature) => [
    ...signature.parameters,
  ]);
  const parameterCount = parameterGroups.reduce(
    (total, parameters) => total + parameters.length,
    0,
  );
  retainLargestFlattenedPrefix(success, maximumBytes, parameterCount, (kept) => {
    let remaining = kept;
    for (const [index, signature] of result.signatures.entries()) {
      const group = parameterGroups[index] ?? [];
      const groupLength = Math.min(remaining, group.length);
      signature.parameters = group.slice(0, groupLength);
      remaining -= groupLength;
    }
    if (
      result.activeSignature !== null &&
      originalActiveParameter !== null &&
      originalActiveParameter >=
        (result.signatures[result.activeSignature]?.parameters.length ?? 0)
    ) {
      result.activeParameter = null;
    } else {
      result.activeParameter = originalActiveParameter;
    }
  });
  if (fits(success, maximumBytes)) {
    return;
  }

  const originalActiveSignature = result.activeSignature;
  const retainedActiveParameter = result.activeParameter;
  retainLargestPrefix(success, maximumBytes, result.signatures, (signatures) => {
    result.signatures = signatures;
    if (
      originalActiveSignature !== null &&
      originalActiveSignature >= signatures.length
    ) {
      result.activeSignature = null;
      result.activeParameter = null;
    } else {
      result.activeSignature = originalActiveSignature;
      result.activeParameter = retainedActiveParameter;
    }
  });
}

function reduceCallHierarchy(
  success: IpcToolSuccess,
  result: GetCallHierarchyResult,
  maximumBytes: number,
): void {
  let callSiteRangeCount = 0;
  for (const call of result.incoming ?? []) {
    callSiteRangeCount += call.callSiteRanges.length;
    call.callSiteRanges = [];
  }
  for (const call of result.outgoing ?? []) {
    callSiteRangeCount += call.callSiteRanges.length;
    call.callSiteRanges = [];
  }
  addOutputOmissions(success, callSiteRangeCount);
  if (fits(success, maximumBytes)) {
    return;
  }

  if (result.outgoing !== null) {
    retainLargestPrefix(success, maximumBytes, result.outgoing, (calls) => {
      result.outgoing = calls;
    });
  }
  if (fits(success, maximumBytes)) {
    return;
  }

  if (result.incoming !== null) {
    retainLargestPrefix(success, maximumBytes, result.incoming, (calls) => {
      result.incoming = calls;
    });
  }
  if (fits(success, maximumBytes) || result.roots.length <= 1) {
    return;
  }

  const selectedRoot = result.roots[result.selectedRootIndex];
  if (selectedRoot !== undefined) {
    const omittedRoots = result.roots.length - 1;
    result.roots = [selectedRoot];
    result.selectedRootIndex = 0;
    addOutputOmissions(success, omittedRoots);
  }
}

function retainLargestFlattenedPrefix(
  success: IpcToolSuccess,
  maximumBytes: number,
  total: number,
  applyPrefix: (kept: number) => void,
): number {
  if (total === 0 || fits(success, maximumBytes)) {
    return total;
  }

  const baselineWarnings = cloneWarnings(success.warnings);
  const baselineTruncated = success.truncated;
  const applyCandidate = (kept: number): void => {
    applyPrefix(kept);
    success.warnings = mergeOutputWarning(baselineWarnings, total - kept);
    success.truncated = baselineTruncated || kept < total;
  };

  const kept = largestFittingPrefix(total, (candidate) => {
    applyCandidate(candidate);
    return fits(success, maximumBytes);
  });
  applyCandidate(kept);
  return kept;
}

function retainLargestPrefix<Item>(
  success: IpcToolSuccess,
  maximumBytes: number,
  items: readonly Item[],
  applyItems: (items: Item[]) => void,
  afterApply?: (kept: number, total: number) => void,
): number {
  const originals = [...items];
  return retainLargestFlattenedPrefix(
    success,
    maximumBytes,
    originals.length,
    (kept) => {
      applyItems(originals.slice(0, kept));
      afterApply?.(kept, originals.length);
    },
  );
}

function largestFittingPrefix(
  total: number,
  candidateFits: (kept: number) => boolean,
): number {
  let lower = 0;
  let upper = total;
  let best = 0;
  while (lower <= upper) {
    const candidate = lower + Math.floor((upper - lower) / 2);
    if (candidateFits(candidate)) {
      best = candidate;
      lower = candidate + 1;
    } else {
      upper = candidate - 1;
    }
  }
  return best;
}

function addOutputOmissions(success: IpcToolSuccess, count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    return;
  }
  success.warnings = mergeOutputWarning(success.warnings, count);
  success.truncated = true;
}

function mergeOutputWarning(
  warnings: readonly Warning[],
  omittedCount: number,
): Warning[] {
  if (omittedCount <= 0) {
    return cloneWarnings(warnings);
  }

  const merged = cloneWarnings(warnings);
  const existing = merged.find((warning) => warning.code === 'RESULTS_TRUNCATED');
  if (existing === undefined) {
    merged.unshift({
      code: 'RESULTS_TRUNCATED',
      message: OUTPUT_LIMIT_WARNING_MESSAGE,
      omittedCount,
    });
  } else {
    existing.message = OUTPUT_LIMIT_WARNING_MESSAGE;
    existing.omittedCount = safeCountSum(existing.omittedCount ?? 0, omittedCount);
  }
  return merged;
}

function cloneWarnings(warnings: readonly Warning[]): Warning[] {
  return warnings.map((warning) => ({ ...warning }));
}

function safeCountSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function minimumOutputFailure(tool: ExtensionToolName): IpcCallToolResult {
  return IpcCallToolResultSchema.parse({
    outcome: 'toolError',
    tool,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The minimum valid tool result exceeded the output limit.',
      retryable: false,
    },
  });
}

function fits(value: unknown, maximumBytes: number): boolean {
  return serializedBytes(value) <= maximumBytes;
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? Number.POSITIVE_INFINITY
    : Buffer.byteLength(serialized, 'utf8');
}
