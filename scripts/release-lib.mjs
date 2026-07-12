import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

export const RELEASE_VERSION = '1.0.1';
export const RELEASE_DIRECTORY_NAME = `release-${RELEASE_VERSION}`;

const PACKAGE_MANIFESTS = [
  'package.json',
  'packages/extension/package.json',
  'packages/server/package.json',
  'packages/protocol/package.json',
];

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:\..*)?$/iu;
const NOTICE_FILE_PATTERN =
  /^(?:notice|third[-_. ]party(?:[-_. ]notices?)?)(?:\..*)?$/iu;
const ROOT_COMPONENT_NAME = 'vscode-mcp-release';
const RELEASE_DISTRIBUTION =
  'GitHub Releases plus the exact verified VSIX on the VS Code Marketplace after final maintainer approval';
const SUPPORTED_OPERATING_SYSTEMS = ['darwin', 'linux'];
const EXPLICITLY_UNSUPPORTED_OPERATING_SYSTEMS = ['win32'];
const RELEASE_ARTIFACT_CONTRACT = new Map([
  [
    `vscode-mcp-extension-${RELEASE_VERSION}.vsix`,
    { mediaType: 'application/vsix', role: 'extension' },
  ],
  [
    `vscode-mcp-server-${RELEASE_VERSION}.tar.gz`,
    { mediaType: 'application/gzip', role: 'server' },
  ],
  [
    `vscode-mcp-${RELEASE_VERSION}.cdx.json`,
    { mediaType: 'application/vnd.cyclonedx+json', role: 'sbom' },
  ],
  ['README.md', { mediaType: 'text/markdown', role: 'documentation' }],
  ['INSTALLATION.md', { mediaType: 'text/markdown', role: 'documentation' }],
  ['AGENT_USAGE.md', { mediaType: 'text/markdown', role: 'documentation' }],
  ['RELEASE_NOTES.md', { mediaType: 'text/markdown', role: 'documentation' }],
  ['PRIVACY.md', { mediaType: 'text/markdown', role: 'privacy-policy' }],
  ['SECURITY.md', { mediaType: 'text/markdown', role: 'security-policy' }],
  ['SUPPORT.md', { mediaType: 'text/markdown', role: 'support-policy' }],
  ['TOOL_CONTRACT.md', { mediaType: 'text/markdown', role: 'documentation' }],
  ['LICENSE', { mediaType: 'text/plain', role: 'license' }],
  ['NOTICE', { mediaType: 'text/plain', role: 'notice' }],
  [
    'THIRD_PARTY_NOTICES.md',
    { mediaType: 'text/markdown', role: 'third-party-notices' },
  ],
]);
const TAR_BLOCK_SIZE = 512;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_MADE_BY_UNIX = (3 << 8) | 30;

export async function assertReleaseVersions(
  repositoryRoot,
  expectedVersion = RELEASE_VERSION,
) {
  const manifests = new Map();
  const failures = [];

  for (const relativePath of PACKAGE_MANIFESTS) {
    const manifest = await readJson(path.join(repositoryRoot, relativePath));
    manifests.set(relativePath, manifest);

    if (manifest.version !== expectedVersion) {
      failures.push(
        `${relativePath}: expected ${expectedVersion}, found ${String(manifest.version)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Release packaging requires every package to be ${expectedVersion}:\n${failures
        .map((failure) => `- ${failure}`)
        .join('\n')}`,
    );
  }

  return manifests;
}

export async function collectProductionDependencyGraph(repositoryRoot, version) {
  const workspaceManifestPaths = [
    'packages/extension/package.json',
    'packages/server/package.json',
    'packages/protocol/package.json',
  ];
  const workspacePackages = new Map();

  for (const relativePath of workspaceManifestPaths) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const manifest = await readJson(absolutePath);
    workspacePackages.set(manifest.name, {
      directory: path.dirname(absolutePath),
      manifest,
    });
  }

  const roots = [];
  for (const [role, packageName] of [
    ['extension', 'vscode-mcp'],
    ['server', '@vscode-mcp/server'],
  ]) {
    const output = await runCommand(
      'pnpm',
      ['--filter', packageName, 'list', '--prod', '--depth', 'Infinity', '--json'],
      {
        capture: true,
        cwd: repositoryRoot,
      },
    );
    const listedPackages = JSON.parse(output);

    if (!Array.isArray(listedPackages) || listedPackages.length !== 1) {
      throw new Error(
        `pnpm returned an unexpected production graph for ${packageName}.`,
      );
    }

    roots.push({ node: listedPackages[0], role });
  }

  const rootRef = genericPurl(ROOT_COMPONENT_NAME, version);
  const components = new Map();
  const dependencies = new Map([[rootRef, new Set()]]);
  const visitedRoles = new Set();

  const visit = async (dependencyName, node, parentRef, role) => {
    const workspacePackage = workspacePackages.get(dependencyName);
    const isWorkspace =
      workspacePackage !== undefined &&
      (isWorkspaceNode(node) ||
        (typeof node.path === 'string' &&
          path.resolve(node.path) === path.resolve(workspacePackage.directory)));
    const packageDirectory = isWorkspace ? workspacePackage.directory : node.path;

    if (typeof packageDirectory !== 'string') {
      throw new Error(`Dependency ${dependencyName} does not have an installed path.`);
    }

    const manifest = isWorkspace
      ? workspacePackage.manifest
      : await readJson(path.join(packageDirectory, 'package.json'));
    const componentName = manifest.name ?? dependencyName;
    const componentVersion = isWorkspace ? manifest.version : node.version;

    if (typeof componentVersion !== 'string' || componentVersion.length === 0) {
      throw new Error(`Dependency ${componentName} does not have an exact version.`);
    }

    const ref = isWorkspace
      ? workspacePurl(componentName, componentVersion)
      : npmPurl(componentName, componentVersion);
    addDependency(dependencies, parentRef, ref);

    let component = components.get(ref);
    if (component === undefined) {
      component = {
        bomRef: ref,
        description:
          typeof manifest.description === 'string' ? manifest.description : undefined,
        externalReferences: externalReferences(manifest, node.resolved),
        license: normalizeLicense(manifest.license),
        manifest,
        name: componentName,
        packageDirectory,
        purl: ref,
        roles: new Set(),
        type:
          isWorkspace && componentName !== '@vscode-mcp/protocol'
            ? 'application'
            : 'library',
        version: componentVersion,
        workspace: isWorkspace,
      };
      components.set(ref, component);
      dependencies.set(ref, new Set());
    }
    component.roles.add(role);

    const roleVisitKey = `${ref}\0${role}`;
    if (visitedRoles.has(roleVisitKey)) {
      return;
    }
    visitedRoles.add(roleVisitKey);

    for (const [childName, child] of dependencyEntries(node)) {
      await visit(childName, child, ref, role);
    }
  };

  for (const { node, role } of roots) {
    await visit(node.name, node, rootRef, role);
  }

  return {
    components,
    dependencies,
    rootRef,
    version,
  };
}

