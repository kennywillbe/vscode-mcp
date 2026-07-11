import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertReleaseVersions,
  buildDeterministicZip,
  createChecksumFile,
  createCycloneDxBom,
  createDeterministicTarGzip,
  createReleaseManifest,
  createThirdPartyNotices,
  inspectTarGzip,
  readZipEntries,
  serializeJson,
  sha256Buffer,
  stageServerArchive,
  verifyReleaseDirectory,
} from './release-lib.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe('release version preflight', () => {
  it('rejects a mismatched workspace package before packaging', async () => {
    const root = await temporaryDirectory();
    for (const [relativePath, version] of [
      ['package.json', '1.0.0'],
      ['packages/extension/package.json', '1.0.0'],
      ['packages/server/package.json', '0.9.0'],
      ['packages/protocol/package.json', '1.0.0'],
    ]) {
      const destination = path.join(root, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, JSON.stringify({ version }));
    }
    const before = await snapshotDirectory(root);

    await expect(assertReleaseVersions(root)).rejects.toThrow(
      'packages/server/package.json: expected 1.0.0, found 0.9.0',
    );
    expect(await snapshotDirectory(root)).toEqual(before);
  });
});

describe('deterministic release archives', () => {
  it('creates byte-identical tar.gz files with fixed metadata', async () => {
    const root = await temporaryDirectory();
    const bundle = path.join(root, 'vscode-mcp-server');
    await mkdir(bundle);
    await writeFile(path.join(bundle, 'README.md'), 'read me\n');
    await writeFile(path.join(bundle, 'cli.mjs'), '#!/usr/bin/env node\n');

    const first = await createDeterministicTarGzip(root, 'vscode-mcp-server');
    await utimes(
      path.join(bundle, 'README.md'),
      new Date(1_700_000_000_000),
      new Date(),
    );
    const second = await createDeterministicTarGzip(root, 'vscode-mcp-server');

    expect(second).toEqual(first);
    expect(first.readUInt32LE(4)).toBe(0);
    expect(first[9]).toBe(0xff);
    expect(
      inspectTarGzip(first).map(({ mode, mtime, name, type }) => ({
        mode,
        mtime,
        name,
        type,
      })),
    ).toEqual([
      {
        mode: 0o755,
        mtime: 0,
        name: 'vscode-mcp-server/',
        type: '5',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/README.md',
        type: '0',
      },
      {
        mode: 0o755,
        mtime: 0,
        name: 'vscode-mcp-server/cli.mjs',
        type: '0',
      },
    ]);
  });

  it('normalizes ZIP order, timestamps, compression, and modes', () => {
    const entries = [
      { name: 'extension/', contents: Buffer.alloc(0), mode: 0o755 },
      { name: 'extension/package.json', contents: Buffer.from('{}\n'), mode: 0o644 },
      { name: '[Content_Types].xml', contents: Buffer.from('<Types/>\n'), mode: 0o644 },
    ];

    const first = buildDeterministicZip(entries);
    const second = buildDeterministicZip([...entries].reverse());

    expect(second).toEqual(first);
    expect(
      readZipEntries(first).map(({ contents, mode, name }) => ({
        contents: contents.toString('utf8'),
        mode,
        name,
      })),
    ).toEqual([
      { contents: '<Types/>\n', mode: 0o644, name: '[Content_Types].xml' },
      { contents: '', mode: 0o755, name: 'extension/' },
      { contents: '{}\n', mode: 0o644, name: 'extension/package.json' },
    ]);
  });

  it('rejects duplicate, traversal, drive, alternate-stream, and control paths', () => {
    const entry = (name) => ({ contents: Buffer.alloc(0), mode: 0o644, name });

    expect(() =>
      buildDeterministicZip([entry('extension/file'), entry('extension/file')]),
    ).toThrow('ZIP contains duplicate entry extension/file.');
    for (const unsafeName of [
      '../escape',
      '/absolute',
      'C:/drive-path',
      'extension/file:stream',
      'extension/\0control',
      'extension//empty',
      'extension/leading ',
      ' extension/trailing',
    ]) {
      expect(() => buildDeterministicZip([entry(unsafeName)])).toThrow(
        'Unsafe archive path',
      );
    }
  });

  it('rejects whitespace-preserving TAR names instead of aliasing them', async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, 'filex'));
    await writeFile(path.join(root, 'filex', 'contents'), 'contents');
    const archive = await createDeterministicTarGzip(root, 'filex');
    const tar = gunzipSync(archive);
    tar[4] = 0x20;
    rewriteTarHeaderChecksum(tar, 0);
    const tampered = gzipSync(tar, { level: 9, mtime: 0 });
    tampered.writeUInt32LE(0, 4);
    tampered[9] = 0xff;

    expect(() => inspectTarGzip(tampered)).toThrow('Unsafe archive path file /.');
  });

  it('rejects a local ZIP header name that disagrees with the central directory', () => {
    const archive = buildDeterministicZip([
      { contents: Buffer.from('contents'), mode: 0o644, name: 'safe.txt' },
    ]);
    Buffer.from('../x.txt').copy(archive, 30);

    expect(() => readZipEntries(archive)).toThrow(
      'ZIP entry safe.txt has inconsistent local metadata.',
    );
  });

  it('stages the exact deterministic standalone CLI archive contents', async () => {
    const repositoryRoot = await temporaryDirectory();
    const destinationDirectory = path.join(repositoryRoot, 'candidate');
    for (const [relativePath, contents] of [
      ['packages/server/dist/cli.mjs', '#!/usr/bin/env node\nconsole.log("ok");\n'],
      [
        'packages/server/package.json',
        serializeJson({
          name: '@vscode-mcp/server',
          version: '1.0.0',
          engines: { node: '^22.13.0' },
        }),
      ],
      ['packages/server/README.md', 'server readme\n'],
      ['docs/installation.md', 'install guide\n'],
      ['docs/agent-usage-guide.md', 'agent guide\n'],
      ['docs/tool-contract-v1.0.md', 'tool contract\n'],
      ['PRIVACY.md', 'privacy policy\n'],
      ['SECURITY.md', 'security policy\n'],
      ['SUPPORT.md', 'support policy\n'],
      ['LICENSE', 'project license\n'],
      ['NOTICE', 'project notice\n'],
      ['THIRD_PARTY_NOTICES.md', 'dependency notices\n'],
    ]) {
      const destination = path.join(repositoryRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
    await mkdir(destinationDirectory);

    const archivePath = await stageServerArchive({
      destinationDirectory,
      repositoryRoot,
      version: '1.0.0',
    });
    const archive = await readFile(archivePath);
    const entries = inspectTarGzip(archive);

    expect(
      entries.map(({ mode, mtime, name, type }) => ({ mode, mtime, name, type })),
    ).toEqual([
      { mode: 0o755, mtime: 0, name: 'vscode-mcp-server/', type: '5' },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/AGENT_USAGE.md',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/INSTALLATION.md',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/LICENSE',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/NOTICE',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/PRIVACY.md',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/README.md',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/SECURITY.md',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/SUPPORT.md',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/THIRD_PARTY_NOTICES.md',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/TOOL_CONTRACT.md',
        type: '0',
      },
      {
        mode: 0o755,
        mtime: 0,
        name: 'vscode-mcp-server/cli.mjs',
        type: '0',
      },
      {
        mode: 0o644,
        mtime: 0,
        name: 'vscode-mcp-server/package.json',
        type: '0',
      },
    ]);
    expect(archive.includes(Buffer.from(repositoryRoot))).toBe(false);
    expect(await readdir(destinationDirectory)).toEqual([
      'vscode-mcp-server-1.0.0.tar.gz',
    ]);
  });
});

