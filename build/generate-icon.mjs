import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const iconSizes = [16, 32, 48, 64, 128, 256];
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const svgPath = join(sourceDirectory, 'icon.svg');
const generatedIconPath = join(sourceDirectory, 'icon-generated.png');
const pngPath = join(sourceDirectory, 'icon.png');
const icoPath = join(sourceDirectory, 'icon.ico');

function createIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, index) => {
    const entryOffset = index * 16;
    directory[entryOffset] = size === 256 ? 0 : size;
    directory[entryOffset + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(png.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

async function renderSvg(browser, svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`
    <style>
      html, body { margin: 0; overflow: hidden; }
      svg { display: block; width: ${size}px; height: ${size}px; }
    </style>
    ${svg.replace('href="icon-generated.png"', `href="data:image/png;base64,${(await readFile(generatedIconPath)).toString('base64')}"`)}
  `);

  const png = await page.locator('svg').screenshot({ type: 'png' });
  await page.close();
  return png;
}

const svg = await readFile(svgPath, 'utf8');
const browser = await chromium.launch({ headless: true });

try {
  const png = await renderSvg(browser, svg, 512);
  const images = await Promise.all(iconSizes.map(async (size) => ({
    size,
    png: await renderSvg(browser, svg, size)
  })));

  await writeFile(pngPath, png);
  await writeFile(icoPath, createIco(images));
} finally {
  await browser.close();
}
