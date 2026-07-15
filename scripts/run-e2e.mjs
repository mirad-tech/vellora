/**
 * Default E2E runner (browser mode).
 * Desktop binary E2E: npm run test:e2e:desktop
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wdioBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wdio.cmd' : 'wdio'
);

const conf = process.argv[2] === 'desktop' ? 'wdio.desktop.conf.js' : 'wdio.conf.js';

const child = spawn(wdioBin, ['run', conf], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env
});

child.on('exit', (code) => process.exit(code ?? 1));
