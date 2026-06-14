import { describe, expect, test } from 'vitest';

import { translateErrorMessage, translateResultMessage } from './mainI18n';

describe('main process i18n helpers', () => {
  test('translates recent store errors for English UI', () => {
    expect(translateErrorMessage('无法读取最近打开记录。', 'en')).toBe('Cannot read recent items.');
  });

  test('translates failed IPC result messages without changing successful results', () => {
    const failed = translateResultMessage(
      {
        ok: false,
        code: 'INVALID_ARGUMENT',
        message: '文件路径无效。'
      },
      'en'
    );

    expect(failed).toEqual({
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: 'Invalid file path.'
    });

    const ok = { ok: true as const, value: 42 };
    expect(translateResultMessage(ok, 'en')).toBe(ok);
  });
});
