import { posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { DocumentRef, ErrorCode } from '@vscode-mcp/protocol';

import type { WorkspaceIdentity } from './workspace-identity.js';

export type WorkspacePathFlavor = 'posix' | 'win32';

export interface WorkspaceAuthorizationPathStrategy {
  readonly flavor: WorkspacePathFlavor;
  readonly caseSensitive: boolean;
  readonly separator: string;
  isAbsolute(value: string): boolean;
  join(root: string, segments: readonly string[]): string;
  normalize(value: string): string;
  relative(from: string, to: string): string;
  relativeForContainment(from: string, to: string): string;
  fileUriToPath(uri: URL): string;
  pathToFileUri(path: string): string;
}

export function createWorkspaceAuthorizationPathStrategy(
  flavor: WorkspacePathFlavor,
): WorkspaceAuthorizationPathStrategy {
  const pathImplementation = flavor === 'posix' ? posix : win32;
  const caseSensitive = flavor === 'posix';

  const comparablePath = (value: string): string => {
    const normalized = pathImplementation.normalize(value);
    return caseSensitive ? normalized : normalized.toLowerCase();
  };

  return {
    flavor,
    caseSensitive,
    separator: pathImplementation.sep,
    isAbsolute(value: string): boolean {
      return pathImplementation.isAbsolute(value);
    },
    join(root: string, segments: readonly string[]): string {
      return pathImplementation.join(root, ...segments);
    },
    normalize(value: string): string {
      return pathImplementation.normalize(value);
    },
    relative(from: string, to: string): string {
      return pathImplementation.relative(from, to);
    },
    relativeForContainment(from: string, to: string): string {
      return pathImplementation.relative(comparablePath(from), comparablePath(to));
    },
    fileUriToPath(uri: URL): string {
      return fileURLToPath(uri, { windows: flavor === 'win32' });
    },
    pathToFileUri(path: string): string {
      return pathToFileURL(path, { windows: flavor === 'win32' }).href;
    },
  };
}

export type WorkspaceDocumentReference = DocumentRef | string;

export interface WorkspaceAuthorizerInput {
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly reference: WorkspaceDocumentReference;
  readonly realpath: (path: string) => Promise<string>;
  readonly pathStrategy: WorkspaceAuthorizationPathStrategy;
}

export interface AuthorizedWorkspaceDocument {
  readonly workspaceFolderId: string;
  readonly canonicalPath: string;
  /** Path relative to the owning canonical root, always using forward slashes. */
  readonly relativePath: string;
  /** Local request URI used to find a live VS Code buffer when one exists. */
  readonly uri: string;
}

export type WorkspaceAuthorizationErrorCode = Extract<
  ErrorCode,
  | 'INVALID_ARGUMENT'
  | 'WORKSPACE_FOLDER_NOT_FOUND'
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_OUTSIDE_WORKSPACE'
  | 'UNSUPPORTED_URI_SCHEME'
  | 'UNSUPPORTED_DOCUMENT'
  | 'INTERNAL_ERROR'
>;

export interface SuccessfulWorkspaceAuthorization {
  readonly ok: true;
  readonly document: AuthorizedWorkspaceDocument;
}

export interface FailedWorkspaceAuthorization {
  readonly ok: false;
  readonly errorCode: WorkspaceAuthorizationErrorCode;
}

export type WorkspaceAuthorizationResult =
  SuccessfulWorkspaceAuthorization | FailedWorkspaceAuthorization;

interface ResolvedReference {
  readonly ok: true;
  readonly requestPath: string;
  readonly uri: string;
  readonly requiredCanonicalRoot: string | null;
}

interface ContainingFolder {
  readonly workspaceFolderId: string;
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly distance: number;
}

/**
 * Resolves and authorizes a local document without depending on VS Code state.
 * Workspace identity roots must already be realpath-canonicalized; the target is
 * canonicalized through the injected function on every call.
 */
export async function authorizeWorkspaceDocument(
  input: WorkspaceAuthorizerInput,
): Promise<WorkspaceAuthorizationResult> {
  const resolvedReference = resolveReference(input);
  if (!resolvedReference.ok) {
    return resolvedReference;
  }

  let canonicalPath: string;
  try {
    canonicalPath = await input.realpath(resolvedReference.requestPath);
  } catch {
    return failure('DOCUMENT_NOT_FOUND');
  }

  if (canonicalPath.includes('\0') || !input.pathStrategy.isAbsolute(canonicalPath)) {
    return failure('INTERNAL_ERROR');
  }

  if (
    resolvedReference.requiredCanonicalRoot !== null &&
    containmentMatch(
      resolvedReference.requiredCanonicalRoot,
      canonicalPath,
      input.pathStrategy,
    ) === null
  ) {
    return failure('DOCUMENT_OUTSIDE_WORKSPACE');
  }

  const owner = deepestContainingFolder(
    input.workspaceIdentity,
    canonicalPath,
    input.pathStrategy,
  );
  if (owner === null) {
    return failure('DOCUMENT_OUTSIDE_WORKSPACE');
  }

  if (owner.relativePath.length === 0) {
    return failure('UNSUPPORTED_DOCUMENT');
  }

  return {
    ok: true,
    document: {
      workspaceFolderId: owner.workspaceFolderId,
      canonicalPath,
      relativePath: owner.relativePath,
      uri: resolvedReference.uri,
    },
  };
}

function resolveReference(
  input: WorkspaceAuthorizerInput,
): ResolvedReference | FailedWorkspaceAuthorization {
  if (typeof input.reference === 'string') {
    return resolveUri(input.reference, null, input.pathStrategy);
  }

  if (input.reference.kind === 'uri') {
    return resolveUri(input.reference.uri, null, input.pathStrategy);
  }

  return resolveWorkspacePath(input, input.reference);
}

function resolveWorkspacePath(
  input: WorkspaceAuthorizerInput,
  reference: Extract<DocumentRef, { kind: 'workspacePath' }>,
): ResolvedReference | FailedWorkspaceAuthorization {
  const folder = input.workspaceIdentity.folders.find(
    (candidate) => candidate.workspaceFolderId === reference.workspaceFolderId,
  );
  if (folder === undefined) {
    return failure('WORKSPACE_FOLDER_NOT_FOUND');
  }

  const segments = validWorkspaceRelativeSegments(reference.relativePath);
  if (segments === null) {
    return failure('INVALID_ARGUMENT');
  }

  const folderLocation = resolveLocalFileUri(folder.uri, input.pathStrategy);
  if (!folderLocation.ok) {
    return failure('INTERNAL_ERROR');
  }

  const requestPath = input.pathStrategy.join(folderLocation.path, segments);
  if (!input.pathStrategy.isAbsolute(requestPath)) {
    return failure('INTERNAL_ERROR');
  }

  let uri: string;
  try {
    uri = input.pathStrategy.pathToFileUri(requestPath);
  } catch {
    return failure('INTERNAL_ERROR');
  }

  return {
    ok: true,
    requestPath,
    uri,
    requiredCanonicalRoot: folder.canonicalPath,
  };
}

function resolveUri(
  uri: string,
  requiredCanonicalRoot: string | null,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): ResolvedReference | FailedWorkspaceAuthorization {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return failure('INVALID_ARGUMENT');
  }

  if (parsed.protocol !== 'file:') {
    return failure('UNSUPPORTED_URI_SCHEME');
  }

  const location = resolveLocalFileUrl(parsed, pathStrategy);
  if (!location.ok) {
    return location;
  }

  return {
    ok: true,
    requestPath: location.path,
    uri: parsed.href,
    requiredCanonicalRoot,
  };
}

