import { join } from 'node:path';

import { replaceExecutableIcon } from './updateExecutableIcon.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const executablePath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = join(context.packager.info.buildResourcesDir, 'icon.ico');
  await replaceExecutableIcon(executablePath, iconPath);
}
