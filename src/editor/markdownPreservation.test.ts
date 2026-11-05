import { Editor } from '@tiptap/core';
import { afterEach, expect, test } from 'vitest';
import { editorExtensions } from './extensions';
import { exportMarkdown } from './exportMarkdown';
import { documentLineEnding, importMarkdown } from './markdownDocument';

const editors: Editor[] = [];
function open(source: string) {
  const editor = new Editor({ extensions: editorExtensions(), content: importMarkdown(source),
    enableInputRules: false, enablePasteRules: false });
  editors.push(editor);
  editor.state.doc.check();
  return editor;
}
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

const headers = ['', '\uFEFF'].flatMap(bom => ['---', '...'].flatMap(close => ['\n', '\r\n'].map(eol => ({ bom, close, eol }))));
test.each(headers)('preserves frontmatter bytes after an unrelated edit: %j', ({ bom, close, eol }) => {
  const header = [bom + '---', 'title: "Report"', 'tags: [one, two]', 'description: |', '  nested: value', close].join(eol);
  const source = header + eol + eol + 'body';
  let editor = open(source);
  expect(editor.state.doc.firstChild!.type.name).toBe('rawSource');
  editor.view.dispatch(editor.state.tr.insertText('X', editor.state.doc.content.size - 1));
  for (let round = 0; round < 3; round++) {
    const saved = exportMarkdown(editor).replace(/\r\n|\r|\n/g, documentLineEnding(source));
    expect(saved.slice(0, header.length)).toBe(header);
    expect(saved).toContain('bodyX');
    editor = open(saved);
  }
});

test.each([
  '1. first\n9) second',
  '0) zero\n\n   10. first nested\n   9) second nested\n1. next',
])('keeps ordered lists separate and preserves their start numbers after an unrelated edit: %j', block => {
  const editor = open('body\n\n' + block);
  editor.view.dispatch(editor.state.tr.insertText('!', 5));
  const reopened = open(exportMarkdown(editor));
  const [, first, second] = reopened.getJSON().content!;

  expect(reopened.state.doc.firstChild?.textContent).toBe('body!');
  expect([first?.type, second?.type]).toEqual(['orderedList', 'orderedList']);
  expect([first.attrs?.start, second.attrs?.start]).toEqual(block.startsWith('0') ? [0, 1] : [1, 9]);
  expect(reopened.getJSON()).toEqual(editor.getJSON());
});

test.each(['---\nnot closed\n\nbody', 'body\n\n---\ntitle: middle\n---'])('does not absorb ordinary Markdown into frontmatter: %j', source => {
  expect(open(source).getJSON().content?.some(node => node.type === 'rawSource')).toBe(false);
});

test.each([
  '- [ ] todo\n- [x] done\n- [X] also done',
  '* [ ] todo\n* ordinary item',
  '+ [x] done',
  '1. [ ] ordered task\n2. ordinary item',
  '- ordinary\n  - [ ] nested task\n  - [x] nested done',
  '> - [ ] quoted task\n> - ordinary item',
  '- [ ] task\n\n  continuation with **formatting**\n\n- ordinary',
])('preserves the original task container when another paragraph is edited: %j', block => {
  let editor = open(block + '\n\nbody');
  expect(editor.state.doc.firstChild!.type.name).toBe('rawSource');
  editor.view.dispatch(editor.state.tr.insertText('X', editor.state.doc.content.size - 1));
  for (let round = 0; round < 3; round++) {
    const saved = exportMarkdown(editor);
    expect(saved).toContain(block);
    expect(saved).toContain('bodyX');
    editor = open(saved);
  }
});

test.each([
  '- ordinary\n- other',
  '- \\[ ] literal',
  '- [x]not-a-task',
  '- `[ ]` code',
  '```md\n- [ ] example\n```',
])('retains normal editable nodes for non-task syntax: %j', source => {
  expect(open(source).getJSON().content?.some(node => node.type === 'rawSource')).toBe(false);
});

test.each([
  ['~lang`', 'code'],
  ['~~lang` metadata', 'code\n~~~\n~~~~~\nend'],
  ['~lang`', ''],
  ['js', 'const value = 1;'],
  ['', 'code\n```\n`````\nend'],
])('keeps fenced code and following prose separate after an unrelated edit: %j', (language, body) => {
  const source = '~~~~~~ ' + language + '\n' + body + (body ? '\n' : '') + '~~~~~~\n\nbody';
  let editor = open(source);
  editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1));
  for (let round = 0; round < 3; round++) {
    editor = open(exportMarkdown(editor));
    expect(editor.getJSON().content?.map(node => node.type)).toEqual(['codeBlock', 'paragraph']);
    expect(editor.state.doc.firstChild!.attrs.language).toBe(language || null);
    expect(editor.state.doc.firstChild!.textContent).toBe(body);
    expect(editor.state.doc.lastChild!.textContent).toBe('body!');
  }
});

test('serializes a code body with many delimiter runs without argument expansion', () => {
  const body = '~ '.repeat(150000).trim();
  const editor = open('~~~ lang`\n' + body + '\n~~~\n\nbody');
  editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1));
  const reopened = open(exportMarkdown(editor));
  expect(reopened.state.doc.childCount).toBe(2);
  expect(reopened.state.doc.firstChild!.textContent).toBe(body);
});

test.each([
  '[link][doc]', '[doc][]', '[doc]',
  '# [link][doc]',
  '- before\n  - [link][doc]\n- after',
  '> [link][doc]',
  '| column |\n| --- |\n| [link][doc] |',
  '![image][doc]',
  '![alt [link][doc]](./image.png)',
])('retains the whole reference-bearing block as source across saves: %j', block => {
  let editor = open(block + '\n\n[doc]: ./old.md "Title"\n\nbody');
  expect(editor.state.doc.firstChild!.type.name).toBe('rawSource');
  expect(editor.state.doc.firstChild!.textContent.replace(/\n+$/, '')).toBe(block);
  editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1));
  for (let round = 0; round < 3; round++) {
    const saved = exportMarkdown(editor);
    expect(saved).toContain(block);
    expect(saved).toContain('[doc]: ./old.md "Title"');
    expect(saved).toContain('body!');
    editor = open(saved);
    expect(editor.state.doc.firstChild!.textContent.replace(/\n+$/, '')).toBe(block);
  }
});

test.each([
  '[link](./old.md)', '![image](./old.md)',
  '`[link][doc]`', '\\[doc]', '[unresolved]',
  '[link](./old.md "Title") and ![image](./old.md)',
])('keeps native editing for inline syntax independent of definitions: %j', block => {
  const editor = open(block + '\n\n[doc]: ./old.md "Title"');
  expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
});
