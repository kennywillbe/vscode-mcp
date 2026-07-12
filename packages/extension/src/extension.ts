import process from 'node:process';

import { IPC_PROTOCOL_VERSION } from '@vscode-mcp/protocol/constants';
import { getDefaultRuntimeRegistryEnvironment } from '@vscode-mcp/protocol/runtime-registry';
import { V1_ALL_EXTENSION_TOOL_NAMES } from '@vscode-mcp/protocol/tool-schemas-v1';
import * as vscode from 'vscode';

import {
  CapabilityGrantController,
  type PrivilegedCapability,
} from './capability-grant-controller.js';
import {
  applyCodexConfigPlan,
  codexConfigPath,
  createCodexManagedBlock,
  createGenericMcpConfig,
  findCompatibleNodes,
  inspectNodeExecutable,
  installBundledServer,
  planCodexConfigRemoval,
  planCodexConfigUpdate,
  readCodexConfig,
  removeInstalledServers,
  type CompatibleNode,
} from './client-setup.js';
import type { ExtensionToolRouter } from './extension-tool-router.js';
import {
  IpcInstanceService,
  type IpcInstanceServiceStartResult,
} from './ipc-instance-service.js';
import { createVsCodeExtensionToolRouter } from './vscode-extension-tool-router.js';
import { VsCodeV1Runtime } from './vscode-v1-runtime.js';
import {
  createWorkspaceIdentity,
  type WorkspaceIdentity,
} from './workspace-identity.js';
import {
  isSupportedRuntimePlatform,
  workspaceIneligibilityReason,
} from './workspace-eligibility.js';

const ENABLED_KEY_PREFIX = 'workspaceEnabled:';
const SETUP_PROMPT_KEY_PREFIX = 'clientSetupPrompted:';

interface Eligibility {
  eligible: boolean;
  reason?: string;
  identity?: WorkspaceIdentity;
}

