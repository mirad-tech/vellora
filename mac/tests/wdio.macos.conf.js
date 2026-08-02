import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appBinary = path.join(root, 'src-tauri', 'target', 'debug', 'vellora');
const source = process.env.VELLORA_E2E_SOURCE;

if (process.platform !== 'darwin') throw new Error('This WebdriverIO config is macOS-only.');
if (!source || !fs.existsSync(source)) throw new Error('VELLORA_E2E_SOURCE is missing.');
if (!fs.existsSync(appBinary)) throw new Error(`Vellora debug binary is missing: ${appBinary}`);

/** @type {import('@wdio/types').Options.Testrunner} */
export const config = {
  runner: 'local',
  specs: [path.join(root, 'mac', 'tests', 'specs', 'vellora.macos.e2e.js')],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'tauri',
      'wdio:enforceWebDriverClassic': true,
      webSocketUrl: false
    }
  ],
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: appBinary,
        appArgs: [source],
        driverProvider: 'embedded',
        embeddedPort: Number(process.env.WDIO_EMBEDDED_PORT || 4445),
        startTimeout: 120000,
        statusPollTimeout: 10000,
        captureBackendLogs: false,
        captureFrontendLogs: false,
        logLevel: 'warn'
      }
    ]
  ],
  logLevel: 'warn',
  waitforTimeout: 20000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 180000
  }
};