function resolveLocalFileUri(
  uri: string,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): LocalFileLocation | FailedWorkspaceAuthorization {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return failure('INVALID_ARGUMENT');
  }

  if (parsed.protocol !== 'file:') {
    return failure('UNSUPPORTED_URI_SCHEME');
  }

  return resolveLocalFileUrl(parsed, pathStrategy);
}

interface LocalFileLocation {
  readonly ok: true;
  readonly path: string;
}

function resolveLocalFileUrl(
  uri: URL,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): LocalFileLocation | FailedWorkspaceAuthorization {
  if (
    (uri.hostname.length > 0 && uri.hostname !== 'localhost') ||
    uri.search.length > 0 ||
    uri.hash.length > 0
  ) {
    return failure('UNSUPPORTED_DOCUMENT');
  }

  let path: string;
  try {
    path = pathStrategy.fileUriToPath(uri);
  } catch {
    return failure('INVALID_ARGUMENT');
  }

  if (path.includes('\0') || !pathStrategy.isAbsolute(path)) {
    return failure('INVALID_ARGUMENT');
  }

  return { ok: true, path };
}

function validWorkspaceRelativeSegments(
  relativePath: string,
): readonly string[] | null {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    return null;
  }

  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return null;
  }

  return segments;
}

function deepestContainingFolder(
  identity: WorkspaceIdentity,
  canonicalTarget: string,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): ContainingFolder | null {
  let deepest: ContainingFolder | null = null;

  for (const folder of identity.folders) {
    const match = containmentMatch(folder.canonicalPath, canonicalTarget, pathStrategy);
    if (match === null) {
      continue;
    }

    const candidate: ContainingFolder = {
      workspaceFolderId: folder.workspaceFolderId,
      canonicalPath: folder.canonicalPath,
      relativePath: match.relativePath,
      distance: match.distance,
    };

    if (
      deepest === null ||
      candidate.distance < deepest.distance ||
      (candidate.distance === deepest.distance &&
        candidate.workspaceFolderId < deepest.workspaceFolderId)
    ) {
      deepest = candidate;
    }
  }

  return deepest;
}

