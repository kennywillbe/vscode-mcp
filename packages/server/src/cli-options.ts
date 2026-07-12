import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { InstanceIdSchema } from '@vscode-mcp/protocol/schemas';

import {
  createCanonicalPathStrategy,
  type CanonicalPathStrategy,
  type PinnedInstanceUpperBound,
} from './instance-selection.js';

export interface BridgeRuntimeOptions {
  readonly upperBound: PinnedInstanceUpperBound;
  readonly canonicalCwd: string | null;
  readonly pathStrategy: CanonicalPathStrategy;
}

export class BridgeConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BridgeConfigurationError';
  }
}

export async function resolveBridgeRuntimeOptions(
  arguments_: readonly string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<BridgeRuntimeOptions> {
  const selector = parseSelector(arguments_);
  const canonicalCwd = await canonicalizeOrNull(cwd);
  const pathStrategy = createCanonicalPathStrategy({
    flavor: platform === 'win32' ? 'win32' : 'posix',
    caseSensitive: platform !== 'win32',
  });

  if (selector.kind === 'workspace') {
    if (!isAbsolute(selector.path)) {
      throw new BridgeConfigurationError('--workspace requires an absolute path.');
    }
    const canonicalWorkspacePath = await canonicalizeOrThrow(selector.path);
    return {
      upperBound: { kind: 'workspace', canonicalWorkspacePath },
      canonicalCwd,
      pathStrategy,
    };
  }

  return {
    upperBound:
      selector.kind === 'instance'
        ? { kind: 'instance', instanceId: selector.instanceId }
        : { kind: 'unbounded' },
    canonicalCwd,
    pathStrategy,
  };
}

type ParsedSelector =
  | { readonly kind: 'unbounded' }
  | { readonly kind: 'instance'; readonly instanceId: string }
  | { readonly kind: 'workspace'; readonly path: string };

function parseSelector(arguments_: readonly string[]): ParsedSelector {
  let selector: ParsedSelector = { kind: 'unbounded' };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== '--instance' && argument !== '--workspace') {
      throw new BridgeConfigurationError('Unknown vscode-mcp bridge argument.');
    }
    if (selector.kind !== 'unbounded') {
      throw new BridgeConfigurationError('Only one bridge selector may be supplied.');
    }

    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new BridgeConfigurationError('Bridge selector value is missing.');
    }
    index += 1;

    selector =
      argument === '--instance'
        ? {
            kind: 'instance',
            instanceId: InstanceIdSchema.parse(value),
          }
        : { kind: 'workspace', path: value };
  }

  return selector;
}

async function canonicalizeOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function canonicalizeOrThrow(path: string): Promise<string> {
  const canonical = await canonicalizeOrNull(path);
  if (canonical === null) {
    throw new BridgeConfigurationError('The workspace selector cannot be resolved.');
  }
  return canonical;
}