class ExtensionController implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #grants = new CapabilityGrantController();
  readonly #statusBar: vscode.StatusBarItem;
  readonly #toolRouter: ExtensionToolRouter;
  readonly #disposables: vscode.Disposable[] = [];
  #service: IpcInstanceService | undefined;
  #runtime: VsCodeV1Runtime | undefined;
  #serviceFingerprint: string | undefined;
  #serviceFolderKey: string | undefined;
  #serviceStartResult: IpcInstanceServiceStartResult | undefined;
  #refreshTail: Promise<void> = Promise.resolve();
  #statusDetail = 'VS Code MCP is starting.';
  #disposed = false;
  #shutdownOperation: Promise<void> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
    this.#toolRouter = createVsCodeExtensionToolRouter({
      isWorkspaceEnabled: (fingerprint) =>
        this.#context.globalState.get<boolean>(enabledKey(fingerprint), false),
    });
    this.#statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      10,
    );
    this.#statusBar.command = 'vscode-mcp.showStatus';
    this.#statusBar.name = 'VS Code MCP';
    this.#statusBar.show();

    this.#disposables.push(
      this.#statusBar,
      vscode.commands.registerCommand('vscode-mcp.enable', () => this.enable()),
      vscode.commands.registerCommand('vscode-mcp.disable', () => this.disable()),
      vscode.commands.registerCommand('vscode-mcp.enableWrites', () =>
        this.enableCapability('write'),
      ),
      vscode.commands.registerCommand('vscode-mcp.disableWrites', () =>
        this.disableCapability('write'),
      ),
      vscode.commands.registerCommand('vscode-mcp.enableExecution', () =>
        this.enableCapability('execution'),
      ),
      vscode.commands.registerCommand('vscode-mcp.disableExecution', () =>
        this.disableCapability('execution'),
      ),
      vscode.commands.registerCommand('vscode-mcp.showStatus', () => this.showStatus()),
      vscode.commands.registerCommand('vscode-mcp.setupClient', () =>
        this.setupClient(false),
      ),
      vscode.commands.registerCommand('vscode-mcp.repairClient', () =>
        this.setupClient(true),
      ),
      vscode.commands.registerCommand('vscode-mcp.removeClient', () =>
        this.removeClient(),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.refresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.refresh();
      }),
    );
  }

  async start(): Promise<void> {
    await this.refresh();
    void this.promptForClientSetup().catch((error: unknown) => {
      void vscode.window.showErrorMessage(setupErrorMessage(error));
    });
  }

  dispose(): void {
    void this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownOperation !== undefined) {
      await this.#shutdownOperation;
      return;
    }

    const operation = this.performShutdown();
    this.#shutdownOperation = operation;
    await operation;
  }

  private async enable(): Promise<void> {
    const eligibility = await evaluateWorkspace();
    if (!eligibility.eligible || !eligibility.identity) {
      void vscode.window.showErrorMessage(
        eligibility.reason ?? 'This workspace is not eligible for MCP access.',
      );
      return;
    }

    await this.#context.globalState.update(
      enabledKey(eligibility.identity.fingerprint),
      true,
    );
    await this.refresh();
    void vscode.window.showInformationMessage(
      `VS Code MCP enabled for ${eligibility.identity.displayName}.`,
    );
  }

  private async disable(): Promise<void> {
    this.#grants.revokeAll();
    const eligibility = await evaluateWorkspace();
    if (eligibility.identity) {
      await this.#context.globalState.update(
        enabledKey(eligibility.identity.fingerprint),
        false,
      );
    }
    await this.refresh();
    void vscode.window.showInformationMessage(
      'VS Code MCP is disabled for this workspace.',
    );
  }

  private async enableCapability(capability: PrivilegedCapability): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.refresh();
      const eligibility = await evaluateWorkspace();
      const enabled =
        eligibility.eligible &&
        eligibility.identity !== undefined &&
        this.#context.globalState.get<boolean>(
          enabledKey(eligibility.identity.fingerprint),
          false,
        );
      if (
        enabled &&
        this.#serviceStartResult?.status === 'ready' &&
        this.#serviceFingerprint === eligibility.identity?.fingerprint
      ) {
        this.#grants.grant(capability);
        this.updateStatus(eligibility, true);
        void vscode.window.showInformationMessage(
          `VS Code MCP ${capability} access enabled for this extension session.`,
        );
        return;
      }
      if (!enabled) break;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    void vscode.window.showErrorMessage(
      'Enable VS Code MCP for this trusted workspace before granting privileged access.',
    );
  }

  private async disableCapability(capability: PrivilegedCapability): Promise<void> {
    this.#grants.revoke(capability);
    this.#runtime?.handleCapabilityRevoked(capability);
    await this.refresh();
    void vscode.window.showInformationMessage(
      `VS Code MCP ${capability} access revoked.`,
    );
  }

  private async showStatus(): Promise<void> {
    await this.refresh();
    void vscode.window.showInformationMessage(this.#statusDetail);
  }

  private async promptForClientSetup(): Promise<void> {
    const version = extensionVersion(this.#context);
    const key = `${SETUP_PROMPT_KEY_PREFIX}${version}`;
    if (
      this.#context.extensionMode !== vscode.ExtensionMode.Production ||
      this.#context.globalState.get<boolean>(key, false) ||
      !isSupportedRuntimePlatform(process.platform) ||
      vscode.env.uiKind !== vscode.UIKind.Desktop ||
      vscode.env.remoteName !== undefined
    ) {
      return;
    }
    await this.#context.globalState.update(key, true);
    const action = await vscode.window.showInformationMessage(
      'VS Code MCP is installed. Set up a local MCP client connection now?',
      'Set Up MCP Client',
    );
    if (action === 'Set Up MCP Client') await this.setupClient(false);
  }

  private async setupClient(repair: boolean): Promise<void> {
    try {
      if (!isSupportedRuntimePlatform(process.platform)) {
        throw new Error('Client setup currently supports macOS and Linux only.');
      }
      const node = await this.selectNode();
      if (node === undefined) return;
      const serverPath = await installBundledServer({
        bundleDirectory: vscode.Uri.joinPath(this.#context.extensionUri, 'server')
          .fsPath,
        storageDirectory: this.#context.globalStorageUri.fsPath,
        extensionVersion: extensionVersion(this.#context),
      });
      const target = repair
        ? 'codex'
        : await vscode.window
            .showQuickPick(
              [
                {
                  label: 'Codex — install automatically',
                  description: 'Recommended',
                  value: 'codex',
                },
                {
                  label: 'Codex — copy TOML only',
                  description: 'Do not edit config.toml',
                  value: 'codex-copy',
                },
                {
                  label: 'Generic MCP client — copy JSON',
                  description: 'For clients using mcpServers JSON',
                  value: 'generic-copy',
                },
              ] as const,
              { placeHolder: 'Choose the MCP client setup target' },
            )
            .then((item) => item?.value);
      if (target === undefined) return;

      if (target === 'generic-copy') {
        await vscode.env.clipboard.writeText(
          createGenericMcpConfig(node.executable, serverPath),
        );
        void vscode.window.showInformationMessage(
          'Generic vscode-mcp JSON copied. Paste it into your MCP client configuration.',
        );
        return;
      }

      const managedBlock = createCodexManagedBlock(node.executable, serverPath);
      if (target === 'codex-copy') {
        await vscode.env.clipboard.writeText(`${managedBlock}\n`);
        void vscode.window.showInformationMessage(
          'Codex vscode-mcp TOML copied. Paste it into ~/.codex/config.toml.',
        );
        return;
      }

      const configPath = codexConfigPath(process.env);
      const previous = await readCodexConfig(configPath);
      const plan = planCodexConfigUpdate(previous, managedBlock);
      const preview = await vscode.workspace.openTextDocument({
        content: `${managedBlock}\n`,
        language: 'toml',
      });
      await vscode.window.showTextDocument(preview, { preview: true });
      const action = await vscode.window.showWarningMessage(
        `Install the reviewed vscode-mcp block in ${configPath}? Existing content is preserved and backed up.`,
        { modal: true },
        repair ? 'Repair' : 'Install',
      );
      if (action === undefined) return;
      const backup = await applyCodexConfigPlan(configPath, plan);
      const enable = await vscode.window.showInformationMessage(
        `Codex integration is ready with Node ${node.version}.${backup === undefined ? '' : ' A config backup was created.'} Restart Codex to load it.`,
        'Enable This Workspace',
      );
      if (enable === 'Enable This Workspace') await this.enable();
    } catch (error) {
      void vscode.window.showErrorMessage(setupErrorMessage(error));
    }
  }

  private async removeClient(): Promise<void> {
    try {
      const configPath = codexConfigPath(process.env);
      const previous = await readCodexConfig(configPath);
      const plan = planCodexConfigRemoval(previous);
      const action = await vscode.window.showWarningMessage(
        plan.status === 'unchanged'
          ? 'No extension-managed Codex block was found. Remove only the installed server bundle?'
          : `Remove the extension-managed Codex block from ${configPath} and delete the installed server bundle?`,
        { modal: true },
        'Remove',
      );
      if (action === undefined) return;
      await applyCodexConfigPlan(configPath, plan);
      await removeInstalledServers(this.#context.globalStorageUri.fsPath);
      void vscode.window.showInformationMessage(
        'VS Code MCP client integration removed. Restart the MCP client.',
      );
    } catch (error) {
      void vscode.window.showErrorMessage(setupErrorMessage(error));
    }
  }

  private async selectNode(): Promise<CompatibleNode | undefined> {
    const detected = await findCompatibleNodes(process.env);
    if (detected.length === 1) return detected[0];
    if (detected.length > 1) {
      return await vscode.window
        .showQuickPick(
          detected.map((node) => ({
            label: `Node ${node.version}`,
            description: node.executable,
            node,
          })),
          { placeHolder: 'Select the Node.js 22 runtime for vscode-mcp' },
        )
        .then((item) => item?.node);
    }

    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select Node.js 22 executable',
    });
    const selected = selection?.[0];
    if (selected === undefined) return undefined;
    const node = await inspectNodeExecutable(selected.fsPath);
    if (node === undefined) {
      throw new Error('Selected executable is not Node.js 22.13.0 or newer.');
    }
    return node;
  }

  private refresh(): Promise<void> {
    const operation = this.#refreshTail.then(
      () => this.performRefresh(),
      () => this.performRefresh(),
    );
    this.#refreshTail = operation.catch(() => undefined);
    return operation;
  }

  private async performRefresh(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    const eligibility = await evaluateWorkspace();
    if (this.#disposed) {
      return;
    }
    const enabled =
      eligibility.identity !== undefined &&
      this.#context.globalState.get<boolean>(
        enabledKey(eligibility.identity.fingerprint),
        false,
      );
    const shouldRun =
      eligibility.eligible && eligibility.identity !== undefined && enabled;
    const nextFingerprint = eligibility.identity?.fingerprint;

    if (
      this.#service !== undefined &&
      (!shouldRun || this.#serviceFingerprint !== nextFingerprint)
    ) {
      this.#grants.revokeAll();
      const previous = this.#service;
      const previousRuntime = this.#runtime;
      this.#service = undefined;
      this.#runtime = undefined;
      this.#serviceFingerprint = undefined;
      this.#serviceFolderKey = undefined;
      this.#serviceStartResult = undefined;
      previousRuntime?.dispose();
      await previous.stop();
    }

    if (
      shouldRun &&
      eligibility.identity !== undefined &&
      this.#service === undefined
    ) {
      const identity = eligibility.identity;
      const folderKey = currentFolderKey();
      const service = new IpcInstanceService({
        identity: {
          extensionVersion: extensionVersion(this.#context),
          displayName: identity.displayName,
          workspaceFingerprint: identity.fingerprint,
          workspaceFileUri: identity.workspaceFileUri,
          workspaceFolders: identity.folders,
        },
        runtimeEnvironment: getDefaultRuntimeRegistryEnvironment(),
        isEligible: () => this.isServiceEligible(identity.fingerprint, folderKey),
        extensionTools: V1_ALL_EXTENSION_TOOL_NAMES,
        callTool: async (invocation, signal) => {
          const runtime = this.#runtime;
          if (runtime !== undefined) {
            return runtime.callTool(invocation, signal);
          }
          return this.#toolRouter.callTool(invocation, signal);
        },
        onUnexpectedStop: () => {
          void this.recoverUnexpectedServiceStop(service);
        },
      });
      this.#service = service;
      this.#serviceFingerprint = identity.fingerprint;
      this.#serviceFolderKey = folderKey;
      this.#serviceStartResult = await service.start();
      if (this.#serviceStartResult.status === 'ready') {
        this.#runtime = new VsCodeV1Runtime({
          instanceId: this.#serviceStartResult.instanceId,
          legacy: this.#toolRouter,
          grants: this.#grants,
          isWorkspaceEnabled: (fingerprint) =>
            this.#context.globalState.get<boolean>(enabledKey(fingerprint), false),
        });
      }
      if (this.#serviceStartResult.status !== 'ready') {
        await service.stop();
        if (this.#service === service) {
          this.#service = undefined;
          this.#serviceFingerprint = undefined;
          this.#serviceFolderKey = undefined;
        }
      }
    }

    this.updateStatus(eligibility, enabled === true);
  }

  private async recoverUnexpectedServiceStop(
    service: IpcInstanceService,
  ): Promise<void> {
    if (this.#disposed || this.#service !== service) {
      return;
    }
    this.#grants.revokeAll();
    this.#runtime?.dispose();
    this.#service = undefined;
    this.#runtime = undefined;
    this.#serviceFingerprint = undefined;
    this.#serviceFolderKey = undefined;
    this.#serviceStartResult = undefined;
    await this.refresh();
  }

  private updateStatus(eligibility: Eligibility, enabled: boolean): void {
    const status = statusFor(
      eligibility,
      enabled,
      this.#serviceStartResult,
      this.#grants.snapshot(),
    );
    this.#statusBar.text = status.text;
    this.#statusBar.tooltip = status.detail;
    this.#statusDetail = status.detail;
  }

  private isServiceEligible(fingerprint: string, folderKey: string): boolean {
    return (
      !this.#disposed &&
      isSupportedRuntimePlatform(process.platform) &&
      vscode.workspace.isTrusted &&
      vscode.env.remoteName === undefined &&
      vscode.env.uiKind === vscode.UIKind.Desktop &&
      process.env['SNAP'] === undefined &&
      process.env['FLATPAK_ID'] === undefined &&
      currentFolderKey() === folderKey &&
      this.#serviceFingerprint === fingerprint &&
      this.#serviceFolderKey === folderKey &&
      this.#context.globalState.get<boolean>(enabledKey(fingerprint), false)
    );
  }

  private async performShutdown(): Promise<void> {
    this.#disposed = true;
    this.#grants.dispose();
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
    await this.#refreshTail.catch(() => undefined);
    const service = this.#service;
    const runtime = this.#runtime;
    this.#service = undefined;
    this.#runtime = undefined;
    this.#serviceFingerprint = undefined;
    this.#serviceFolderKey = undefined;
    this.#serviceStartResult = undefined;
    runtime?.dispose();
    if (service !== undefined) {
      await service.stop();
    }
  }
}