export function createCycloneDxBom(graph) {
  const components = [...graph.components.values()]
    .sort((left, right) => compareText(left.bomRef, right.bomRef))
    .map((component) => {
      const result = {
        'bom-ref': component.bomRef,
        type: component.type,
        name: component.name,
        version: component.version,
        scope: 'required',
        licenses: [cycloneDxLicense(component.license)],
        purl: component.purl,
        properties: [
          {
            name: 'vscode-mcp:bundled-in',
            value: [...component.roles].sort(compareText).join(','),
          },
          {
            name: 'vscode-mcp:workspace-package',
            value: String(component.workspace),
          },
        ],
      };

      if (component.description !== undefined) {
        result.description = component.description;
      }
      if (component.externalReferences.length > 0) {
        result.externalReferences = component.externalReferences;
      }

      return result;
    });
  const dependencies = [...graph.dependencies.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([ref, children]) => ({
      ref,
      dependsOn: [...children].sort(compareText),
    }));
  const fingerprint = stableJson({ components, dependencies });

  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${deterministicUuid(fingerprint)}`,
    version: 1,
    metadata: {
      tools: {
        components: [
          {
            type: 'application',
            name: 'vscode-mcp release tooling',
            version: graph.version,
          },
        ],
      },
      component: {
        'bom-ref': graph.rootRef,
        type: 'application',
        name: 'vscode-mcp',
        version: graph.version,
        licenses: [{ license: { id: 'Apache-2.0' } }],
      },
    },
    components,
    dependencies,
  };
}

export async function createThirdPartyNotices(graph) {
  const externalComponents = [...graph.components.values()]
    .filter((component) => !component.workspace)
    .sort((left, right) => compareText(left.bomRef, right.bomRef));
  const graphFingerprint = sha256Buffer(
    Buffer.from(
      stableJson({
        components: externalComponents.map((component) => component.bomRef),
        dependencies: [...graph.dependencies.entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([ref, dependencies]) => [ref, [...dependencies].sort(compareText)]),
      }),
    ),
  );
  const lines = [
    '# Third-party notices',
    '',
    '<!-- Generated by scripts/package-release.mjs. Do not edit by hand. -->',
    '',
    `vscode-mcp ${graph.version} bundles the production dependencies listed below.`,
    'The list is generated from the exact pnpm production dependency graph used by the',
    'extension and server builds. License texts are copied from the installed packages.',
    '',
    `Dependency components: ${String(externalComponents.length)}`,
    `Dependency graph SHA-256: \`${graphFingerprint}\``,
    '',
  ];

  for (const component of externalComponents) {
    const entries = await readdir(component.packageDirectory, { withFileTypes: true });
    const licenseFiles = entries
      .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareText);
    const noticeFiles = entries
      .filter((entry) => entry.isFile() && NOTICE_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareText);

    if (licenseFiles.length === 0) {
      throw new Error(
        `Bundled dependency ${component.name}@${component.version} has no license file.`,
      );
    }

    lines.push(`## ${component.name} ${component.version}`, '');
    lines.push(`- License: \`${component.license}\``);
    lines.push(`- Included in: ${[...component.roles].sort(compareText).join(', ')}`);
    const source = preferredSource(component);
    if (source !== undefined) {
      lines.push(`- Source: ${source}`);
    }
    lines.push('');

    for (const fileName of [...licenseFiles, ...noticeFiles]) {
      const contents = normalizeLineEndings(
        await readFile(path.join(component.packageDirectory, fileName), 'utf8'),
      ).trimEnd();
      lines.push(`### ${fileName}`, '', `--- BEGIN ${fileName} ---`, contents);
      lines.push(`--- END ${fileName} ---`, '');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export async function stageServerArchive({
  destinationDirectory,
  repositoryRoot,
  version,
}) {
  const archiveRootName = 'vscode-mcp-server';
  const stageRoot = path.join(destinationDirectory, '.server-stage', archiveRootName);
  await mkdir(stageRoot, { recursive: true });

  const sourceFiles = [
    ['packages/server/dist/cli.mjs', 'cli.mjs'],
    ['packages/server/README.md', 'README.md'],
    ['docs/installation.md', 'INSTALLATION.md'],
    ['docs/agent-usage-guide.md', 'AGENT_USAGE.md'],
    ['docs/tool-contract-v1.0.md', 'TOOL_CONTRACT.md'],
    ['PRIVACY.md', 'PRIVACY.md'],
    ['SECURITY.md', 'SECURITY.md'],
    ['SUPPORT.md', 'SUPPORT.md'],
    ['LICENSE', 'LICENSE'],
    ['NOTICE', 'NOTICE'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ];

  for (const [source, destination] of sourceFiles) {
    await copyFile(
      path.join(repositoryRoot, source),
      path.join(stageRoot, destination),
    );
  }
  const serverManifest = await readJson(
    path.join(repositoryRoot, 'packages/server/package.json'),
  );
  if (
    serverManifest.name !== '@vscode-mcp/server' ||
    serverManifest.version !== version ||
    typeof serverManifest.engines?.node !== 'string'
  ) {
    throw new Error('Server package metadata does not match the release archive.');
  }
  await writeFile(
    path.join(stageRoot, 'package.json'),
    serializeJson({
      name: serverManifest.name,
      version,
      private: true,
      type: 'module',
      engines: { node: serverManifest.engines.node },
      bin: { 'vscode-mcp': './cli.mjs' },
    }),
  );
  await chmod(path.join(stageRoot, 'cli.mjs'), 0o755);

  const legalCommentsPath = path.join(
    repositoryRoot,
    'packages/server/dist/cli.mjs.LEGAL.txt',
  );
  if (await exists(legalCommentsPath)) {
    await copyFile(legalCommentsPath, path.join(stageRoot, 'cli.mjs.LEGAL.txt'));
  }

  const archive = await createDeterministicTarGzip(
    path.dirname(stageRoot),
    archiveRootName,
  );
  const outputPath = path.join(
    destinationDirectory,
    `vscode-mcp-server-${version}.tar.gz`,
  );
  await writeFile(outputPath, archive);
  await rm(path.join(destinationDirectory, '.server-stage'), {
    force: true,
    recursive: true,
  });
  return outputPath;
}

export async function createDeterministicTarGzip(parentDirectory, rootName) {
  assertSafeArchivePath(rootName);
  const rootPath = path.join(parentDirectory, rootName);
  const entries = [];
  await collectTarEntries(rootPath, `${rootName}/`, entries);
  entries.sort((left, right) => compareText(left.name, right.name));

  const chunks = [];
  for (const entry of entries) {
    const header = createTarHeader(entry);
    chunks.push(header);
    if (entry.type === 'file') {
      chunks.push(entry.contents);
      const remainder = entry.contents.length % TAR_BLOCK_SIZE;
      if (remainder !== 0) {
        chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
      }
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));

  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  archive.writeUInt32LE(0, 4);
  archive[9] = 0xff;
  return archive;
}

export function buildDeterministicZip(entries) {
  const normalizedEntries = entries
    .map((entry) => normalizeZipEntry(entry))
    .sort((left, right) => compareText(left.name, right.name));
  const names = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of normalizedEntries) {
    if (names.has(entry.name)) {
      throw new Error(`ZIP contains duplicate entry ${entry.name}.`);
    }
    names.add(entry.name);

    const name = Buffer.from(entry.name, 'utf8');
    const directory = entry.name.endsWith('/');
    const method = directory ? 0 : 8;
    const compressed =
      method === 0 ? entry.contents : deflateRawSync(entry.contents, { level: 9 });
    const crc = crc32(entry.contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    localHeader.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_FILE_HEADER, 0);
    centralHeader.writeUInt16LE(ZIP_VERSION_MADE_BY_UNIX, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    const unixMode = directory ? 0o040755 : 0o100000 | entry.mode;
    centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalizedEntries.length, 8);
  end.writeUInt16LE(normalizedEntries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readZipEntries(archive) {
  const endOffset = findZipEnd(archive);
  assertBufferRange(archive, endOffset, 22, 'ZIP end-of-central-directory record');
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-disk ZIP archives are unsupported.');
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are unsupported.');
  }
  if (centralOffset + centralSize !== endOffset) {
    throw new Error('ZIP central directory bounds are invalid.');
  }

  const entries = [];
  const names = new Set();
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    assertBufferRange(archive, cursor, 46, 'ZIP central directory header');
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER) {
      throw new Error('Invalid ZIP central directory header.');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const centralRecordLength = 46 + nameLength + extraLength + commentLength;
    assertBufferRange(
      archive,
      cursor,
      centralRecordLength,
      'ZIP central directory entry',
    );
    if (cursor + centralRecordLength > endOffset) {
      throw new Error('ZIP central directory entry exceeds its declared bounds.');
    }
    const nameBytes = archive.subarray(nameStart, nameStart + nameLength);
    const name = decodeZipName(nameBytes, flags);
    assertSafeArchivePath(name);
    if (names.has(name)) {
      throw new Error(`ZIP contains duplicate entry ${name}.`);
    }
    names.add(name);

    if ((flags & 1) !== 0) {
      throw new Error(`Encrypted ZIP entry ${name} is unsupported.`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`ZIP entry ${name} uses unsupported method ${String(method)}.`);
    }
    assertBufferRange(archive, localOffset, 30, `ZIP local header for ${name}`);
    if (archive.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error(`ZIP entry ${name} has an invalid local header.`);
    }

    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localCrc = archive.readUInt32LE(localOffset + 14);
    const localCompressedSize = archive.readUInt32LE(localOffset + 18);
    const localUncompressedSize = archive.readUInt32LE(localOffset + 22);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localHeaderLength = 30 + localNameLength + localExtraLength;
    assertBufferRange(
      archive,
      localOffset,
      localHeaderLength,
      `ZIP local header for ${name}`,
    );
    const localName = archive.subarray(
      localOffset + 30,
      localOffset + 30 + localNameLength,
    );
    if (
      localFlags !== flags ||
      localMethod !== method ||
      !localName.equals(nameBytes)
    ) {
      throw new Error(`ZIP entry ${name} has inconsistent local metadata.`);
    }
    if (
      (flags & 0x0008) === 0 &&
      (localCrc !== expectedCrc ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize)
    ) {
      throw new Error(`ZIP entry ${name} has inconsistent local sizes or CRC.`);
    }

    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    assertBufferRange(archive, dataStart, compressedSize, `ZIP data for ${name}`);
    if (dataStart + compressedSize > centralOffset) {
      throw new Error(`ZIP entry ${name} data overlaps the central directory.`);
    }
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const contents =
      method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);

    if (contents.length !== uncompressedSize || crc32(contents) !== expectedCrc) {
      throw new Error(`ZIP entry ${name} failed its size or CRC check.`);
    }

    entries.push({
      contents,
      mode:
        (externalAttributes >>> 16) & 0o777
          ? (externalAttributes >>> 16) & 0o777
          : 0o644,
      name,
    });
    cursor += centralRecordLength;
  }

  if (cursor !== endOffset) {
    throw new Error('ZIP central directory size does not match its entries.');
  }

  return entries;
}

export async function normalizeZipFile(filePath) {
  const archive = await readFile(filePath);
  const normalized = buildDeterministicZip(readZipEntries(archive));
  await writeFileAtomic(filePath, normalized);
}

export async function describeArtifact(filePath, role, mediaType) {
  const contents = await readFile(filePath);
  return {
    file: path.basename(filePath),
    role,
    mediaType,
    size: contents.length,
    sha256: sha256Buffer(contents),
  };
}

export function createReleaseManifest({
  artifacts,
  nodeEngine,
  version,
  vscodeEngine,
}) {
  return {
    schemaVersion: 1,
    release: {
      name: 'vscode-mcp',
      version,
      status: 'local-release-candidate',
      published: false,
      distribution: RELEASE_DISTRIBUTION,
    },
    compatibility: {
      node: nodeEngine,
      vscode: vscodeEngine,
      operatingSystems: SUPPORTED_OPERATING_SYSTEMS,
      explicitlyUnsupportedOperatingSystems: EXPLICITLY_UNSUPPORTED_OPERATING_SYSTEMS,
      localDesktopOnly: true,
      versionMatchedComponents: true,
    },
    reproducibility: {
      command: 'pnpm package:release',
      archiveTimestamps: '1980-01-01T00:00:00Z or Unix epoch',
      sourceDateEpochRequired: false,
    },
    artifacts: [...artifacts].sort((left, right) => compareText(left.file, right.file)),
  };
}

export async function createChecksumFile(directory, fileNames) {
  const lines = [];
  const sortedFileNames = [...fileNames].sort(compareText);
  const seen = new Set();
  for (const fileName of sortedFileNames) {
    assertFlatFileName(fileName);
    if (seen.has(fileName)) {
      throw new Error(`Cannot checksum duplicate release file ${fileName}.`);
    }
    seen.add(fileName);
    const contents = await readFile(path.join(directory, fileName));
    lines.push(`${sha256Buffer(contents)}  ${fileName}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function verifyReleaseDirectory(directory) {
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  for (const entry of directoryEntries) {
    assertFlatFileName(entry.name);
    if (!entry.isFile()) {
      throw new Error(`Release directory contains non-file entry ${entry.name}.`);
    }
  }
  const releaseFiles = directoryEntries.map((entry) => entry.name).sort(compareText);
  if (!releaseFiles.includes('SHA256SUMS')) {
    throw new Error('Release directory is missing SHA256SUMS.');
  }

  const checksumPath = path.join(directory, 'SHA256SUMS');
  const checksumContents = normalizeLineEndings(await readFile(checksumPath, 'utf8'));
  if (!checksumContents.endsWith('\n')) {
    throw new Error('SHA256SUMS must end with a newline.');
  }
  const checksumLines = checksumContents.trim().split('\n');
  const seen = new Set();
  let previousFileName;

  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/u.exec(line);
    if (match === null) {
      throw new Error(`Invalid SHA256SUMS line: ${line}`);
    }
    const [, expected, fileName] = match;
    assertFlatFileName(fileName);
    if (seen.has(fileName)) {
      throw new Error(`SHA256SUMS contains duplicate file ${fileName}.`);
    }
    if (
      previousFileName !== undefined &&
      compareText(previousFileName, fileName) >= 0
    ) {
      throw new Error('SHA256SUMS entries are not in canonical filename order.');
    }
    previousFileName = fileName;
    seen.add(fileName);
    const actual = sha256Buffer(await readFile(path.join(directory, fileName)));
    if (actual !== expected) {
      throw new Error(`Checksum verification failed for ${fileName}.`);
    }
  }

  const expectedChecksummedFiles = releaseFiles.filter(
    (fileName) => fileName !== 'SHA256SUMS',
  );
  assertExactFileSet(
    seen,
    expectedChecksummedFiles,
    'SHA256SUMS coverage does not match the release directory',
  );
  if (!seen.has('release-manifest.json')) {
    throw new Error('release-manifest.json is not checksummed.');
  }

  const manifest = await readJson(path.join(directory, 'release-manifest.json'));
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error('Release manifest has an invalid schema.');
  }
  if (
    manifest.release?.name !== 'vscode-mcp' ||
    manifest.release.version !== RELEASE_VERSION ||
    manifest.release.status !== 'local-release-candidate' ||
    manifest.release.published !== false ||
    manifest.release.distribution !== RELEASE_DISTRIBUTION
  ) {
    throw new Error('Release manifest has invalid release metadata.');
  }
  if (
    typeof manifest.compatibility?.node !== 'string' ||
    manifest.compatibility.node.length === 0 ||
    typeof manifest.compatibility.vscode !== 'string' ||
    manifest.compatibility.vscode.length === 0 ||
    !arraysEqual(
      manifest.compatibility.operatingSystems,
      SUPPORTED_OPERATING_SYSTEMS,
    ) ||
    !arraysEqual(
      manifest.compatibility.explicitlyUnsupportedOperatingSystems,
      EXPLICITLY_UNSUPPORTED_OPERATING_SYSTEMS,
    ) ||
    manifest.compatibility.localDesktopOnly !== true ||
    manifest.compatibility.versionMatchedComponents !== true
  ) {
    throw new Error('Release manifest has invalid compatibility metadata.');
  }
  if (
    manifest.reproducibility?.command !== 'pnpm package:release' ||
    manifest.reproducibility.archiveTimestamps !==
      '1980-01-01T00:00:00Z or Unix epoch' ||
    manifest.reproducibility.sourceDateEpochRequired !== false
  ) {
    throw new Error('Release manifest has invalid reproducibility metadata.');
  }
  const manifestFiles = new Set();
  let previousArtifactFile;
  for (const artifact of manifest.artifacts) {
    if (
      artifact === null ||
      typeof artifact !== 'object' ||
      typeof artifact.file !== 'string' ||
      typeof artifact.size !== 'number' ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      typeof artifact.role !== 'string' ||
      typeof artifact.mediaType !== 'string'
    ) {
      throw new Error('Release manifest contains an invalid artifact entry.');
    }
    assertFlatFileName(artifact.file);
    if (
      previousArtifactFile !== undefined &&
      compareText(previousArtifactFile, artifact.file) >= 0
    ) {
      throw new Error(
        'Release manifest artifacts are not in canonical filename order.',
      );
    }
    previousArtifactFile = artifact.file;
    if (manifestFiles.has(artifact.file)) {
      throw new Error(`Release manifest contains duplicate artifact ${artifact.file}.`);
    }
    const expectedArtifact = RELEASE_ARTIFACT_CONTRACT.get(artifact.file);
    if (
      expectedArtifact === undefined ||
      artifact.role !== expectedArtifact.role ||
      artifact.mediaType !== expectedArtifact.mediaType
    ) {
      throw new Error(
        `Release manifest contains invalid role or media type for ${artifact.file}.`,
      );
    }
    manifestFiles.add(artifact.file);
    if (!seen.has(artifact.file)) {
      throw new Error(`Release manifest artifact ${artifact.file} is not checksummed.`);
    }
    const contents = await readFile(path.join(directory, artifact.file));
    if (
      contents.length !== artifact.size ||
      sha256Buffer(contents) !== artifact.sha256
    ) {
      throw new Error(`Release manifest verification failed for ${artifact.file}.`);
    }
  }

  assertExactFileSet(
    manifestFiles,
    expectedChecksummedFiles.filter((fileName) => fileName !== 'release-manifest.json'),
    'Release manifest coverage does not match the candidate payloads',
  );
  assertExactFileSet(
    manifestFiles,
    RELEASE_ARTIFACT_CONTRACT.keys(),
    'Release manifest does not match the 1.0 artifact contract',
  );

  await verifyVsixArtifact(
    path.join(directory, `vscode-mcp-extension-${RELEASE_VERSION}.vsix`),
    manifest.compatibility.vscode,
  );
  await verifyServerArtifact(
    path.join(directory, `vscode-mcp-server-${RELEASE_VERSION}.tar.gz`),
    manifest.compatibility.node,
  );
  await verifyCycloneDxBom(
    path.join(directory, `vscode-mcp-${RELEASE_VERSION}.cdx.json`),
  );
}

function arraysEqual(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export async function verifyVsixArtifact(filePath, vscodeEngine) {
  const entries = readZipEntries(await readFile(filePath));
  const requiredFiles = [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/LICENSE.txt',
    'extension/NOTICE',
    'extension/PRIVACY.md',
    'extension/SUPPORT.md',
    'extension/THIRD_PARTY_NOTICES.md',
    'extension/changelog.md',
    'extension/dist/extension.js',
    'extension/images/icon.png',
    'extension/package.json',
    'extension/readme.md',
    'extension/server/cli.mjs',
    'extension/server/manifest.json',
  ];
  const optionalFiles = ['extension/dist/extension.js.LEGAL.txt'];
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assertRequiredAndAllowedFileSet(
    new Set(byName.keys()),
    requiredFiles,
    optionalFiles,
    'VSIX contents do not match the release contract',
  );

  for (const entry of entries) {
    if (entry.name.endsWith('/') || (entry.mode & 0o111) !== 0) {
      throw new Error(`VSIX contains an invalid file mode for ${entry.name}.`);
    }
  }

  const extensionManifest = parseJsonBuffer(
    byName.get('extension/package.json').contents,
    'VSIX extension/package.json',
  );
  if (
    extensionManifest.name !== 'vscode-mcp' ||
    extensionManifest.publisher !== 'vscode-mcp' ||
    extensionManifest.version !== RELEASE_VERSION ||
    extensionManifest.private !== true ||
    extensionManifest.type !== 'commonjs' ||
    extensionManifest.main !== './dist/extension.js' ||
    extensionManifest.icon !== 'images/icon.png' ||
    extensionManifest.engines?.vscode !== vscodeEngine ||
    extensionManifest.homepage !== 'https://github.com/kennywillbe/vscode-mcp#readme' ||
    extensionManifest.repository?.type !== 'git' ||
    extensionManifest.repository?.url !==
      'https://github.com/kennywillbe/vscode-mcp.git' ||
    extensionManifest.bugs?.url !==
      'https://github.com/kennywillbe/vscode-mcp/issues' ||
    extensionManifest.qna !== false ||
    extensionManifest.markdown !== 'github' ||
    extensionManifest.pricing !== 'Free' ||
    !arraysEqual(extensionManifest.keywords, [
      'mcp',
      'model-context-protocol',
      'ai',
      'coding-agent',
      'language-server',
      'lsp',
      'developer-tools',
      'automation',
    ]) ||
    !arraysEqual(extensionManifest.extensionKind, ['workspace']) ||
    extensionManifest.capabilities?.untrustedWorkspaces?.supported !== false ||
    extensionManifest.capabilities?.virtualWorkspaces?.supported !== false
  ) {
    throw new Error('VSIX extension manifest does not match the 1.0 contract.');
  }

  const icon = byName.get('extension/images/icon.png').contents;
  const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (
    icon.length < 26 ||
    !icon.subarray(0, pngSignature.length).equals(pngSignature) ||
    icon.toString('ascii', 12, 16) !== 'IHDR' ||
    icon.readUInt32BE(16) !== 256 ||
    icon.readUInt32BE(20) !== 256 ||
    icon[24] !== 8 ||
    icon[25] !== 6
  ) {
    throw new Error('VSIX Marketplace icon must be a 256x256 RGBA PNG.');
  }

  const vsixManifest = parseXmlDocument(
    byName.get('extension.vsixmanifest').contents,
    'VSIX manifest',
  );
  const identity = requireSingleXmlElement(
    vsixManifest,
    ['PackageManifest', 'Metadata', 'Identity'],
    'VSIX identity',
  );
  const engine = requireSingleXmlElement(
    vsixManifest,
    ['PackageManifest', 'Metadata', 'Properties', 'Property'],
    'VSIX engine property',
    (element) => element.attributes.Id === 'Microsoft.VisualStudio.Code.Engine',
  );
  const manifestAsset = requireSingleXmlElement(
    vsixManifest,
    ['PackageManifest', 'Assets', 'Asset'],
    'VSIX extension manifest asset',
    (element) => element.attributes.Type === 'Microsoft.VisualStudio.Code.Manifest',
  );
  if (
    !xmlAttributesEqual(identity.attributes, {
      Id: 'vscode-mcp',
      Language: 'en-US',
      Publisher: 'vscode-mcp',
      Version: RELEASE_VERSION,
    }) ||
    engine.attributes.Value !== vscodeEngine ||
    manifestAsset.attributes.Path !== 'extension/package.json'
  ) {
    throw new Error('VSIX package manifest identity or engine is invalid.');
  }

  const contentTypes = parseXmlDocument(
    byName.get('[Content_Types].xml').contents,
    'VSIX content types',
  );
  const manifestContentType = requireSingleXmlElement(
    contentTypes,
    ['Types', 'Default'],
    'VSIX manifest content type',
    (element) => element.attributes.Extension === '.vsixmanifest',
  );
  if (manifestContentType.attributes.ContentType !== 'text/xml') {
    throw new Error('VSIX content types do not declare the manifest.');
  }

  const bundle = byName.get('extension/dist/extension.js').contents;
  if (
    bundle.length === 0 ||
    bundle.includes(Buffer.from('sourceMappingURL')) ||
    bundle.includes(Buffer.from('packages/extension/src/'))
  ) {
    throw new Error('VSIX extension bundle is empty or contains development metadata.');
  }

  const bundledServer = byName.get('extension/server/cli.mjs').contents;
  const bundledServerManifest = parseJsonBuffer(
    byName.get('extension/server/manifest.json').contents,
    'VSIX bundled server manifest',
  );
  if (
    bundledServer.length === 0 ||
    bundledServerManifest.schemaVersion !== 1 ||
    bundledServerManifest.productVersion !== RELEASE_VERSION ||
    bundledServerManifest.nodeEngine !== '^22.13.0' ||
    bundledServerManifest.cli?.file !== 'cli.mjs' ||
    bundledServerManifest.cli?.sha256 !== sha256Buffer(bundledServer) ||
    bundledServer.includes(Buffer.from('sourceMappingURL')) ||
    bundledServer.includes(Buffer.from('packages/server/src/'))
  ) {
    throw new Error('VSIX bundled server does not match the release contract.');
  }
}

export async function verifyServerArtifact(filePath, nodeEngine) {
  const entries = inspectTarGzip(await readFile(filePath));
  const requiredEntries = [
    'vscode-mcp-server/',
    'vscode-mcp-server/AGENT_USAGE.md',
    'vscode-mcp-server/INSTALLATION.md',
    'vscode-mcp-server/LICENSE',
    'vscode-mcp-server/NOTICE',
    'vscode-mcp-server/PRIVACY.md',
    'vscode-mcp-server/README.md',
    'vscode-mcp-server/SECURITY.md',
    'vscode-mcp-server/SUPPORT.md',
    'vscode-mcp-server/THIRD_PARTY_NOTICES.md',
    'vscode-mcp-server/TOOL_CONTRACT.md',
    'vscode-mcp-server/cli.mjs',
    'vscode-mcp-server/package.json',
  ];
  const optionalEntries = ['vscode-mcp-server/cli.mjs.LEGAL.txt'];
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assertRequiredAndAllowedFileSet(
    new Set(byName.keys()),
    requiredEntries,
    optionalEntries,
    'Server archive contents do not match the release contract',
  );

  for (const entry of entries) {
    const directory = entry.name.endsWith('/');
    const expectedMode = directory
      ? 0o755
      : entry.name === 'vscode-mcp-server/cli.mjs'
        ? 0o755
        : 0o644;
    if (
      entry.type !== (directory ? '5' : '0') ||
      entry.mode !== expectedMode ||
      entry.mtime !== 0 ||
      entry.uid !== 0 ||
      entry.gid !== 0
    ) {
      throw new Error(`Server archive metadata is invalid for ${entry.name}.`);
    }
    if (!directory && entry.contents.length === 0) {
      throw new Error(`Server archive contains an empty required file ${entry.name}.`);
    }
  }

  const packageManifest = parseJsonBuffer(
    byName.get('vscode-mcp-server/package.json').contents,
    'server package.json',
  );
  if (
    packageManifest.name !== '@vscode-mcp/server' ||
    packageManifest.version !== RELEASE_VERSION ||
    packageManifest.private !== true ||
    packageManifest.type !== 'module' ||
    packageManifest.engines?.node !== nodeEngine ||
    packageManifest.bin?.['vscode-mcp'] !== './cli.mjs'
  ) {
    throw new Error('Server archive package metadata does not match the 1.0 contract.');
  }

  const cli = byName.get('vscode-mcp-server/cli.mjs').contents;
  if (
    !cli
      .subarray(0, '#!/usr/bin/env node\n'.length)
      .equals(Buffer.from('#!/usr/bin/env node\n')) ||
    !cli.includes(Buffer.from(RELEASE_VERSION)) ||
    cli.includes(Buffer.from('sourceMappingURL')) ||
    cli.includes(Buffer.from('packages/server/src/'))
  ) {
    throw new Error('Server CLI is invalid or contains development metadata.');
  }
}

function parseJsonBuffer(contents, description) {
  try {
    return JSON.parse(decodeUtf8Buffer(contents, description));
  } catch (error) {
    throw new Error(`${description} is not valid JSON.`, { cause: error });
  }
}

function decodeUtf8Buffer(contents, description) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch (error) {
    throw new Error(`${description} is not valid UTF-8.`, { cause: error });
  }
}

function parseXmlDocument(contents, description) {
  const source = decodeUtf8Buffer(contents, description);
  const elements = [];
  const stack = [];
  const tokenPattern =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:\s+[\s\S]*?)?\/?>/gu;
  let cursor = 0;
  let declarationSeen = false;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const offset = match.index;
    if (source.slice(cursor, offset).includes('<')) {
      throw new Error(`${description} contains malformed XML.`);
    }
    cursor = offset + token.length;
    if (token.startsWith('<!--')) {
      continue;
    }
    if (token.startsWith('<?')) {
      if (
        declarationSeen ||
        elements.length > 0 ||
        !/^<\?xml\s[^?]*\?>$/u.test(token)
      ) {
        throw new Error(
          `${description} contains an unsupported processing instruction.`,
        );
      }
      declarationSeen = true;
      continue;
    }
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim();
      if (stack.pop()?.name !== name) {
        throw new Error(`${description} contains mismatched XML elements.`);
      }
      continue;
    }

    const selfClosing = token.endsWith('/>');
    const body = token.slice(1, selfClosing ? -2 : -1).trim();
    const separator = body.search(/\s/u);
    const name = separator === -1 ? body : body.slice(0, separator);
    const attributes = parseXmlAttributes(
      separator === -1 ? '' : body.slice(separator),
      description,
    );
    const element = { attributes, name, parent: stack.at(-1) };
    elements.push(element);
    if (!selfClosing) {
      stack.push(element);
    }
  }
  if (source.slice(cursor).includes('<') || stack.length > 0) {
    throw new Error(`${description} contains malformed XML.`);
  }
  const roots = elements.filter((element) => element.parent === undefined);
  if (roots.length !== 1) {
    throw new Error(`${description} must contain exactly one root element.`);
  }
  return elements;
}

function parseXmlAttributes(source, description) {
  const attributes = {};
  const pattern = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/guy;
  let cursor = 0;
  while (cursor < source.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (match === null) {
      if (source.slice(cursor).trim().length === 0) {
        break;
      }
      throw new Error(`${description} contains malformed XML attributes.`);
    }
    const name = match[1];
    if (Object.hasOwn(attributes, name)) {
      throw new Error(`${description} contains duplicate XML attribute ${name}.`);
    }
    attributes[name] = match[2].slice(1, -1);
    cursor = pattern.lastIndex;
  }
  return attributes;
}

function requireSingleXmlElement(
  elements,
  pathSegments,
  description,
  predicate = () => true,
) {
  const matches = elements.filter((element) => {
    const names = [];
    for (let current = element; current !== undefined; current = current.parent) {
      names.unshift(current.name);
    }
    return arraysEqual(names, pathSegments) && predicate(element);
  });
  if (matches.length !== 1) {
    throw new Error(`${description} must occur exactly once in its expected XML path.`);
  }
  return matches[0];
}

function xmlAttributesEqual(actual, expected) {
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    compareText(left, right),
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    compareText(left, right),
  );
  return stableJson(actualEntries) === stableJson(expectedEntries);
}

function assertRequiredAndAllowedFileSet(actual, required, optional, message) {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((fileName) => !actual.has(fileName));
  const extra = [...actual].filter((fileName) => !allowed.has(fileName));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${message}: missing [${missing.sort(compareText).join(', ')}], extra [${extra
        .sort(compareText)
        .join(', ')}].`,
    );
  }
}

async function verifyCycloneDxBom(filePath) {
  const bom = await readJson(filePath);
  const rootRef = genericPurl(ROOT_COMPONENT_NAME, RELEASE_VERSION);
  if (
    bom === null ||
    typeof bom !== 'object' ||
    bom.$schema !== 'http://cyclonedx.org/schema/bom-1.5.schema.json' ||
    bom.bomFormat !== 'CycloneDX' ||
    bom.specVersion !== '1.5' ||
    bom.version !== 1 ||
    typeof bom.serialNumber !== 'string' ||
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      bom.serialNumber,
    ) ||
    bom.metadata?.component?.['bom-ref'] !== rootRef ||
    bom.metadata.component.name !== 'vscode-mcp' ||
    bom.metadata.component.version !== RELEASE_VERSION ||
    !Array.isArray(bom.components) ||
    !Array.isArray(bom.dependencies)
  ) {
    throw new Error('Release SBOM has invalid CycloneDX metadata.');
  }

  const componentRefs = new Set();
  for (const component of bom.components) {
    if (
      component === null ||
      typeof component !== 'object' ||
      typeof component['bom-ref'] !== 'string' ||
      component['bom-ref'].length === 0 ||
      typeof component.name !== 'string' ||
      component.name.length === 0 ||
      typeof component.version !== 'string' ||
      component.version.length === 0 ||
      typeof component.purl !== 'string' ||
      component.purl !== component['bom-ref'] ||
      !Array.isArray(component.licenses) ||
      !Array.isArray(component.properties)
    ) {
      throw new Error('Release SBOM contains an invalid component.');
    }
    if (componentRefs.has(component['bom-ref'])) {
      throw new Error(
        `Release SBOM contains duplicate component ${component['bom-ref']}.`,
      );
    }
    componentRefs.add(component['bom-ref']);
  }

  const allowedRefs = new Set([rootRef, ...componentRefs]);
  const dependencyRefs = new Set();
  for (const dependency of bom.dependencies) {
    if (
      dependency === null ||
      typeof dependency !== 'object' ||
      typeof dependency.ref !== 'string' ||
      !allowedRefs.has(dependency.ref) ||
      !Array.isArray(dependency.dependsOn) ||
      dependency.dependsOn.some(
        (reference) => typeof reference !== 'string' || !componentRefs.has(reference),
      ) ||
      new Set(dependency.dependsOn).size !== dependency.dependsOn.length
    ) {
      throw new Error('Release SBOM contains an invalid dependency entry.');
    }
    if (dependencyRefs.has(dependency.ref)) {
      throw new Error(`Release SBOM contains duplicate dependency ${dependency.ref}.`);
    }
    dependencyRefs.add(dependency.ref);
  }

  assertExactFileSet(
    dependencyRefs,
    allowedRefs,
    'Release SBOM dependency coverage does not match its components',
  );

  const childrenByRef = new Map(
    bom.dependencies.map((dependency) => [dependency.ref, dependency.dependsOn]),
  );
  const reachable = new Set([rootRef]);
  const queue = [rootRef];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of childrenByRef.get(parent) ?? []) {
      if (!reachable.has(child)) {
        reachable.add(child);
        queue.push(child);
      }
    }
  }
  assertExactFileSet(
    reachable,
    allowedRefs,
    'Release SBOM contains components disconnected from the release root',
  );
}

