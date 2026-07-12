import { PROTOCOL_LIMITS } from '@vscode-mcp/protocol/constants';
import {
  compareAndDeleteUnchangedRegistryRecord,
  discoverRegistryRecords,
  isRegistryRecordStale,
  resolveRuntimeRegistryPaths,
  type RegistryRecordSnapshot,
  type RuntimeRegistryEnvironment,
} from '@vscode-mcp/protocol/runtime-registry';
import {
  ToolExecutionErrorSchema,
  type ToolExecutionError,
} from '@vscode-mcp/protocol/schemas';
import type { ListInstancesResult } from '@vscode-mcp/protocol/tool-schemas';
import type { V1AllExtensionToolInvocation } from '@vscode-mcp/protocol/tool-schemas-v1';

import {
  callRegistryRecord,
  probeRegistryRecord,
  type AuthenticatedInstance,
  type InstanceProbeResult,
  type InstanceToolCallOptions,
  type InstanceToolCallResult,
} from './ipc-client.js';
import {
  createCanonicalPathStrategy,
  resolveInstance,
  type AuthenticatedInstanceCandidate,
  type CanonicalPathStrategy,
  type PinnedInstanceUpperBound,
} from './instance-selection.js';
import type { InstanceGateway, InstanceGatewayCallResult } from './sdk-adapter.js';

const PROBE_CONCURRENCY = 4;
const REPLACEMENT_CACHE_TTL_MS = 60_000;
const REPLACEMENT_CACHE_MAX_ENTRIES = 64;

interface RememberedInstanceIdentity {
  readonly workspaceKey: string;
  readonly observedAt: number;
}

export interface LocalInstanceRegistryOptions {
  readonly upperBound?: PinnedInstanceUpperBound;
  readonly canonicalCwd?: string | null;
  readonly pathStrategy?: CanonicalPathStrategy;
  readonly runtimeEnvironment?: RuntimeRegistryEnvironment;
  readonly now?: () => number;
  readonly probe?: (snapshot: RegistryRecordSnapshot) => Promise<InstanceProbeResult>;
  readonly callRecord?: (
    snapshot: RegistryRecordSnapshot,
    invocation: V1AllExtensionToolInvocation,
    options: InstanceToolCallOptions,
  ) => Promise<InstanceToolCallResult>;
}

interface DiscoveredAuthenticatedInstance {
  readonly snapshot: RegistryRecordSnapshot;
  readonly instance: AuthenticatedInstance;
  readonly candidate: AuthenticatedInstanceCandidate;
}