describe('release metadata', () => {
  it('sorts checksums and manifest artifacts deterministically', async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, 'z.txt'), 'z\n');
    await writeFile(path.join(root, 'a.txt'), 'a\n');

    expect(await createChecksumFile(root, ['z.txt', 'a.txt'])).toBe(
      `${sha256Buffer(Buffer.from('a\n'))}  a.txt\n${sha256Buffer(
        Buffer.from('z\n'),
      )}  z.txt\n`,
    );

    const manifest = createReleaseManifest({
      artifacts: [
        { file: 'z.txt', mediaType: 'text/plain', role: 'test', sha256: 'z', size: 2 },
        { file: 'a.txt', mediaType: 'text/plain', role: 'test', sha256: 'a', size: 2 },
      ],
      nodeEngine: '^22.13.0',
      version: '1.0.0',
      vscodeEngine: '^1.101.0',
    });
    expect(manifest.artifacts.map((artifact) => artifact.file)).toEqual([
      'a.txt',
      'z.txt',
    ]);
    expect(manifest.compatibility).toMatchObject({
      operatingSystems: ['darwin', 'linux'],
      explicitlyUnsupportedOperatingSystems: ['win32'],
      localDesktopOnly: true,
      versionMatchedComponents: true,
    });
    expect(serializeJson(manifest)).not.toContain(new Date().getFullYear().toString());
  });

  it('rejects duplicate checksum inputs and requires exact checksum/manifest coverage', async () => {
    const root = await temporaryDirectory();
    await writeValidReleaseDirectory(root);
    await expect(createChecksumFile(root, ['README.md', 'README.md'])).rejects.toThrow(
      'Cannot checksum duplicate release file README.md.',
    );

    await expect(verifyReleaseDirectory(root)).resolves.toBeUndefined();

    await writeFile(path.join(root, 'unreviewed.txt'), 'unreviewed\n');
    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'SHA256SUMS coverage does not match the release directory',
    );

    await writeFile(
      path.join(root, 'SHA256SUMS'),
      await createChecksumFile(
        root,
        (await readdir(root)).filter((fileName) => fileName !== 'SHA256SUMS'),
      ),
    );
    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'Release manifest coverage does not match the candidate payloads',
    );
  });

  it('rejects invalid artifact metadata and non-canonical manifest order', async () => {
    const root = await temporaryDirectory();
    await writeValidReleaseDirectory(root);
    const manifestPath = path.join(root, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts[0].role = 'unexpected';
    await writeFile(manifestPath, serializeJson(manifest));
    await rewriteChecksums(root);

    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'Release manifest contains invalid role or media type',
    );

    await writeValidReleaseDirectory(root);
    const reordered = JSON.parse(await readFile(manifestPath, 'utf8'));
    reordered.artifacts.reverse();
    await writeFile(manifestPath, serializeJson(reordered));
    await rewriteChecksums(root);

    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'Release manifest artifacts are not in canonical filename order.',
    );
  });

  it('rejects version drift inside checksummed VSIX and server archives', async () => {
    const root = await temporaryDirectory();
    await writeValidReleaseDirectory(root);

    const vsixPath = path.join(root, 'vscode-mcp-extension-1.0.0.vsix');
    const vsixEntries = readZipEntries(await readFile(vsixPath));
    const extensionPackage = vsixEntries.find(
      ({ name }) => name === 'extension/package.json',
    );
    const extensionManifest = JSON.parse(extensionPackage.contents.toString('utf8'));
    extensionManifest.version = '9.9.9';
    extensionPackage.contents = Buffer.from(serializeJson(extensionManifest));
    await replaceReleaseArtifact(root, vsixPath, buildDeterministicZip(vsixEntries));
    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'VSIX extension manifest does not match the 1.0 contract.',
    );

    await writeValidReleaseDirectory(root);
    const serverPath = path.join(root, 'vscode-mcp-server-1.0.0.tar.gz');
    const serverEntries = inspectTarGzip(await readFile(serverPath));
    const serverStage = path.join(root, '.tampered-server', 'vscode-mcp-server');
    await mkdir(serverStage, { recursive: true });
    for (const entry of serverEntries) {
      if (entry.type !== '0') {
        continue;
      }
      const destination = path.join(root, '.tampered-server', entry.name);
      await mkdir(path.dirname(destination), { recursive: true });
      const contents =
        entry.name === 'vscode-mcp-server/package.json'
          ? Buffer.from(
              serializeJson({
                ...JSON.parse(entry.contents.toString('utf8')),
                version: '9.9.9',
              }),
            )
          : entry.contents;
      await writeFile(destination, contents);
    }
    const tamperedServer = await createDeterministicTarGzip(
      path.dirname(serverStage),
      'vscode-mcp-server',
    );
    await rm(path.join(root, '.tampered-server'), { force: true, recursive: true });
    await replaceReleaseArtifact(root, serverPath, tamperedServer);
    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'Server archive package metadata does not match the 1.0 contract.',
    );
  });

  it('rejects a malformed Marketplace icon inside a checksummed VSIX', async () => {
    const root = await temporaryDirectory();
    await writeValidReleaseDirectory(root);
    const vsixPath = path.join(root, 'vscode-mcp-extension-1.0.0.vsix');
    const entries = readZipEntries(await readFile(vsixPath));
    const icon = entries.find(({ name }) => name === 'extension/images/icon.png');
    icon.contents = Buffer.from('not-a-png');
    await replaceReleaseArtifact(root, vsixPath, buildDeterministicZip(entries));

    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'VSIX Marketplace icon must be a 256x256 RGBA PNG.',
    );
  });

  it('reads active VSIX XML structure and ignores metadata hidden in comments', async () => {
    const root = await temporaryDirectory();
    await writeValidReleaseDirectory(root);
    const vsixPath = path.join(root, 'vscode-mcp-extension-1.0.0.vsix');
    const entries = readZipEntries(await readFile(vsixPath));
    const manifest = entries.find(({ name }) => name === 'extension.vsixmanifest');
    const source = manifest.contents.toString('utf8');
    manifest.contents = Buffer.from(
      source.replace(
        '<Identity Language="en-US" Id="vscode-mcp" Version="1.0.0" Publisher="vscode-mcp"/>',
        '<!-- <Identity Language="en-US" Id="vscode-mcp" Version="1.0.0" Publisher="vscode-mcp"/> --><Identity Language="en-US" Id="vscode-mcp" Version="1.0.0" Publisher="attacker"/>',
      ),
    );
    await replaceReleaseArtifact(root, vsixPath, buildDeterministicZip(entries));

    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'VSIX package manifest identity or engine is invalid.',
    );
  });

  it('rejects a checksummed SBOM whose dependency graph is incomplete', async () => {
    const root = await temporaryDirectory();
    await writeValidReleaseDirectory(root);
    const sbomFileName = 'vscode-mcp-1.0.0.cdx.json';
    const sbomPath = path.join(root, sbomFileName);
    const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
    sbom.dependencies = [];
    const sbomContents = Buffer.from(serializeJson(sbom));
    await writeFile(sbomPath, sbomContents);

    const manifestPath = path.join(root, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const artifact = manifest.artifacts.find(({ file }) => file === sbomFileName);
    artifact.sha256 = sha256Buffer(sbomContents);
    artifact.size = sbomContents.length;
    await writeFile(manifestPath, serializeJson(manifest));
    await rewriteChecksums(root);

    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'Release SBOM dependency coverage does not match its components',
    );
  });

  it('rejects SBOM components disconnected from the release root', async () => {
    const root = await temporaryDirectory();
    await writeValidReleaseDirectory(root);
    const sbomFileName = 'vscode-mcp-1.0.0.cdx.json';
    const sbomPath = path.join(root, sbomFileName);
    const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
    const disconnectedRef = 'pkg:npm/disconnected@1.0.0';
    sbom.components.push({
      ...sbom.components[0],
      'bom-ref': disconnectedRef,
      name: 'disconnected',
      purl: disconnectedRef,
      version: '1.0.0',
    });
    sbom.dependencies.push({ dependsOn: [], ref: disconnectedRef });
    const contents = Buffer.from(serializeJson(sbom));
    await writeFile(sbomPath, contents);

    const manifestPath = path.join(root, 'release-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const artifact = manifest.artifacts.find(({ file }) => file === sbomFileName);
    artifact.sha256 = sha256Buffer(contents);
    artifact.size = contents.length;
    await writeFile(manifestPath, serializeJson(manifest));
    await rewriteChecksums(root);

    await expect(verifyReleaseDirectory(root)).rejects.toThrow(
      'Release SBOM contains components disconnected from the release root',
    );
  });

  it('creates a stable CycloneDX 1.5 BOM without local paths', () => {
    const component = {
      bomRef: 'pkg:npm/zod@4.4.3',
      description: 'schema validation',
      externalReferences: [],
      license: 'MIT',
      name: 'zod',
      packageDirectory: '/private/local/path',
      purl: 'pkg:npm/zod@4.4.3',
      roles: new Set(['server', 'extension']),
      type: 'library',
      version: '4.4.3',
      workspace: false,
    };
    const graph = {
      components: new Map([[component.bomRef, component]]),
      dependencies: new Map([
        ['pkg:generic/vscode-mcp-release@1.0.0', new Set([component.bomRef])],
        [component.bomRef, new Set()],
      ]),
      rootRef: 'pkg:generic/vscode-mcp-release@1.0.0',
      version: '1.0.0',
    };

    const first = serializeJson(createCycloneDxBom(graph));
    const second = serializeJson(createCycloneDxBom(graph));
    expect(second).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
    });
    expect(first).not.toContain('/private/local/path');
  });

  it('embeds installed dependency license text without its local path', async () => {
    const packageDirectory = await temporaryDirectory();
    await writeFile(path.join(packageDirectory, 'LICENSE'), 'Example license text\n');
    const component = {
      bomRef: 'pkg:npm/example@1.2.3',
      externalReferences: [{ type: 'vcs', url: 'https://example.com/source' }],
      license: 'MIT',
      name: 'example',
      packageDirectory,
      roles: new Set(['server']),
      version: '1.2.3',
      workspace: false,
    };
    const notices = await createThirdPartyNotices({
      components: new Map([[component.bomRef, component]]),
      dependencies: new Map([[component.bomRef, new Set()]]),
      version: '1.0.0',
    });

    expect(notices).toContain('Example license text');
    expect(notices).toContain('https://example.com/source');
    expect(notices).not.toContain(packageDirectory);
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vscode-mcp-release-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function snapshotDirectory(root) {
  const names = (await readdir(root, { recursive: true })).sort();
  const files = [];
  for (const name of names) {
    try {
      files.push([name, await readFile(path.join(root, name), 'utf8')]);
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'EISDIR') {
        throw error;
      }
    }
  }
  return files;
}

async function writeValidReleaseDirectory(root) {
  const component = {
    bomRef: 'pkg:npm/zod@4.4.3',
    externalReferences: [],
    license: 'MIT',
    name: 'zod',
    packageDirectory: '/not-serialized',
    purl: 'pkg:npm/zod@4.4.3',
    roles: new Set(['server']),
    type: 'library',
    version: '4.4.3',
    workspace: false,
  };
  const rootRef = 'pkg:generic/vscode-mcp-release@1.0.0';
  const sbom = serializeJson(
    createCycloneDxBom({
      components: new Map([[component.bomRef, component]]),
      dependencies: new Map([
        [rootRef, new Set([component.bomRef])],
        [component.bomRef, new Set()],
      ]),
      rootRef,
      version: '1.0.0',
    }),
  );
  const vsix = buildDeterministicZip([
    {
      name: '[Content_Types].xml',
      mode: 0o644,
      contents: Buffer.from(
        '<Types><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>\n',
      ),
    },
    {
      name: 'extension.vsixmanifest',
      mode: 0o644,
      contents: Buffer.from(
        '<PackageManifest><Metadata><Identity Language="en-US" Id="vscode-mcp" Version="1.0.0" Publisher="vscode-mcp"/><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.101.0" /></Properties></Metadata><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" /></Assets></PackageManifest>\n',
      ),
    },
    {
      name: 'extension/images/icon.png',
      mode: 0o644,
      contents: Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000100000001000806',
        'hex',
      ),
    },
    ...[
      ['extension/LICENSE.txt', 'license\n'],
      ['extension/NOTICE', 'notice\n'],
      ['extension/PRIVACY.md', 'privacy\n'],
      ['extension/SUPPORT.md', 'support\n'],
      ['extension/THIRD_PARTY_NOTICES.md', 'third party\n'],
      ['extension/changelog.md', 'changelog\n'],
      ['extension/dist/extension.js', '(()=>{"vscode-mcp":"1.0.0"})();\n'],
      [
        'extension/package.json',
        serializeJson({
          name: 'vscode-mcp',
          publisher: 'vscode-mcp',
          version: '1.0.0',
          private: true,
          type: 'commonjs',
          main: './dist/extension.js',
          icon: 'images/icon.png',
          engines: { vscode: '^1.101.0' },
          homepage: 'https://github.com/kennywillbe/vscode-mcp#readme',
          repository: {
            type: 'git',
            url: 'https://github.com/kennywillbe/vscode-mcp.git',
          },
          bugs: { url: 'https://github.com/kennywillbe/vscode-mcp/issues' },
          qna: 'https://github.com/kennywillbe/vscode-mcp/discussions',
          markdown: 'github',
          pricing: 'Free',
          keywords: [
            'mcp',
            'model-context-protocol',
            'ai',
            'coding-agent',
            'language-server',
            'lsp',
            'developer-tools',
            'automation',
          ],
          extensionKind: ['workspace'],
          capabilities: {
            untrustedWorkspaces: { supported: false },
            virtualWorkspaces: { supported: false },
          },
        }),
      ],
      ['extension/readme.md', 'readme\n'],
    ].map(([name, contents]) => ({
      name,
      mode: 0o644,
      contents: Buffer.from(contents),
    })),
  ]);
  const serverStage = path.join(root, '.server-fixture', 'vscode-mcp-server');
  await mkdir(serverStage, { recursive: true });
  for (const [name, contents] of [
    ['AGENT_USAGE.md', 'agent guide\n'],
    ['INSTALLATION.md', 'install\n'],
    ['LICENSE', 'license\n'],
    ['NOTICE', 'notice\n'],
    ['PRIVACY.md', 'privacy\n'],
    ['README.md', 'readme\n'],
    ['SECURITY.md', 'security\n'],
    ['SUPPORT.md', 'support\n'],
    ['THIRD_PARTY_NOTICES.md', 'third party\n'],
    ['TOOL_CONTRACT.md', 'tool contract\n'],
    ['cli.mjs', '#!/usr/bin/env node\nconst version="1.0.0";\n'],
    [
      'package.json',
      serializeJson({
        name: '@vscode-mcp/server',
        version: '1.0.0',
        private: true,
        type: 'module',
        engines: { node: '^22.13.0' },
        bin: { 'vscode-mcp': './cli.mjs' },
      }),
    ],
  ]) {
    await writeFile(path.join(serverStage, name), contents);
  }
  const server = await createDeterministicTarGzip(
    path.dirname(serverStage),
    'vscode-mcp-server',
  );
  await rm(path.join(root, '.server-fixture'), { force: true, recursive: true });
  const specifications = [
    ['vscode-mcp-extension-1.0.0.vsix', 'extension', 'application/vsix', vsix],
    ['vscode-mcp-server-1.0.0.tar.gz', 'server', 'application/gzip', server],
    ['vscode-mcp-1.0.0.cdx.json', 'sbom', 'application/vnd.cyclonedx+json', sbom],
    ['README.md', 'documentation', 'text/markdown', 'readme\n'],
    ['INSTALLATION.md', 'documentation', 'text/markdown', 'install\n'],
    ['AGENT_USAGE.md', 'documentation', 'text/markdown', 'agent guide\n'],
    ['RELEASE_NOTES.md', 'documentation', 'text/markdown', 'release notes\n'],
    ['PRIVACY.md', 'privacy-policy', 'text/markdown', 'privacy\n'],
    ['SECURITY.md', 'security-policy', 'text/markdown', 'security\n'],
    ['SUPPORT.md', 'support-policy', 'text/markdown', 'support\n'],
    ['TOOL_CONTRACT.md', 'documentation', 'text/markdown', 'tool contract\n'],
    ['LICENSE', 'license', 'text/plain', 'license\n'],
    ['NOTICE', 'notice', 'text/plain', 'notice\n'],
    ['THIRD_PARTY_NOTICES.md', 'third-party-notices', 'text/markdown', 'third party\n'],
  ];
  const artifacts = [];
  for (const [file, role, mediaType, value] of specifications) {
    const contents = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await writeFile(path.join(root, file), contents);
    artifacts.push({
      file,
      mediaType,
      role,
      sha256: sha256Buffer(contents),
      size: contents.length,
    });
  }
  await writeFile(
    path.join(root, 'release-manifest.json'),
    serializeJson(
      createReleaseManifest({
        artifacts,
        nodeEngine: '^22.13.0',
        version: '1.0.0',
        vscodeEngine: '^1.101.0',
      }),
    ),
  );
  await rewriteChecksums(root);
}

async function rewriteChecksums(root) {
  const fileNames = (await readdir(root)).filter(
    (fileName) => fileName !== 'SHA256SUMS',
  );
  await writeFile(
    path.join(root, 'SHA256SUMS'),
    await createChecksumFile(root, fileNames),
  );
}

async function replaceReleaseArtifact(root, artifactPath, contents) {
  await writeFile(artifactPath, contents);
  const manifestPath = path.join(root, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const artifact = manifest.artifacts.find(
    ({ file }) => file === path.basename(artifactPath),
  );
  artifact.sha256 = sha256Buffer(contents);
  artifact.size = contents.length;
  await writeFile(manifestPath, serializeJson(manifest));
  await rewriteChecksums(root);
}

function rewriteTarHeaderChecksum(tar, offset) {
  const header = tar.subarray(offset, offset + 512);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
}
