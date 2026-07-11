import { describe, expect, it } from 'vitest';

import {
  isSupportedRuntimePlatform,
  workspaceIneligibilityReason,
  type WorkspaceEligibilityEnvironment,
} from './workspace-eligibility.js';

const ELIGIBLE: WorkspaceEligibilityEnvironment = {
  platform: 'darwin',
  trusted: true,
  remoteName: undefined,
  desktop: true,
  snap: false,
  flatpak: false,
  workspaceFolderSchemes: ['file'],
};

describe('workspace eligibility', () => {
  it.each(['darwin', 'linux'] as const)(
    'accepts the supported local desktop platform %s',
    (platform) => {
      expect(workspaceIneligibilityReason({ ...ELIGIBLE, platform })).toBeUndefined();
      expect(isSupportedRuntimePlatform(platform)).toBe(true);
    },
  );

  it.each(['win32', 'freebsd'] as const)(
    'fails closed before publication on unsupported platform %s',
    (platform) => {
      expect(workspaceIneligibilityReason({ ...ELIGIBLE, platform })).toContain(
        'macOS and Linux only',
      );
      expect(isSupportedRuntimePlatform(platform)).toBe(false);
    },
  );

  it('rejects an untrusted workspace', () => {
    expect(workspaceIneligibilityReason({ ...ELIGIBLE, trusted: false })).toBe(
      'The workspace is not trusted.',
    );
  });

  it.each(['ssh-remote', 'wsl', 'dev-container', 'codespaces'])(
    'rejects the remote extension host %s',
    (remoteName) => {
      expect(workspaceIneligibilityReason({ ...ELIGIBLE, remoteName })).toContain(
        'Remote extension hosts',
      );
    },
  );

  it('rejects VS Code for the Web', () => {
    expect(workspaceIneligibilityReason({ ...ELIGIBLE, desktop: false })).toContain(
      'VS Code for the Web',
    );
  });

  it.each([
    { snap: true, flatpak: false },
    { snap: false, flatpak: true },
    { snap: true, flatpak: true },
  ])('rejects sandboxed distributions %#', ({ snap, flatpak }) => {
    expect(workspaceIneligibilityReason({ ...ELIGIBLE, snap, flatpak })).toContain(
      'Sandboxed VS Code distributions',
    );
  });

  it.each([undefined, []] as const)(
    'rejects an absent local workspace %#',
    (schemes) => {
      expect(
        workspaceIneligibilityReason({
          ...ELIGIBLE,
          workspaceFolderSchemes: schemes,
        }),
      ).toBe('Open a local folder or workspace first.');
    },
  );

  it.each([
    { schemes: ['untitled'] },
    { schemes: ['vscode-remote'] },
    { schemes: ['memfs'] },
    { schemes: ['file', 'vscode-remote'] },
  ])('rejects unsupported or mixed workspace schemes $schemes', ({ schemes }) => {
    expect(
      workspaceIneligibilityReason({
        ...ELIGIBLE,
        workspaceFolderSchemes: schemes,
      }),
    ).toContain('Virtual and mixed-scheme workspaces');
  });
});
