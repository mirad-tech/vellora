/**
 * Historical WDIO browser runner retained for repository history.
 * The supported browser E2E command is npm run test:e2e.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wdioBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wdio.cmd' : 'wdio'
);

const conf = 'legacy/wdio-browser/wdio.conf.js';

const child = spawn(wdioBin, ['run', conf], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env
});

child.on('exit', (code) => process.exit(code ?? 1));