export async function runCommand(command, arguments_, options) {
  const capture = options.capture ?? false;
  return await new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    if (capture) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(capture ? Buffer.concat(stdout).toString('utf8') : '');
        return;
      }

      const detail = capture ? Buffer.concat(stderr).toString('utf8').trim() : '';
      reject(
        new Error(
          `${command} ${arguments_.join(' ')} failed (${signal ?? `exit ${String(code)}`})${
            detail.length > 0 ? `: ${detail}` : ''
          }`,
        ),
      );
    });
  });
}

export async function writeFileAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.${String(process.pid)}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(temporaryPath, contents);
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (!isReplaceError(error)) {
      throw error;
    }
    await rm(filePath, { force: true });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function serializeJson(value) {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

export function sha256Buffer(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function isWorkspaceNode(node) {
  return typeof node.version === 'string' && node.version.startsWith('link:');
}

function dependencyEntries(node) {
  const entries = new Map();
  for (const collectionName of ['dependencies', 'optionalDependencies']) {
    const collection = node[collectionName];
    if (collection !== undefined && collection !== null) {
      for (const [name, dependency] of Object.entries(collection)) {
        entries.set(name, dependency);
      }
    }
  }
  return [...entries.entries()].sort(([left], [right]) => compareText(left, right));
}

function addDependency(dependencies, parentRef, childRef) {
  let children = dependencies.get(parentRef);
  if (children === undefined) {
    children = new Set();
    dependencies.set(parentRef, children);
  }
  children.add(childRef);
}

function normalizeLicense(license) {
  if (typeof license !== 'string' || license.trim().length === 0) {
    throw new Error(
      'A production dependency is missing package.json license metadata.',
    );
  }
  return license.trim();
}

function cycloneDxLicense(license) {
  if (/^[A-Za-z0-9.+-]+$/u.test(license)) {
    return { license: { id: license } };
  }
  return { expression: license };
}

function externalReferences(manifest, resolved) {
  const references = [];
  const repository = repositoryUrl(manifest.repository);
  if (repository !== undefined) {
    references.push({ type: 'vcs', url: repository });
  }
  if (typeof manifest.homepage === 'string' && isPublicHttpUrl(manifest.homepage)) {
    references.push({ type: 'website', url: manifest.homepage });
  }
  if (typeof resolved === 'string' && isPublicHttpUrl(resolved)) {
    references.push({ type: 'distribution', url: resolved });
  }
  const deduplicated = new Map(
    references.map((reference) => [`${reference.type}\0${reference.url}`, reference]),
  );
  return [...deduplicated.values()].sort((left, right) =>
    compareText(`${left.type}\0${left.url}`, `${right.type}\0${right.url}`),
  );
}

function repositoryUrl(repository) {
  const value =
    typeof repository === 'string'
      ? repository
      : repository !== null && typeof repository === 'object'
        ? repository.url
        : undefined;
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value
    .replace(/^git\+https:/u, 'https:')
    .replace(/^git:/u, 'https:')
    .replace(/\.git$/u, '');
  return isPublicHttpUrl(normalized) ? normalized : undefined;
}

function isPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0
    );
  } catch {
    return false;
  }
}