export class LocalInstanceRegistry implements InstanceGateway {
  readonly #upperBound: PinnedInstanceUpperBound;
  readonly #canonicalCwd: string | null;
  readonly #pathStrategy: CanonicalPathStrategy;
  readonly #runtimeEnvironment: RuntimeRegistryEnvironment | undefined;
  readonly #now: () => number;
  readonly #probe: (snapshot: RegistryRecordSnapshot) => Promise<InstanceProbeResult>;
  readonly #callRecord: (
    snapshot: RegistryRecordSnapshot,
    invocation: V1AllExtensionToolInvocation,
    options: InstanceToolCallOptions,
  ) => Promise<InstanceToolCallResult>;
  readonly #rememberedInstances = new Map<string, RememberedInstanceIdentity>();

  public constructor(options: LocalInstanceRegistryOptions = {}) {
    this.#upperBound = options.upperBound ?? { kind: 'unbounded' };
    this.#canonicalCwd = options.canonicalCwd ?? null;
    this.#pathStrategy =
      options.pathStrategy ??
      createCanonicalPathStrategy({ flavor: 'posix', caseSensitive: true });
    this.#runtimeEnvironment = options.runtimeEnvironment;
    this.#now = options.now ?? Date.now;
    this.#probe = options.probe ?? probeRegistryRecord;
    this.#callRecord = options.callRecord ?? callRegistryRecord;
  }

  public async list(): Promise<ListInstancesResult> {
    const discovered = await this.#discoverAuthenticated();
    this.#remember(discovered);
    const authenticated = discovered.map((entry) => entry.candidate);
    const resolution = resolveInstance({
      candidates: authenticated,
      upperBound: this.#upperBound,
      requestedInstanceId: null,
      canonicalCwd: this.#canonicalCwd,
      pathStrategy: this.#pathStrategy,
    });
    const visible = visibleCandidates(
      authenticated,
      this.#upperBound,
      resolution.resolution.candidateInstanceIds,
    );

    return {
      instances: visible.map((candidate) => candidate.safeDescriptor),
      resolution: {
        selectedInstanceId: resolution.resolution.selectedInstanceId,
        method: resolution.resolution.method,
        candidateInstanceIds: [...resolution.resolution.candidateInstanceIds],
      },
    };
  }

  public async call(
    invocation: V1AllExtensionToolInvocation,
    requestedInstanceId: string | null,
    signal: AbortSignal,
  ): Promise<InstanceGatewayCallResult> {
    if (signal.aborted) {
      return failed(cancellationError());
    }

    let discovered = await this.#discoverAuthenticated();
    for (
      let attempt = 1;
      discovered.length === 0 &&
      requestedInstanceId !== null &&
      !signal.aborted &&
      attempt < 3;
      attempt += 1
    ) {
      await releaseSettle();
      discovered = await this.#discoverAuthenticated();
    }
    this.#remember(discovered);
    if (signal.aborted) {
      return failed(cancellationError());
    }

    const resolution = resolveInstance({
      candidates: discovered.map((entry) => entry.candidate),
      upperBound: this.#upperBound,
      requestedInstanceId,
      canonicalCwd: this.#canonicalCwd,
      pathStrategy: this.#pathStrategy,
    });
    if (!resolution.ok) {
      const replacementInstanceId =
        resolution.errorCode === 'INSTANCE_NOT_FOUND' && requestedInstanceId !== null
          ? this.#replacementFor(requestedInstanceId, discovered)
          : null;
      return failed(selectionError(resolution.errorCode, replacementInstanceId));
    }

    const selected = discovered.find(
      (entry) =>
        entry.candidate.safeDescriptor.instanceId ===
        resolution.candidate.safeDescriptor.instanceId,
    );
    if (selected === undefined) {
      return failed(
        toolError(
          'INTERNAL_ERROR',
          'The selected VS Code instance could not be resolved.',
          false,
        ),
      );
    }

    let result: InstanceToolCallResult;
    try {
      result = await this.#callRecord(selected.snapshot, invocation, { signal });
      for (
        let attempt = 1;
        result.status === 'disconnected' &&
        retrySafeTool(invocation.tool) &&
        !signal.aborted &&
        attempt < 3;
        attempt += 1
      ) {
        await releaseSettle();
        result = await this.#callRecord(selected.snapshot, invocation, { signal });
      }
    } catch {
      return failed(
        signal.aborted
          ? cancellationError()
          : toolError(
              'INSTANCE_DISCONNECTED',
              'The selected VS Code instance disconnected.',
              true,
            ),
      );
    }

    if (result.status === 'completed') {
      if (
        result.instance.safeDescriptor.instanceId !==
        selected.instance.safeDescriptor.instanceId
      ) {
        return failed(
          toolError(
            'INSTANCE_DISCONNECTED',
            'The selected VS Code instance changed during the request.',
            true,
          ),
        );
      }

      return {
        status: 'completed',
        instanceId: result.instance.safeDescriptor.instanceId,
        result: result.result,
      };
    }

    if (signal.aborted) {
      return failed(cancellationError());
    }

    if (result.status === 'capabilityUnavailable') {
      return failed(
        toolError(
          'PROVIDER_UNAVAILABLE',
          'The selected VS Code instance does not advertise this tool.',
          false,
        ),
      );
    }

    return failed(
      toolError(
        'INSTANCE_DISCONNECTED',
        'The selected VS Code instance is no longer available.',
        true,
      ),
    );
  }

  async #discoverAuthenticated(): Promise<readonly DiscoveredAuthenticatedInstance[]> {
    const runtime = await resolveRuntimeRegistryPaths(this.#runtimeEnvironment);
    if (runtime.status !== 'ready') {
      return [];
    }

    const discovery = await discoverRegistryRecords(runtime.paths);
    if (discovery.status !== 'ready') {
      return [];
    }

    const authenticated: DiscoveredAuthenticatedInstance[] = [];
    for (let index = 0; index < discovery.records.length; index += PROBE_CONCURRENCY) {
      const batch = discovery.records.slice(index, index + PROBE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (snapshot) => ({
          snapshot,
          probe: await this.#probe(snapshot),
        })),
      );

      for (const result of results) {
        if (result.probe.status === 'authenticated') {
          authenticated.push({
            snapshot: result.snapshot,
            instance: result.probe.instance,
            candidate: toSelectionCandidate(result.probe.instance),
          });
          continue;
        }

        if (
          result.probe.status === 'rejected' &&
          isRegistryRecordStale(result.snapshot.record, this.#now())
        ) {
          await compareAndDeleteUnchangedRegistryRecord(runtime.paths, result.snapshot);
        }
      }
    }

    return authenticated;
  }

  #remember(discovered: readonly DiscoveredAuthenticatedInstance[]): void {
    this.#pruneRemembered();
    const observedAt = this.#now();
    for (const entry of discovered) {
      const instanceId = entry.candidate.safeDescriptor.instanceId;
      this.#rememberedInstances.delete(instanceId);
      this.#rememberedInstances.set(instanceId, {
        workspaceKey: workspaceIdentityKey(entry.candidate),
        observedAt,
      });
    }
    while (this.#rememberedInstances.size > REPLACEMENT_CACHE_MAX_ENTRIES) {
      const oldest = this.#rememberedInstances.keys().next().value;
      if (oldest === undefined) break;
      this.#rememberedInstances.delete(oldest);
    }
  }

  #replacementFor(
    requestedInstanceId: string,
    discovered: readonly DiscoveredAuthenticatedInstance[],
  ): string | null {
    this.#pruneRemembered();
    if (this.#upperBound.kind === 'instance') return null;
    const remembered = this.#rememberedInstances.get(requestedInstanceId);
    if (remembered === undefined) return null;

    let candidates = discovered.map((entry) => entry.candidate);
    if (this.#upperBound.kind === 'workspace') {
      const bounded = resolveInstance({
        candidates,
        upperBound: this.#upperBound,
        requestedInstanceId: null,
        canonicalCwd: this.#canonicalCwd,
        pathStrategy: this.#pathStrategy,
      });
      const allowed = new Set(bounded.resolution.candidateInstanceIds);
      candidates = candidates.filter((candidate) =>
        allowed.has(candidate.safeDescriptor.instanceId),
      );
    }

    const matches = candidates.filter(
      (candidate) =>
        candidate.safeDescriptor.instanceId !== requestedInstanceId &&
        workspaceIdentityKey(candidate) === remembered.workspaceKey,
    );
    return matches.length === 1 ? matches[0]!.safeDescriptor.instanceId : null;
  }

  #pruneRemembered(): void {
    const cutoff = this.#now() - REPLACEMENT_CACHE_TTL_MS;
    for (const [instanceId, remembered] of this.#rememberedInstances) {
      if (remembered.observedAt < cutoff) {
        this.#rememberedInstances.delete(instanceId);
      }
    }
  }
}

