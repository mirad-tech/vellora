import { Buffer } from 'node:buffer';

import { describe, expect, test, vi } from 'vitest';

import { exportWindowToPdf } from './pdfExport';

function createWindow(pdfData = Buffer.from('%PDF-1.7')) {
  return {
    webContents: {
      printToPDF: vi.fn().mockResolvedValue(pdfData)
    }
  };
}

describe('PDF export backend', () => {
  test('prints the focused window with backgrounds and writes the chosen PDF path', async () => {
    const pdfData = Buffer.from('%PDF generated');
    const window = createWindow(pdfData);
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: 'G:\\exports\\document.pdf'
    });
    const writeFile = vi.fn().mockResolvedValue(undefined);

    const result = await exportWindowToPdf(window, {
      showSaveDialog,
      writeFile
    });

    expect(result).toEqual({ ok: true });
    expect(window.webContents.printToPDF).toHaveBeenCalledWith({ printBackground: true });
    expect(showSaveDialog).toHaveBeenCalledWith(window, {
      title: '导出 PDF',
      defaultPath: 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    expect(writeFile).toHaveBeenCalledWith('G:\\exports\\document.pdf', pdfData);
  });

  test('returns a cancel result without writing when the save dialog is canceled', async () => {
    const window = createWindow();
    const writeFile = vi.fn();

    const result = await exportWindowToPdf(window, {
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
      writeFile
    });

    expect(result).toEqual({ ok: false, message: '已取消导出。' });
    expect(writeFile).not.toHaveBeenCalled();
  });

  test('returns a recoverable failure when PDF generation fails', async () => {
    const window = createWindow();
    window.webContents.printToPDF.mockRejectedValueOnce(new Error('print failed'));

    const result = await exportWindowToPdf(window, {
      showSaveDialog: vi.fn(),
      writeFile: vi.fn()
    });

    expect(result).toEqual({ ok: false, message: 'PDF 导出失败。' });
  });
});
