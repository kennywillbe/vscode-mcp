import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FORBIDDEN_RUNTIME_MODULES = new Set([
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'http',
  'http2',
  'https',
  'tls',
  'worker_threads',
  'node:child_process',
  'node:cluster',
  'node:dgram',
  'node:dns',
  'node:http',
  'node:http2',
  'node:https',
  'node:tls',
  'node:worker_threads',
  'eventsource',
  'ws',
]);

const FILE_MUTATION_IMPORTS = new Set([
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'createWriteStream',
  'mkdir',
  'mkdtemp',
  'rename',
  'rm',
  'rmdir',
  'truncate',
  'unlink',
  'writeFile',
]);

const APPROVED_INFRASTRUCTURE_MUTATION_FILES = new Set([
  'packages/extension/src/client-setup.ts',
  'packages/extension/src/ipc-instance-service.ts',
  'packages/extension/src/vscode-v1-ide-tool-service.ts',
  'packages/protocol/src/runtime-registry.ts',
]);

const APPROVED_CHILD_PROCESS_FILES = new Set([
  'packages/extension/src/client-setup.ts',
]);

const APPROVED_IDE_MUTATION_FILES = new Set([
  'packages/extension/src/vscode-v1-ide-tool-service.ts',
]);

const APPROVED_NET_FILES = new Set([
  'packages/extension/src/ipc-instance-service.ts',
  'packages/server/src/ipc-client.ts',
]);

const APPROVED_PROVIDER_COMMANDS = [
  'vscode.executeCodeActionProvider',
  'vscode.executeCompletionItemProvider',
  'vscode.executeDeclarationProvider',
  'vscode.executeDefinitionProvider',
  'vscode.executeDocumentHighlights',
  'vscode.executeDocumentRenameProvider',
  'vscode.executeDocumentSymbolProvider',
  'vscode.executeFoldingRangeProvider',
  'vscode.executeFormatDocumentProvider',
  'vscode.executeFormatRangeProvider',
  'vscode.executeHoverProvider',
  'vscode.executeImplementationProvider',
  'vscode.executeInlayHintProvider',
  'vscode.executeLinkProvider',
  'vscode.executeReferenceProvider',
  'vscode.executeSelectionRangeProvider',
  'vscode.executeSignatureHelpProvider',
  'vscode.executeTypeDefinitionProvider',
  'vscode.executeWorkspaceSymbolProvider',
  'vscode.prepareCallHierarchy',
  'vscode.prepareTypeHierarchy',
  'vscode.provideIncomingCalls',
  'vscode.provideOutgoingCalls',
  'vscode.provideSubtypes',
  'vscode.provideSupertypes',
] as const;

const APPROVED_EXECUTE_COMMAND_ARGUMENTS = new Set([
  'DEFINITION_COMMANDS[kind]',
  'DOCUMENT_SYMBOL_COMMAND',
  'INCOMING_CALLS_COMMAND',
  'OUTGOING_CALLS_COMMAND',
  'PREPARE_CALL_HIERARCHY_COMMAND',
  'REFERENCE_COMMAND',
  'VSCODE_LANGUAGE_PROVIDER_COMMANDS.hover',
  'VSCODE_LANGUAGE_PROVIDER_COMMANDS.signatureHelp',
  'WORKSPACE_SYMBOL_COMMAND',
  "'vscode.executeCodeActionProvider'",
  "'vscode.executeCompletionItemProvider'",
  "'vscode.executeDocumentHighlights'",
  "'vscode.executeDocumentRenameProvider'",
  "'vscode.executeFoldingRangeProvider'",
  "'vscode.executeFormatDocumentProvider'",
  "'vscode.executeFormatRangeProvider'",
  "'vscode.executeInlayHintProvider'",
  "'vscode.executeLinkProvider'",
  "'vscode.executeSelectionRangeProvider'",
  "'vscode.prepareTypeHierarchy'",
  "'vscode.provideSubtypes'",
  "'vscode.provideSupertypes'",
]);