function retrySafeTool(tool: V1AllExtensionToolInvocation['tool']): boolean {
  return ![
    'apply_text_edits',
    'create_workspace_file',
    'move_workspace_file',
    'delete_workspace_file',
    'save_documents',
    'revert_documents',
    'rename_symbol',
    'format_document',
    'apply_code_action',
    'run_task',
    'terminate_task',
    'start_debugging',
    'stop_debugging',
  ].includes(tool);
}

function releaseSettle(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, PROTOCOL_LIMITS.sessionReleaseSettleMs),
  );
}

function toSelectionCandidate(
  instance: AuthenticatedInstance,
): AuthenticatedInstanceCandidate {
  return {
    safeDescriptor: instance.safeDescriptor,
    canonicalWorkspaceRoots: instance.canonicalWorkspaceRoots,
  };
}

function workspaceIdentityKey(candidate: AuthenticatedInstanceCandidate): string {
  return JSON.stringify({
    roots: [...candidate.canonicalWorkspaceRoots].sort(),
    workspaceFileUri: candidate.safeDescriptor.workspaceFileUri,
  });
}

function visibleCandidates(
  candidates: readonly AuthenticatedInstanceCandidate[],
  upperBound: PinnedInstanceUpperBound,
  scopedIds: readonly string[],
): readonly AuthenticatedInstanceCandidate[] {
  if (upperBound.kind === 'unbounded') {
    return candidates;
  }

  const allowed = new Set(scopedIds);
  return candidates.filter((candidate) =>
    allowed.has(candidate.safeDescriptor.instanceId),
  );
}

function failed(error: ToolExecutionError): InstanceGatewayCallResult {
  return { status: 'failed', error: ToolExecutionErrorSchema.parse(error) };
}

function selectionError(
  code: 'INVALID_ARGUMENT' | 'INSTANCE_NOT_FOUND' | 'INSTANCE_AMBIGUOUS',
  replacementInstanceId: string | null = null,
): ToolExecutionError {
  switch (code) {
    case 'INVALID_ARGUMENT':
      return toolError(
        code,
        'The requested instance is outside the bridge selection scope.',
        false,
      );
    case 'INSTANCE_AMBIGUOUS':
      return toolError(
        code,
        'More than one eligible VS Code instance matches this request.',
        false,
      );
    case 'INSTANCE_NOT_FOUND':
      return toolError(
        code,
        'No eligible VS Code instance matches this request.',
        true,
        replacementInstanceId === null ? undefined : { replacementInstanceId },
      );
  }
}

function cancellationError(): ToolExecutionError {
  return toolError('CANCELLED', 'The tool request was cancelled.', true);
}

function toolError(
  code: ToolExecutionError['code'],
  message: string,
  retryable: boolean,
  details?: ToolExecutionError['details'],
): ToolExecutionError {
  return ToolExecutionErrorSchema.parse({
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details }),
  });
}
