import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  RELEASE_DIRECTORY_NAME,
  RELEASE_VERSION,
  assertReleaseVersions,
  collectProductionDependencyGraph,
  createChecksumFile,
  createCycloneDxBom,
  createReleaseManifest,
  createThirdPartyNotices,
  describeArtifact,
  runCommand,
  serializeJson,
  stageServerArchive,
  verifyReleaseDirectory,
  writeFileAtomic,
} from './release-lib.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const artifactsDirectory = path.join(repositoryRoot, 'artifacts');
const finalDirectory = path.join(artifactsDirectory, RELEASE_DIRECTORY_NAME);
const temporaryDirectory = path.join(
  artifactsDirectory,
  `.${RELEASE_DIRECTORY_NAME}.${String(process.pid)}.tmp`,
);

try {
  await packageRelease();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown release error.';
  process.stderr.write(`Release packaging failed: ${message}\n`);
  process.exitCode = 1;
}

async function packageRelease() {
  // This check deliberately happens before any build, metadata generation, or artifact
  // write. A development version can never accidentally become a release candidate.
  const manifests = await assertReleaseVersions(repositoryRoot, RELEASE_VERSION);
  let finalized = false;

  try {
    await rm(temporaryDirectory, { force: true, recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });

    await runCommand('pnpm', ['--filter', '@vscode-mcp/server', 'run', 'clean'], {
      cwd: repositoryRoot,
    });
    await runCommand(
      'pnpm',
      ['--filter', '@vscode-mcp/server', 'run', 'build:production'],
      { cwd: repositoryRoot },
    );

    const graph = await collectProductionDependencyGraph(
      repositoryRoot,
      RELEASE_VERSION,
    );
    const thirdPartyNotices = await createThirdPartyNotices(graph);
    await writeFileAtomic(
      path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
      thirdPartyNotices,
    );

    const sbomFileName = `vscode-mcp-${RELEASE_VERSION}.cdx.json`;
    await writeFileAtomic(
      path.join(temporaryDirectory, sbomFileName),
      serializeJson(createCycloneDxBom(graph)),
    );

    const vsixFileName = `vscode-mcp-extension-${RELEASE_VERSION}.vsix`;
    await runCommand(
      process.execPath,
      [
        path.join(scriptDirectory, 'package-extension.mjs'),
        '--out',
        path.join(temporaryDirectory, vsixFileName),
      ],
      { cwd: repositoryRoot },
    );

    await stageServerArchive({
      destinationDirectory: temporaryDirectory,
      repositoryRoot,
      version: RELEASE_VERSION,
    });

    for (const [source, destination] of [
      ['packages/server/README.md', 'README.md'],
      ['docs/installation.md', 'INSTALLATION.md'],
      ['docs/agent-usage-guide.md', 'AGENT_USAGE.md'],
      ['docs/tool-contract-v1.0.md', 'TOOL_CONTRACT.md'],
      ['docs/release-notes-1.0.0.md', 'RELEASE_NOTES.md'],
      ['PRIVACY.md', 'PRIVACY.md'],
      ['SECURITY.md', 'SECURITY.md'],
      ['SUPPORT.md', 'SUPPORT.md'],
      ['LICENSE', 'LICENSE'],
      ['NOTICE', 'NOTICE'],
      ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
    ]) {
      await copyFile(
        path.join(repositoryRoot, source),
        path.join(temporaryDirectory, destination),
      );
    }

    const serverFileName = `vscode-mcp-server-${RELEASE_VERSION}.tar.gz`;
    const artifactSpecifications = [
      [vsixFileName, 'extension', 'application/vsix'],
      [serverFileName, 'server', 'application/gzip'],
      [sbomFileName, 'sbom', 'application/vnd.cyclonedx+json'],
      ['README.md', 'documentation', 'text/markdown'],
      ['INSTALLATION.md', 'documentation', 'text/markdown'],
      ['AGENT_USAGE.md', 'documentation', 'text/markdown'],
      ['RELEASE_NOTES.md', 'documentation', 'text/markdown'],
      ['PRIVACY.md', 'privacy-policy', 'text/markdown'],
      ['SECURITY.md', 'security-policy', 'text/markdown'],
      ['SUPPORT.md', 'support-policy', 'text/markdown'],
      ['TOOL_CONTRACT.md', 'documentation', 'text/markdown'],
      ['LICENSE', 'license', 'text/plain'],
      ['NOTICE', 'notice', 'text/plain'],
      ['THIRD_PARTY_NOTICES.md', 'third-party-notices', 'text/markdown'],
    ];
    const artifactDescriptions = [];
    for (const [fileName, role, mediaType] of artifactSpecifications) {
      artifactDescriptions.push(
        await describeArtifact(
          path.join(temporaryDirectory, fileName),
          role,
          mediaType,
        ),
      );
    }

    const rootManifest = manifests.get('package.json');
    const extensionManifest = manifests.get('packages/extension/package.json');
    const serverManifest = manifests.get('packages/server/package.json');
    if (rootManifest.engines.node !== serverManifest.engines.node) {
      throw new Error('Root and server Node.js engine ranges must match.');
    }
    const releaseManifest = createReleaseManifest({
      artifacts: artifactDescriptions,
      nodeEngine: serverManifest.engines.node,
      version: RELEASE_VERSION,
      vscodeEngine: extensionManifest.engines.vscode,
    });
    await writeFileAtomic(
      path.join(temporaryDirectory, 'release-manifest.json'),
      serializeJson(releaseManifest),
    );

    const checksummedFiles = (
      await readdir(temporaryDirectory, { withFileTypes: true })
    )
      .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS')
      .map((entry) => entry.name);
    await writeFileAtomic(
      path.join(temporaryDirectory, 'SHA256SUMS'),
      await createChecksumFile(temporaryDirectory, checksummedFiles),
    );
    await verifyReleaseDirectory(temporaryDirectory);

    await rm(finalDirectory, { force: true, recursive: true });
    await rename(temporaryDirectory, finalDirectory);
    finalized = true;
    process.stdout.write(
      `Local ${RELEASE_VERSION} release candidate: artifacts/${RELEASE_DIRECTORY_NAME}\n`,
    );
  } finally {
    if (!finalized) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}
