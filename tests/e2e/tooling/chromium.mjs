import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

export async function launchChromium() {
  const paths = process.env.BROWSER_PATH ? [process.env.BROWSER_PATH] : [
    ...['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
      .filter(name => process.env[name])
      .map(name => path.join(process.env[name], 'Google', 'Chrome', 'Application', 'chrome.exe')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  const executablePath = paths.find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw new Error('Chrome/Chromium is unavailable. Set BROWSER_PATH to its executable.');
  return puppeteer.launch({ executablePath, headless: true });
}
