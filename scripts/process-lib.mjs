import { spawn } from 'node:child_process';

export function runCommand(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${arguments_.join(' ')} failed (${signal ?? `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}

export function captureCommand(command, arguments_) {
  return new Promise((resolve) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', () => resolve(undefined));
    child.once('exit', (code) => resolve(code === 0 ? output.trim() : undefined));
  });
}
