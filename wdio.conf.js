/**
 * Browser E2E via Chrome DevTools protocol (no chromedriver download).
 * Starts Vite, launches system Chrome/Edge with puppeteer-core style CDP.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = 'http://127.0.0.1:1420';

function waitForUrl(url, timeoutMs = 120000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Dev server not ready: ${url}`));
        } else {
          setTimeout(tick, 400);
        }
      });
    };
    tick();
  });
}

let devProc;

/** @type {import('@wdio/types').Options.Testrunner} */
export const config = {
  runner: 'local',
  specs: ['./tests/e2e/smoke.spec.js'],
  maxInstances: 1,
  // CDP avoids downloading chromedriver (blocked on this network).
  automationProtocol: 'devtools',
  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--headless=new', '--disable-gpu', '--window-size=1280,800', '--no-sandbox']
      }
    }
  ],
  logLevel: 'warn',
  baseUrl: DEV_URL,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  services: [],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000
  },
  async onPrepare() {
    devProc = spawn('npm', ['run', 'dev:web'], {
      cwd: __dirname,
      stdio: 'ignore',
      shell: true,
      env: { ...process.env, BROWSER: 'none' }
    });
    await waitForUrl(DEV_URL);
  },
  async onComplete() {
    if (devProc && !devProc.killed) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(devProc.pid), '/T', '/F'], { shell: true });
      } else {
        devProc.kill('SIGTERM');
      }
    }
  }
};