function preferredSource(component) {
  return (
    component.externalReferences.find((reference) => reference.type === 'vcs')?.url ??
    component.externalReferences.find((reference) => reference.type === 'website')
      ?.url ??
    component.externalReferences.find((reference) => reference.type === 'distribution')
      ?.url
  );
}

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash <= 1 || slash === name.length - 1) {
      throw new Error(`Invalid scoped npm package name ${name}.`);
    }
    return `pkg:npm/%40${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(
      name.slice(slash + 1),
    )}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function workspacePurl(name, version) {
  if (name === 'vscode-mcp') {
    return genericPurl('vscode-mcp-extension', version);
  }
  return npmPurl(name, version);
}

function genericPurl(name, version) {
  return `pkg:generic/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function deterministicUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function collectTarEntries(filePath, archivePath, entries) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Release staging contains a symbolic link at ${archivePath}.`);
  }
  assertSafeArchivePath(archivePath);

  if (metadata.isDirectory()) {
    const name = archivePath.endsWith('/') ? archivePath : `${archivePath}/`;
    entries.push({ contents: Buffer.alloc(0), mode: 0o755, name, type: 'directory' });
    const children = (await readdir(filePath)).sort(compareText);
    for (const child of children) {
      await collectTarEntries(path.join(filePath, child), `${name}${child}`, entries);
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(
      `Release staging contains unsupported file type at ${archivePath}.`,
    );
  }

  entries.push({
    contents: await readFile(filePath),
    mode: path.basename(archivePath) === 'cli.mjs' ? 0o755 : 0o644,
    name: archivePath,
    type: 'file',
  });
}

function createTarHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  if (name.length > 100) {
    throw new Error(`Tar path is longer than 100 bytes: ${entry.name}`);
  }
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  name.copy(header, 0);
  writeTarOctal(header, 100, 8, entry.mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, entry.contents.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(entry.type === 'directory' ? '5' : '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  header.write(checksumText, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length > length - 1) {
    throw new Error(`Tar numeric value ${String(value)} exceeds its field.`);
  }
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function normalizeZipEntry(entry) {
  assertSafeArchivePath(entry.name);
  const directory = entry.name.endsWith('/');
  const contents = Buffer.from(entry.contents);
  if (directory && contents.length !== 0) {
    throw new Error(`ZIP directory ${entry.name} must not contain data.`);
  }
  return {
    contents,
    mode: directory ? 0o755 : entry.mode === 0o755 ? 0o755 : 0o644,
    name: entry.name,
  };
}

function findZipEnd(archive) {
  if (archive.length < 22) {
    throw new Error('ZIP end-of-central-directory record was not found.');
  }
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      return offset;
    }
  }
  throw new Error('ZIP end-of-central-directory record was not found.');
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(contents) {
  let value = 0xffffffff;
  for (const byte of contents) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertSafeArchivePath(value) {
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  if (
    normalized.length === 0 ||
    normalized !== normalized.trim() ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.includes(':') ||
    hasControlCharacter(normalized) ||
    normalized
      .split('/')
      .some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe archive path ${value}.`);
  }
}

