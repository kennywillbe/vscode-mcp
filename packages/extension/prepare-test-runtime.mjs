import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const runtimeDirectory = join('/tmp', `vmcp-test-${uid}`);

await rm(runtimeDirectory, { force: true, recursive: true });
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
await chmod(runtimeDirectory, 0o700);
