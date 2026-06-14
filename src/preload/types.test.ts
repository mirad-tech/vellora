import { describe, expectTypeOf, test } from 'vitest';

import type { MdViewerApi } from './types';
import type { PdfExportResult } from '../shared/documentTypes';

describe('preload native menu APIs', () => {
  test('exposes a menu action subscription and PDF export bridge', () => {
    expectTypeOf<MdViewerApi['onMenuAction']>().toEqualTypeOf<
      (callback: (action: string) => void) => () => void
    >();
    expectTypeOf<MdViewerApi['exportToPdf']>().toEqualTypeOf<() => Promise<PdfExportResult>>();
  });
});
