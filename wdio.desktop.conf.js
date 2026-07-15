/**
 * Desktop E2E against release Vellora.exe (embedded WebDriver).
 * Requires:
 *   - npm run build:web && cargo build --manifest-path src-tauri/Cargo.toml --release
 *   - Working download of msedgedriver matching local Edge (or pre-installed)
 *   - tauri-plugin-wdio + tauri-plugin-wdio-webdriver registered (already in lib.rs)
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

if (!fs.existsSync(appBinary)) {
  console.error(`Missing ${appBinary}`);
  process.exit(1);
}

/** @type {import('@wdio/types').Options.Testrunner} */
export const config = {
  runner: 'local',
  specs: ['./tests/e2e/smoke.desktop.spec.js'],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: appBinary
      }
    }
  ],
  logLevel: 'warn',
  waitforTimeout: 20000,
  connectionRetryTimeout: 180000,
  services: [
    [
      '@wdio/tauri-service',
      {
        driverProvider: 'embedded',
        autoInstallTauriDriver: true
      }
    ]
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 180000
  }
};
