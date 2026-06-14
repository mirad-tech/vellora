import type { Buffer } from 'node:buffer';

import type { PdfExportResult } from '../shared/documentTypes';

type PrintToPdfOptions = {
  printBackground: boolean;
};

export type PdfExportTargetWindow = {
  webContents: {
    printToPDF: (options: PrintToPdfOptions) => Promise<Buffer>;
  };
};

type SaveDialogOptions = {
  title: string;
  defaultPath: string;
  filters: Array<{
    name: string;
    extensions: string[];
  }>;
};

type SaveDialogResult = {
  canceled: boolean;
  filePath?: string;
};

export type PdfExportDependencies = {
  showSaveDialog: (
    window: PdfExportTargetWindow,
    options: SaveDialogOptions
  ) => Promise<SaveDialogResult>;
  writeFile: (filePath: string, data: Buffer) => Promise<void>;
};

export async function exportWindowToPdf(
  window: PdfExportTargetWindow,
  dependencies: PdfExportDependencies
): Promise<PdfExportResult> {
  try {
    const pdfData = await window.webContents.printToPDF({ printBackground: true });
    const result = await dependencies.showSaveDialog(window, {
      title: '导出 PDF',
      defaultPath: 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, code: 'CANCELED', message: '已取消导出。' };
    }

    await dependencies.writeFile(result.filePath, pdfData);
    return { ok: true };
  } catch {
    return { ok: false, code: 'EXPORT_FAILED', message: 'PDF 导出失败。' };
  }
}