interface ContainmentMatch {
  readonly relativePath: string;
  readonly distance: number;
}

function containmentMatch(
  canonicalRoot: string,
  canonicalTarget: string,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): ContainmentMatch | null {
  if (
    !pathStrategy.isAbsolute(canonicalRoot) ||
    !pathStrategy.isAbsolute(canonicalTarget)
  ) {
    return null;
  }

  const comparisonRelative = pathStrategy.relativeForContainment(
    canonicalRoot,
    canonicalTarget,
  );
  const comparisonSegments = containedSegments(comparisonRelative, pathStrategy);
  if (comparisonSegments === null) {
    return null;
  }

  const relativePath = relativePathPreservingCase(
    canonicalRoot,
    canonicalTarget,
    comparisonSegments.length,
    pathStrategy,
  );

  return {
    relativePath,
    distance: comparisonSegments.length,
  };
}

function containedSegments(
  relativePath: string,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): readonly string[] | null {
  if (relativePath.length === 0) {
    return [];
  }

  if (pathStrategy.isAbsolute(relativePath)) {
    return null;
  }

  const segments = relativePath
    .split(pathStrategy.separator)
    .filter((segment) => segment.length > 0 && segment !== '.');
  if (segments[0] === '..') {
    return null;
  }

  return segments;
}

function relativePathPreservingCase(
  canonicalRoot: string,
  canonicalTarget: string,
  distance: number,
  pathStrategy: WorkspaceAuthorizationPathStrategy,
): string {
  const directRelative = pathStrategy.relative(canonicalRoot, canonicalTarget);
  const directSegments = containedSegments(directRelative, pathStrategy);
  if (directSegments !== null && directSegments.length === distance) {
    return directSegments.join('/');
  }

  const targetSegments = pathStrategy
    .normalize(canonicalTarget)
    .split(pathStrategy.separator)
    .filter((segment) => segment.length > 0);
  return targetSegments.slice(-distance).join('/');
}

function failure(
  errorCode: WorkspaceAuthorizationErrorCode,
): FailedWorkspaceAuthorization {
  return { ok: false, errorCode };
}
