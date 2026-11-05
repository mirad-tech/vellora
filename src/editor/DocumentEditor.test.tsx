import { createRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { DocumentEditor, type DocumentEditorHandle } from './DocumentEditor';

afterEach(cleanup);

test.each([
  ['two\n\ntwo changed', 2, 1],
  ['one\n\ntwo changed', 1, 0],
  ['two\n\ntwo\n\ntwo', 3, 1],
  ['one\n\nnone', 0, -1],
])('restores search after source import %j', async (content, count, activeIndex) => {
  const ref = createRef<DocumentEditorHandle>();
  const onSearch = vi.fn();
  const onChange = vi.fn();
  const props = { ref, content: 'two\n\ntwo', active: true, disabled: false, images: {},
    query: 'two', searchIndex: 1, onChange, onSearch, onOutline: vi.fn(), onOpenLink: vi.fn(),
    onError: vi.fn(), onRecover: vi.fn() };
  const view = render(<DocumentEditor {...props} />);
  await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith({ count: 2, activeIndex: 1 }));
  view.rerender(<DocumentEditor {...props} active={false} />);
  view.rerender(<DocumentEditor {...props} active={false} content={content} />);
  view.rerender(<DocumentEditor {...props} content={content} />);
  expect(onSearch).toHaveBeenLastCalledWith({ count, activeIndex });
  expect(view.container.querySelectorAll('[data-search-hit]').length).toBe(count);
  expect(view.container.querySelectorAll('[data-active-search]').length).toBe(count ? 1 : 0);
  expect(onChange).not.toHaveBeenCalled();
  expect(ref.current!.editor!.can().undo()).toBe(false);
  const selection = ref.current!.editor!.state.selection.toJSON();
  view.rerender(<DocumentEditor {...props} content={content} query="one" />);
  expect(ref.current!.editor!.state.selection.toJSON()).toEqual(selection);
  act(() => { expect(ref.current!.flush()).toBe(content); });
});