function statusFor(
  eligibility: Eligibility,
  enabled: boolean,
  serviceStartResult: IpcInstanceServiceStartResult | undefined,
  grants: { readonly write: boolean; readonly execution: boolean },
): { text: string; detail: string } {
  if (!eligibility.eligible || !eligibility.identity) {
    return {
      text: '$(shield) MCP: unavailable',
      detail: eligibility.reason ?? 'This workspace is not eligible.',
    };
  }
  if (!enabled) {
    return {
      text: '$(circle-slash) MCP: disabled',
      detail: `Disabled for ${eligibility.identity.displayName}.`,
    };
  }
  if (serviceStartResult?.status === 'ready') {
    const privileges = [
      grants.write ? 'write' : null,
      grants.execution ? 'execution' : null,
    ].filter((value): value is string => value !== null);
    return {
      text:
        privileges.length === 0
          ? '$(shield) MCP: read'
          : `$(shield) MCP: read+${privileges.join('+')}`,
      detail: `Ready for ${eligibility.identity.displayName}; read enabled; write ${grants.write ? 'enabled' : 'disabled'}; execution ${grants.execution ? 'enabled' : 'disabled'}; IPC protocol ${IPC_PROTOCOL_VERSION}.`,
    };
  }

  return {
    text: '$(warning) MCP: unavailable',
    detail:
      serviceStartResult?.status === 'unavailable'
        ? `Enabled, but secure local IPC is unavailable (${serviceStartResult.reason}).`
        : 'Enabled, but the secure local IPC listener did not start.',
  };
}

