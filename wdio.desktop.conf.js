/**
 * Desktop E2E against release Vellora.exe using external tauri-driver + msedgedriver.
 * No WDIO Tauri Rust/frontend plugins; no invoke mocks.
 *
 * Launch via: npm run test:e2e:desktop  (scripts in tests/e2e/run-desktop.mjs)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.resolve(
  __dirname,
  'src-tauri',
  'target',
  'release',
  process.platform === 'win32' ? 'vellora.exe' : 'vellora'
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sourceMd = process.env.VELLORA_E2E_SOURCE;
const session = process.env.VELLORA_E2E_SESSION;

if (!sourceMd || !fs.existsSync(sourceMd)) {
  console.error('VELLORA_E2E_SOURCE must point to an existing source.md (set by run-desktop.mjs)');
  process.exit(1);
}
if (!session || !UUID_RE.test(session)) {
  console.error(
    'VELLORA_E2E_SESSION must be a UUID (set by run-desktop.mjs). Got: ' +
      String(session ?? '(missing)')
  );
  process.exit(1);
}
if (!fs.existsSync(appBinary)) {
  console.error(`Missing ${appBinary}`);
  process.exit(1);
}

/** @type {import('@wdio/types').Options.Testrunner} */
export const config = {
  runner: 'local',
  specs: ['./tests/e2e/smoke.desktop.spec.js'],
  maxInstances: 1,
  hostname: '127.0.0.1',
  port: Number(process.env.TAURI_DRIVER_PORT || 4444),
  path: '/',
  capabilities: [
    {
      maxInstances: 1,
      browserName: 'wry',
      // WDIO v9 defaults to WebDriver BiDi and can stick on about:blank,
      // never seeing the Tauri WebView (http://tauri.localhost/). Force classic.
      'wdio:enforceWebDriverClassic': true,
      webSocketUrl: false,
      'tauri:options': {
        application: appBinary,
        // Markdown path + session token. Rust recovers WebDriver-prefixed
        // Windows paths like `--C:\path\file.md` (see launch_args.rs).
        args: [sourceMd, `--vellora-e2e-session=${session}`]
      }
    }
  ],
  logLevel: 'warn',
  waitforTimeout: 20000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 1,
  // External tauri-driver is started by run-desktop.mjs; no service plugins.
  services: [],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 180000
  }
};
