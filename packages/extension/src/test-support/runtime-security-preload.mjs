import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const path = require('node:path');

function report(api, classification = 'forbidden') {
  if (typeof process.send === 'function') {
    process.send({
      source: 'vscode-mcp-runtime-security-guard',
      api,
      classification,
    });
  }
}

function forbidden(api) {
  return function forbiddenRuntimeCall() {
    report(api);
    throw new Error(`Runtime security guard blocked ${api}.`);
  };
}

function patchFunction(target, property, replacement) {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (descriptor?.writable === true || descriptor?.set !== undefined) {
    target[property] = replacement;
    return;
  }
  Object.defineProperty(target, property, {
    ...descriptor,
    configurable: true,
    value: replacement,
    writable: true,
  });
}

const net = require('node:net');
const originalCreateConnection = net.createConnection;
const originalSocketConnect = net.Socket.prototype.connect;

function localIpcEndpoint(args) {
  let endpoint = args[0];
  if (Array.isArray(endpoint)) {
    endpoint = endpoint[0];
  }
  if (
    typeof endpoint === 'object' &&
    endpoint !== null &&
    typeof endpoint.path === 'string'
  ) {
    endpoint = endpoint.path;
  }
  return typeof endpoint === 'string' &&
    (endpoint.startsWith('/') || endpoint.startsWith('\\\\.\\pipe\\vscode-mcp-'))
    ? endpoint
    : undefined;
}

function guardedCreateConnection(...args) {
  if (localIpcEndpoint(args) !== undefined) {
    report('node:net.createConnection', 'local-ipc');
    return Reflect.apply(originalCreateConnection, net, args);
  }

  report('node:net.createConnection');
  throw new Error('Runtime security guard blocked a non-local-IPC connection.');
}

patchFunction(net.Socket.prototype, 'connect', function guardedSocketConnect(...args) {
  if (localIpcEndpoint(args) !== undefined) {
    report('node:net.Socket.connect', 'local-ipc');
    return Reflect.apply(originalSocketConnect, this, args);
  }
  report('node:net.Socket.connect');
  throw new Error('Runtime security guard blocked a non-local-IPC socket.');
});
patchFunction(net, 'createConnection', guardedCreateConnection);
patchFunction(net, 'connect', guardedCreateConnection);
patchFunction(net, 'createServer', forbidden('node:net.createServer'));
patchFunction(net.Server.prototype, 'listen', forbidden('node:net.Server.listen'));

const guardedModules = [
  ['node:http', ['request', 'get', 'createServer']],
  ['node:https', ['request', 'get', 'createServer']],
  ['node:http2', ['connect', 'createServer', 'createSecureServer']],
  ['node:tls', ['connect', 'createServer']],
  ['node:dgram', ['createSocket']],
  ['node:child_process', ['exec', 'execFile', 'fork', 'spawn']],
  [
    'node:dns',
    [
      'lookup',
      'lookupService',
      'resolve',
      'resolve4',
      'resolve6',
      'resolveAny',
      'resolveCaa',
      'resolveCname',
      'resolveMx',
      'resolveNaptr',
      'resolveNs',
      'resolvePtr',
      'resolveSoa',
      'resolveSrv',
      'resolveTxt',
      'reverse',
    ],
  ],
];

for (const [moduleName, functions] of guardedModules) {
  const module = require(moduleName);
  for (const functionName of functions) {
    if (typeof module[functionName] === 'function') {
      patchFunction(module, functionName, forbidden(`${moduleName}.${functionName}`));
    }
  }
}

const dnsPromises = require('node:dns/promises');
for (const functionName of [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
]) {
  if (typeof dnsPromises[functionName] === 'function') {
    patchFunction(
      dnsPromises,
      functionName,
      forbidden(`node:dns/promises.${functionName}`),
    );
  }
}

const fs = require('node:fs');
const originalMkdir = fs.mkdir;
const originalMkdirSync = fs.mkdirSync;

function isApprovedRuntimeDirectory(value) {
  const xdgRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  if (typeof value !== 'string' || xdgRuntimeDirectory === undefined) {
    return false;
  }
  const runtimeRoot = path.resolve(xdgRuntimeDirectory, 'vscode-mcp');
  const candidate = path.resolve(value);
  return candidate === runtimeRoot || candidate.startsWith(`${runtimeRoot}${path.sep}`);
}

patchFunction(fs, 'mkdir', function guardedMkdir(...args) {
  if (isApprovedRuntimeDirectory(args[0])) {
    report('node:fs.mkdir', 'runtime-infrastructure');
    return Reflect.apply(originalMkdir, fs, args);
  }
  return forbidden('node:fs.mkdir')();
});
patchFunction(fs, 'mkdirSync', function guardedMkdirSync(...args) {
  if (isApprovedRuntimeDirectory(args[0])) {
    report('node:fs.mkdirSync', 'runtime-infrastructure');
    return Reflect.apply(originalMkdirSync, fs, args);
  }
  return forbidden('node:fs.mkdirSync')();
});

for (const functionName of [
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createWriteStream',
  'mkdtemp',
  'mkdtempSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'writeFile',
  'writeFileSync',
]) {
  if (typeof fs[functionName] === 'function') {
    patchFunction(fs, functionName, forbidden(`node:fs.${functionName}`));
  }
}

const fsPromises = require('node:fs/promises');
const originalPromisesMkdir = fsPromises.mkdir;
patchFunction(fsPromises, 'mkdir', async function guardedPromisesMkdir(...args) {
  if (isApprovedRuntimeDirectory(args[0])) {
    report('node:fs/promises.mkdir', 'runtime-infrastructure');
    return Reflect.apply(originalPromisesMkdir, fsPromises, args);
  }
  return forbidden('node:fs/promises.mkdir')();
});

for (const functionName of [
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'mkdtemp',
  'rename',
  'rm',
  'rmdir',
  'truncate',
  'unlink',
  'writeFile',
]) {
  if (typeof fsPromises[functionName] === 'function') {
    patchFunction(
      fsPromises,
      functionName,
      forbidden(`node:fs/promises.${functionName}`),
    );
  }
}

globalThis.fetch = forbidden('globalThis.fetch');
if ('WebSocket' in globalThis) {
  globalThis.WebSocket = forbidden('globalThis.WebSocket');
}
if ('EventSource' in globalThis) {
  globalThis.EventSource = forbidden('globalThis.EventSource');
}

syncBuiltinESMExports();
report('guard.ready', 'instrumentation');