function assertFlatFileName(value) {
  if (
    path.basename(value) !== value ||
    value === '.' ||
    value === '..' ||
    value.includes('\\') ||
    value.includes(':') ||
    hasControlCharacter(value)
  ) {
    throw new Error(`Expected a flat release file name, found ${value}.`);
  }
}

function assertBufferRange(buffer, offset, length, description) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(`${description} exceeds the ZIP file bounds.`);
  }
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function decodeZipName(contents, flags) {
  if ((flags & ZIP_UTF8_FLAG) === 0) {
    if (contents.some((byte) => byte > 0x7f)) {
      throw new Error('Non-UTF-8 ZIP entry names must contain only ASCII bytes.');
    }
    return contents.toString('ascii');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    throw new Error('ZIP entry name is not valid UTF-8.');
  }
}

function assertExactFileSet(actual, expected, message) {
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((fileName) => !actual.has(fileName));
  const extra = [...actual].filter((fileName) => !expectedSet.has(fileName));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${message}: missing [${missing.sort(compareText).join(', ')}], extra [${extra
        .sort(compareText)
        .join(', ')}].`,
    );
  }
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/gu, '\n');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isReplaceError(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error.code === 'EEXIST' || error.code === 'EPERM')
  );
}

export function inspectTarGzip(archive) {
  if (archive.length < 10 || archive.readUInt32LE(4) !== 0 || archive[9] !== 0xff) {
    throw new Error('Server gzip metadata is not deterministic.');
  }
  const tar = gunzipSync(archive);
  if (tar.length < TAR_BLOCK_SIZE * 2 || tar.length % TAR_BLOCK_SIZE !== 0) {
    throw new Error('Tar payload has invalid block padding.');
  }
  const entries = [];
  const names = new Set();
  let offset = 0;
  let foundEnd = false;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      if (
        tar.length - offset < TAR_BLOCK_SIZE * 2 ||
        !tar.subarray(offset).every((byte) => byte === 0)
      ) {
        throw new Error('Tar payload has an invalid end marker.');
      }
      foundEnd = true;
      break;
    }
    const name = readNullTerminated(header.subarray(0, 100));
    assertSafeArchivePath(name);
    if (names.has(name)) {
      throw new Error(`Tar archive contains duplicate entry ${name}.`);
    }
    names.add(name);
    const mode = readTarOctal(header, 100, 8, `${name} mode`);
    const uid = readTarOctal(header, 108, 8, `${name} uid`);
    const gid = readTarOctal(header, 116, 8, `${name} gid`);
    const size = readTarOctal(header, 124, 12, `${name} size`);
    const mtime = readTarOctal(header, 136, 12, `${name} mtime`);
    const expectedChecksum = readTarOctal(header, 148, 8, `${name} checksum`);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Tar header checksum is invalid for ${name}.`);
    }
    const type = String.fromCharCode(header[156]);
    if (type !== '0' && type !== '5') {
      throw new Error(`Tar entry ${name} uses unsupported type ${type}.`);
    }
    if ((type === '5') !== name.endsWith('/') || (type === '5' && size !== 0)) {
      throw new Error(`Tar entry ${name} has inconsistent directory metadata.`);
    }
    const dataStart = offset + TAR_BLOCK_SIZE;
    if (dataStart + size > tar.length) {
      throw new Error(`Tar entry ${name} exceeds the payload bounds.`);
    }
    entries.push({
      contents: Buffer.from(tar.subarray(dataStart, dataStart + size)),
      gid,
      mode,
      mtime,
      name,
      type,
      uid,
    });
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  if (!foundEnd) {
    throw new Error('Tar payload is missing its end marker.');
  }
  return entries;
}

function readTarOctal(buffer, offset, length, description) {
  const value = readNullTerminated(buffer.subarray(offset, offset + length));
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`Tar ${description} is not valid octal.`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Tar ${description} exceeds the safe integer range.`);
  }
  return parsed;
}

function readNullTerminated(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('ascii');
}