function currentFolderKey(): string {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => `${folder.uri.scheme}\0${folder.uri.toString()}`)
    .sort(compareCodeUnits)
    .join('\0');
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const packageJson: unknown = context.extension.packageJSON;
  if (
    typeof packageJson === 'object' &&
    packageJson !== null &&
    'version' in packageJson &&
    typeof packageJson.version === 'string'
  ) {
    return packageJson.version;
  }
  return '0.0.0';
}

function setupErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'Unknown setup failure.';
  return `VS Code MCP client setup failed: ${detail}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function enabledKey(fingerprint: string): string {
  return `${ENABLED_KEY_PREFIX}${fingerprint}`;
}

async function evaluateWorkspace(): Promise<Eligibility> {
  const folders = vscode.workspace.workspaceFolders;
  const reason = workspaceIneligibilityReason({
    platform: process.platform,
    trusted: vscode.workspace.isTrusted,
    remoteName: vscode.env.remoteName,
    desktop: vscode.env.uiKind === vscode.UIKind.Desktop,
    snap: process.env['SNAP'] !== undefined,
    flatpak: process.env['FLATPAK_ID'] !== undefined,
    workspaceFolderSchemes: folders?.map((folder) => folder.uri.scheme),
  });
  if (reason !== undefined || folders === undefined || folders.length === 0) {
    return {
      eligible: false,
      reason: reason ?? 'Open a local folder or workspace first.',
    };
  }

  return {
    eligible: true,
    identity: await createWorkspaceIdentity({
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
    }),
  };
}

let activeController: ExtensionController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new ExtensionController(context);
  activeController = controller;
  context.subscriptions.push(controller);
  await controller.start();
}

export async function deactivate(): Promise<void> {
  const controller = activeController;
  activeController = undefined;
  await controller?.shutdown();
}