const APPROVED_EXTENSION_COMMANDS = [
  'vscode-mcp.disable',
  'vscode-mcp.disableExecution',
  'vscode-mcp.disableWrites',
  'vscode-mcp.enable',
  'vscode-mcp.enableExecution',
  'vscode-mcp.enableWrites',
  'vscode-mcp.removeClient',
  'vscode-mcp.repairClient',
  'vscode-mcp.setupClient',
  'vscode-mcp.showStatus',
] as const;

const FORBIDDEN_VSCODE_MUTATION_SURFACES = [
  'vscode.workspace.applyEdit',
  'vscode.workspace.fs.writeFile',
  'vscode.workspace.fs.delete',
  'vscode.workspace.fs.rename',
  'vscode.workspace.fs.copy',
  'vscode.window.createTerminal',
  'vscode.tasks.executeTask',
  'vscode.debug.startDebugging',
] as const;

interface SourceUnit {
  readonly relativePath: string;
  readonly sourceFile: ts.SourceFile;
  readonly text: string;
}

describe('production security surface static audit', () => {
  it('has no network, shell, telemetry, or unapproved filesystem-write surface', async () => {
    const units = await loadProductionSourceUnits();
    const forbiddenImports: string[] = [];
    const unapprovedMutationImports: string[] = [];
    const netFiles = new Set<string>();
    const forbiddenApiUses: string[] = [];

    for (const unit of units) {
      expect(unit.text.toLowerCase(), unit.relativePath).not.toContain('telemetry');
      expect(unit.text.toLowerCase(), unit.relativePath).not.toContain('analytics');

      for (const surface of FORBIDDEN_VSCODE_MUTATION_SURFACES) {
        if (
          unit.text.includes(surface) &&
          !APPROVED_IDE_MUTATION_FILES.has(unit.relativePath)
        ) {
          forbiddenApiUses.push(`${unit.relativePath}: ${surface}`);
        }
      }

      visit(unit.sourceFile, (node) => {
        if (
          !ts.isImportDeclaration(node) ||
          !ts.isStringLiteral(node.moduleSpecifier)
        ) {
          return;
        }
        const moduleName = node.moduleSpecifier.text;
        if (
          (FORBIDDEN_RUNTIME_MODULES.has(moduleName) &&
            !(
              (moduleName === 'node:child_process' || moduleName === 'child_process') &&
              APPROVED_CHILD_PROCESS_FILES.has(unit.relativePath)
            )) ||
          moduleName.startsWith('@opentelemetry/') ||
          moduleName.startsWith('@sentry/')
        ) {
          forbiddenImports.push(`${unit.relativePath}: ${moduleName}`);
        }
        if (moduleName === 'node:net' || moduleName === 'net') {
          netFiles.add(unit.relativePath);
        }
        if (moduleName !== 'node:fs' && moduleName !== 'node:fs/promises') {
          return;
        }

        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) {
          return;
        }
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (
            FILE_MUTATION_IMPORTS.has(importedName) &&
            !APPROVED_INFRASTRUCTURE_MUTATION_FILES.has(unit.relativePath)
          ) {
            unapprovedMutationImports.push(
              `${unit.relativePath}: ${moduleName}.${importedName}`,
            );
          }
        }
      });

      visit(unit.sourceFile, (node) => {
        if (!ts.isCallExpression(node)) {
          return;
        }
        if (
          ts.isIdentifier(node.expression) &&
          [
            'fetch',
            'WebSocket',
            'EventSource',
            'exec',
            'execFile',
            'spawn',
            'fork',
          ].includes(node.expression.text)
        ) {
          const approvedNodeProbe =
            node.expression.text === 'spawn' &&
            unit.relativePath === 'packages/extension/src/client-setup.ts' &&
            node.arguments
              .map((argument) => argument.getText(unit.sourceFile))
              .join(', ')
              .replace(/\s+/gu, ' ') ===
              "executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], }";
          if (!approvedNodeProbe) {
            forbiddenApiUses.push(`${unit.relativePath}: ${node.expression.text}(...)`);
          }
        }
      });
    }

    expect(forbiddenImports).toEqual([]);
    expect(unapprovedMutationImports).toEqual([]);
    expect(forbiddenApiUses).toEqual([]);
    expect([...netFiles].sort()).toEqual([...APPROVED_NET_FILES].sort());
  });

  it('binds Node net only to local IPC path variables', async () => {
    const units = await loadProductionSourceUnits();
    const createServerSites: string[] = [];
    const createConnectionSites: string[] = [];
    const nodeServerListenSites: string[] = [];

    for (const unit of units) {
      visit(unit.sourceFile, (node) => {
        if (!ts.isCallExpression(node)) {
          return;
        }
        if (ts.isIdentifier(node.expression)) {
          if (node.expression.text === 'createServer') {
            createServerSites.push(unit.relativePath);
          }
          if (node.expression.text === 'createConnection') {
            createConnectionSites.push(
              `${unit.relativePath}: ${node.arguments
                .map((argument) => argument.getText(unit.sourceFile))
                .join(', ')}`,
            );
          }
          return;
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(unit.sourceFile) === 'server' &&
          node.expression.name.text === 'listen'
        ) {
          nodeServerListenSites.push(
            `${unit.relativePath}: ${node.arguments
              .map((argument) => argument.getText(unit.sourceFile))
              .join(', ')}`,
          );
        }
      });
    }

    expect(createServerSites).toEqual([
      'packages/extension/src/ipc-instance-service.ts',
    ]);
    expect(createConnectionSites).toEqual(['packages/server/src/ipc-client.ts: path']);
    expect(nodeServerListenSites).toEqual([
      'packages/extension/src/ipc-instance-service.ts: socketPath',
    ]);
  });

  it('invokes only the fixed approved VS Code command literals', async () => {
    const units = await loadProductionSourceUnits();
    const providerCommandLiterals = new Set<string>();
    const executeCommandArguments: string[] = [];
    const registeredCommands: string[] = [];
    const dynamicRegistrations: string[] = [];

    for (const unit of units) {
      visit(unit.sourceFile, (node) => {
        if (
          ts.isStringLiteral(node) &&
          /^vscode\.(?:execute|prepare|provide)/u.test(node.text)
        ) {
          providerCommandLiterals.add(node.text);
        }
        if (
          !ts.isCallExpression(node) ||
          !ts.isPropertyAccessExpression(node.expression)
        ) {
          return;
        }
        const method = node.expression.name.text;
        const firstArgument = node.arguments[0];
        if (method === 'executeCommand' && firstArgument !== undefined) {
          executeCommandArguments.push(firstArgument.getText(unit.sourceFile));
        }
        if (method === 'registerCommand') {
          if (firstArgument !== undefined && ts.isStringLiteral(firstArgument)) {
            registeredCommands.push(firstArgument.text);
          } else {
            dynamicRegistrations.push(
              `${unit.relativePath}: ${firstArgument?.getText(unit.sourceFile) ?? '<missing>'}`,
            );
          }
        }
      });
    }

    expect([...providerCommandLiterals].sort()).toEqual(
      [...APPROVED_PROVIDER_COMMANDS].sort(),
    );
    expect(new Set(executeCommandArguments)).toEqual(
      APPROVED_EXECUTE_COMMAND_ARGUMENTS,
    );
    expect(dynamicRegistrations).toEqual([]);
    expect(registeredCommands.sort()).toEqual([...APPROVED_EXTENSION_COMMANDS].sort());
  });
});

async function loadProductionSourceUnits(): Promise<readonly SourceUnit[]> {
  const root = process.cwd();
  const sourcePaths = (await collectTypeScriptFiles(resolve(root, 'packages')))
    .map((absolutePath) => ({
      absolutePath,
      relativePath: relative(root, absolutePath).split(sep).join('/'),
    }))
    .filter(
      ({ relativePath }) =>
        relativePath.includes('/src/') &&
        !relativePath.includes('/src/test/') &&
        !relativePath.endsWith('.test.ts') &&
        !relativePath.endsWith('.unit.test.ts'),
    )
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return Promise.all(
    sourcePaths.map(async ({ absolutePath, relativePath }) => {
      const text = await readFile(absolutePath, 'utf8');
      return {
        relativePath,
        text,
        sourceFile: ts.createSourceFile(
          absolutePath,
          text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      };
    }),
  );
}

async function collectTypeScriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' || entry.name.startsWith('.')
          ? []
          : collectTypeScriptFiles(path);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return files.flat();
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  node.forEachChild((child) => visit(child, inspect));
}
