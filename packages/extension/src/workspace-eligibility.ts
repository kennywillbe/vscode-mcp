export interface WorkspaceEligibilityEnvironment {
  readonly platform: NodeJS.Platform;
  readonly trusted: boolean;
  readonly remoteName: string | undefined;
  readonly desktop: boolean;
  readonly snap: boolean;
  readonly flatpak: boolean;
  readonly workspaceFolderSchemes: readonly string[] | undefined;
}

/**
 * Returns the user-facing reason that a VS Code window cannot publish local MCP IPC.
 *
 * Keep this decision independent from the VS Code module so every fail-closed branch
 * can be exercised without pretending that a synthetic remote/web host is a supported
 * runtime. The extension-host suite separately proves the eligible desktop path and
 * enable/disable lifecycle.
 */
export function workspaceIneligibilityReason(
  environment: WorkspaceEligibilityEnvironment,
): string | undefined {
  if (environment.platform !== 'darwin' && environment.platform !== 'linux') {
    return 'vscode-mcp 1.0 supports local VS Code Desktop on macOS and Linux only.';
  }

  if (!environment.trusted) {
    return 'The workspace is not trusted.';
  }

  if (environment.remoteName !== undefined) {
    return 'Remote extension hosts are not supported in vscode-mcp 1.0.';
  }

  if (!environment.desktop) {
    return 'VS Code for the Web is not supported in vscode-mcp 1.0.';
  }

  if (environment.snap || environment.flatpak) {
    return 'Sandboxed VS Code distributions are not supported in vscode-mcp 1.0.';
  }

  const schemes = environment.workspaceFolderSchemes;
  if (schemes === undefined || schemes.length === 0) {
    return 'Open a local folder or workspace first.';
  }

  if (schemes.some((scheme) => scheme !== 'file')) {
    return 'Virtual and mixed-scheme workspaces are not supported in vscode-mcp 1.0.';
  }

  return undefined;
}

export function isSupportedRuntimePlatform(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}
