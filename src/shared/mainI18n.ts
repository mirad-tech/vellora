const zhMessages: Record<string, string> = {
  '文件路径无效。': '文件路径无效。',
  '只能打开 .md 或 .markdown 文件。': '只能打开 .md 或 .markdown 文件。',
  '选择的路径不是文件。': '选择的路径不是文件。',
  '文件不存在或已被移动。': '文件不存在或已被移动。',
  '无法读取文件，请检查权限或文件状态。': '无法读取文件，请检查权限或文件状态。',
  '保存内容无效。': '保存内容无效。',
  '只能保存 .md 或 .markdown 文件。': '只能保存 .md 或 .markdown 文件。',
  '保存失败，请检查权限或文件状态。': '保存失败，请检查权限或文件状态。',
  '无法用默认编辑器打开文件。': '无法用默认编辑器打开文件。',
  '未选择文件。': '未选择文件。',
  '未选择文件夹。': '未选择文件夹。',
  '链接无效。': '链接无效。',
  '已阻止不安全链接。': '已阻止不安全链接。',
  '只能打开 Markdown 链接或安全外部链接。': '只能打开 Markdown 链接或安全外部链接。',
  '图片路径无效。': '图片路径无效。',
  '仅支持当前 Markdown 文件旁的相对路径图片。': '仅支持当前 Markdown 文件旁的相对路径图片。',
  '不支持该图片类型。': '不支持该图片类型。',
  '图片不存在或已被移动。': '图片不存在或已被移动。',
  '图片过大，已跳过。': '图片过大，已跳过。',
  '无法读取图片，请检查权限或文件状态。': '无法读取图片，请检查权限或文件状态。',
  '文件夹路径无效。': '文件夹路径无效。',
  '选择的路径不是文件夹。': '选择的路径不是文件夹。',
  '文件夹不存在或已被移动。': '文件夹不存在或已被移动。',
  '无法读取文件夹，请检查权限或文件状态。': '无法读取文件夹，请检查权限或文件状态。',
  '已取消导出。': '已取消导出。',
  'PDF 导出失败。': 'PDF 导出失败。'
};

const enMessages: Record<string, string> = {
  '文件路径无效。': 'Invalid file path.',
  '只能打开 .md 或 .markdown 文件。': 'Only .md or .markdown files can be opened.',
  '选择的路径不是文件。': 'The selected path is not a file.',
  '文件不存在或已被移动。': 'File not found or has been moved.',
  '无法读取文件，请检查权限或文件状态。': 'Cannot read file. Check permissions or file status.',
  '保存内容无效。': 'Invalid save content.',
  '只能保存 .md 或 .markdown 文件。': 'Only .md or .markdown files can be saved.',
  '保存失败，请检查权限或文件状态。': 'Save failed. Check permissions or file status.',
  '无法用默认编辑器打开文件。': 'Cannot open file with default editor.',
  '未选择文件。': 'No file selected.',
  '未选择文件夹。': 'No folder selected.',
  '链接无效。': 'Invalid link.',
  '已阻止不安全链接。': 'Unsafe link blocked.',
  '只能打开 Markdown 链接或安全外部链接。': 'Only Markdown links or safe external links can be opened.',
  '图片路径无效。': 'Invalid image path.',
  '仅支持当前 Markdown 文件旁的相对路径图片。': 'Only relative path images next to the current Markdown file are supported.',
  '不支持该图片类型。': 'Unsupported image type.',
  '图片不存在或已被移动。': 'Image not found or has been moved.',
  '图片过大，已跳过。': 'Image too large, skipped.',
  '无法读取图片，请检查权限或文件状态。': 'Cannot read image. Check permissions or file status.',
  '文件夹路径无效。': 'Invalid folder path.',
  '选择的路径不是文件夹。': 'The selected path is not a folder.',
  '文件夹不存在或已被移动。': 'Folder not found or has been moved.',
  '无法读取文件夹，请检查权限或文件状态。': 'Cannot read folder. Check permissions or file status.',
  '已取消导出。': 'Export cancelled.',
  'PDF 导出失败。': 'PDF export failed.'
};

export function translateErrorMessage(message: string, lang: 'zh' | 'en'): string {
  if (lang === 'zh') return zhMessages[message] ?? message;
  return enMessages[message] ?? message;
}
