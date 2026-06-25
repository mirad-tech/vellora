import { readFile, writeFile } from 'node:fs/promises';

import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

export async function replaceExecutableIcon(executablePath, iconPath) {
  const executable = NtExecutable.from(await readFile(executablePath));
  const resources = NtExecutableResource.from(executable);
  const icon = Data.IconFile.from(await readFile(iconPath));
  const iconGroups = Resource.IconGroupEntry.fromEntries(resources.entries);

  if (iconGroups.length === 0) {
    throw new Error(`No icon group found in ${executablePath}.`);
  }

  for (const iconGroup of iconGroups) {
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      iconGroup.id,
      iconGroup.lang,
      icon.icons.map((item) => item.data)
    );
  }

  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
}
