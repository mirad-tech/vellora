import { afterEach, describe, expect, test } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { editorExtensions } from './extensions';
import { importMarkdown } from './markdownDocument';
import { sourceOffsetForPosition } from './sourcePosition';
import { exportMarkdown } from './exportMarkdown';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const editors: Editor[] = [];
function open(source: string) {
  const editor = new Editor({ extensions: editorExtensions(), content: importMarkdown(source),
    enableInputRules: false, enablePasteRules: false });
  editors.push(editor);
  editor.state.doc.check();
  return editor;
}
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); });

describe('continuous Markdown document conversion', () => {
  test.each([
    ['\uFEFF---\r\ntitle: 文档\r\n---\r\n\r\n重复段落\r\n\r\n重复段落', '重复段落', '重复段落'],
    ['# 标题\n\n- 第一项\n\n  列表内段落\n', '列表内段落', '  列表内段落'],
    ['# 标题\n\n```js\nconst value = 123;\n```', 'const value', '```js'],
    ['# 标题\n\n<span>说明</span> 特殊段落', '特殊段落', '<span>'],
    ['# 标题\n\n- [ ] 任务\n- [x] 完成', '完成', '- [ ]'],
    ['\uFEFF---\r\ntitle: 文档\r\n---\r\n\r\n正文', 'title:', '\uFEFF---'],
  ])('maps a visible block to its original source without changing the document: %s', (source, text, start) => {
    const editor = open(source);
    let position = 0;
    editor.state.doc.descendants((node, pos) => { if (node.isTextblock && node.textContent.includes(text)) position = pos + 1; });
    const before = editor.getJSON();
    expect(sourceOffsetForPosition(editor.state.doc, source, position)).toBe(source.lastIndexOf(start));
    expect(editor.getJSON()).toEqual(before);
    expect(importMarkdown(source, new WeakMap())).toEqual(importMarkdown(source));
  });

  test('unmatched edited blocks fall back to a shared preceding heading or the caller scroll ratio', () => {
    const withHeading = open('# 标题\n\n正文');
    withHeading.commands.insertContentAt(withHeading.state.doc.content.size - 1, '已修改');
    expect(sourceOffsetForPosition(withHeading.state.doc, '# 标题\n\n正文', withHeading.state.doc.content.size - 2)).toBe(0);
    const noHeading = open('正文');
    noHeading.commands.insertContentAt(1, '已修改');
    expect(sourceOffsetForPosition(noHeading.state.doc, '正文', 2)).toBeNull();
  });
  test.each([
    '*a `code` b*', '**a `code` b**', '~~a `code` b~~',
    '**a *`code`* b**', '*a ![图](a.png) b*', '**a ![图](a.png) b**',
    '[a `code` b](./other.md)', '[a ![图](a.png) b](./other.md)',
    '**`first` and `last`**',
    '*a \ue0000\ue001 `\ue0000\ue001` ![图](a.png) b*',
  ])('keeps inline atom mark boundaries through three fresh imports: %s', source => {
    for (const input of [source, '## ' + source, '| H |\n| --- |\n| ' + source + ' |']) {
      let editor = open(input);
      const expected = editor.getJSON();
      for (let round = 0; round < 3; round += 1) {
        const saved = exportMarkdown(editor, round === 2);
        editor.destroy();
        editor = open(saved);
        expect(editor.getJSON(), saved).toEqual(expected);
      }
    }
  });

  test.each([
    '[link](https://example.com/?a=1&amp;amp;b=2 "&amp;copy;")',
    '![图](img&amp;amp;x.png "&amp;copy;")',
    '[![图](img&amp;copy;.png "&amp;quot;")](./a&amp;amp;b.md "&amp;lt;")',
  ])('retains literal entities in destinations and titles: %s', source => {
    let editor = open(source + '\n\n正文');
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: '追加' }] });
    const expected = editor.getJSON();
    for (let round = 0; round < 3; round += 1) {
      const saved = exportMarkdown(editor);
      editor.destroy();
      editor = open(saved);
      expect(editor.getJSON(), saved).toEqual(expected);
    }
  });

  test.each(['>', '-', '1.', '> >', '-\n  -', '- ```js\n  code\n  ```'])('imports valid empty containers with schema-valid children: %s', source => {
    let editor = open(source + '\n\n正文');
    const expected = editor.getJSON();
    for (let round = 0; round < 3; round += 1) {
      const saved = exportMarkdown(editor);
      editor.destroy();
      editor = open(saved);
      expect(editor.getJSON(), saved).toEqual(expected);
    }
  });

  test.each([
    { type: 'text', text: 'A|B' },
    { type: 'text', text: '|first\\|middle|last|' },
    { type: 'text', text: 'a\\|b', marks: [{ type: 'bold' }] },
    { type: 'text', text: '  a\\|b  |  c  ', marks: [{ type: 'code' }] },
    { type: 'text', text: 'a|b', marks: [{ type: 'link', attrs: { href: './other.md', title: '标题|末尾' } }] },
    { type: 'image', attrs: { src: 'img.png', alt: '图[1]\\|*说明*', title: '标题|末尾' } },
  ] satisfies JSONContent[])('preserves every table cell containing $type $text through three fresh imports', content => {
    for (const column of [0, 1, 2]) {
      let editor = open('');
      const cells = (type: string) => [0, 1, 2].map(index => ({
        type, attrs: { align: ['left', 'center', 'right'][index] },
        content: [{ type: 'paragraph', content: [index === column ? content : { type: 'text', text: 'KEEP-' + index }] }],
      }));
      editor.commands.setContent({ type: 'doc', content: [{ type: 'table', content: [
        { type: 'tableRow', content: cells('tableHeader') },
        { type: 'tableRow', content: cells('tableCell') },
        { type: 'tableRow', content: [
          { type: 'tableCell', attrs: { align: 'left' }, content: [{ type: 'paragraph' }] },
          { type: 'tableCell', attrs: { align: 'center' }, content: [{ type: 'paragraph', content: [
            { type: 'text', text: 'first' }, { type: 'hardBreak' }, { type: 'text', text: 'second' },
          ] }] },
          { type: 'tableCell', attrs: { align: 'right' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'LAST' }] }] },
        ] },
      ] }] });
      const expected = editor.getJSON();
      for (let round = 0; round < 3; round += 1) {
        const saved = exportMarkdown(editor);
        editors.splice(editors.indexOf(editor), 1);
        editor.destroy();
        editor = open(saved);
        expect(editor.getJSON(), saved).toEqual(expected);
      }
    }
  });

  test.each([
    [String.raw`图\[1\]`, '图[1]'],
    [String.raw`a\\b`, 'a\\b'],
    ['`name`', 'name'],
    ['*强调*与**中文**', '强调与中文'],
    ['&copy; &amp;copy;', '© &copy;'],
    ['外层![内层](inner.png)', '外层内层'],
    ['第一行\n第二行', '第一行\n第二行'],
  ])('preserves the expected image alt for %j after unrelated edits', (label, expected) => {
    let editor = open('![' + label + '](img.png "标题")\n\n正文');
    expect(editor.state.doc.firstChild!.firstChild!.attrs.alt).toBe(expected);
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: '追加' }] });
    for (let round = 0; round < 3; round += 1) {
      const saved = exportMarkdown(editor);
      editors.splice(editors.indexOf(editor), 1);
      editor.destroy();
      editor = open(saved);
      expect(editor.state.doc.firstChild!.firstChild!.attrs).toMatchObject({ src: 'img.png', alt: expected, title: '标题' });
      expect(editor.state.doc.textContent).toContain('追加');
    }
  });

  test('exports user-entered image alt as literal text', () => {
    const editor = open('![图](img.png)');
    const alt = '*literal* `code` [1] \\ &copy; <tag>';
    editor.commands.setNodeSelection(1);
    editor.commands.updateAttributes('image', { alt });
    expect(open(exportMarkdown(editor)).state.doc.firstChild!.firstChild!.attrs.alt).toBe(alt);
  });

  test('retains image alt with unsupported tokens as source rather than dropping content', () => {
    const source = '![文字<span>原始内容</span>](img.png)';
    const editor = open(source);
    expect(editor.state.doc.firstChild!.type.name).toBe('rawSource');
    expect(exportMarkdown(editor)).toBe(source);
  });

  test.each(['01-headings-paragraphs.md', '02-lists-quotes.md', '03-table.md', '04-code.md', '05-links-html.md'])(
    'round-trips the existing render fixture %s', name => {
      const editor = open(readFileSync(join(process.cwd(), 'tests/fixtures/markdown', name), 'utf8'));
      expect(open(exportMarkdown(editor)).getJSON()).toEqual(editor.getJSON());
    });

  test('imports headings, formatted text, nested lists and table cells as editable nodes', () => {
    const editor = open('# 标题\n\n**粗体** 与 `代码`\n\n- 父项\n  - 子项\n\n| A | B |\n| :--- | ---: |\n| 一 | 二 |');
    const types: string[] = [];
    editor.state.doc.descendants(node => { types.push(node.type.name); });
    expect(types).toContain('heading');
    expect(types.filter(type => type === 'bulletList')).toHaveLength(2);
    expect(types.filter(type => type === 'tableCell')).toHaveLength(2);
    expect(types).not.toContain('rawSource');
    const reopened = open(exportMarkdown(editor));
    expect(reopened.state.doc.textContent).toBe(editor.state.doc.textContent);
    expect(reopened.getJSON()).toEqual(editor.getJSON());
  });

  test.each(['a  \n\n', '\tindented\nend ', '', 'a\n```\nb\n````', '中文 & < > \\'])('preserves code body %j when saving and reopening', body => {
    const editor = open('~~~~~unknown metadata\n' + body + (body ? '\n' : '') + '~~~~~');
    const code = editor.state.doc.firstChild!;
    expect(code.type.name).toBe('codeBlock');
    expect(code.textContent).toBe(body);
    const reopened = open(exportMarkdown(editor));
    expect(reopened.state.doc.firstChild!.textContent).toBe(body);
    expect(reopened.state.doc.firstChild!.attrs.language).toBe('unknown metadata');
  });

  test('retains HTML, comments and reference definitions when another paragraph is edited', () => {
    const source = '<!-- secret comment -->\n\n<section><strong>内容</strong></section>\n\n正文 <span>文字</span>\n\n[链接][ref]\n\n[ref]: ./other.md "title"';
    const editor = open(source);
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: '新正文' }] });
    const saved = exportMarkdown(editor);
    expect(saved).toContain('<!-- secret comment -->');
    expect(saved).toContain('<section><strong>内容</strong></section>');
    expect(saved).toContain('正文 <span>文字</span>');
    expect(saved).toContain('[ref]: ./other.md "title"');
    expect(open(saved).state.doc.textContent).toContain('新正文');
  });

  test('preserves unsafe HTML as source without rendering it as executable DOM', () => {
    const editor = open('<script>window.unsafe = true</script>');
    expect(exportMarkdown(editor)).toContain('<script>');
    expect(editor.view.dom.querySelector('script')).toBeNull();
  });

  test('preserves image metadata, link target and title without live network URLs', () => {
    const editor = open('![图片](assets/image.png "图片标题")\n\n[链接](https://example.com "链接标题")');
    expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toBeNull();
    expect(editor.view.dom.querySelector('a')?.getAttribute('href')).toBe('#');
    const saved = exportMarkdown(editor);
    expect(saved).toContain('assets/image.png');
    expect(saved).toContain('图片标题');
    expect(saved).toContain('链接标题');
  });

  test('ordinary inserted punctuation remains text after export', () => {
    const editor = open('');
    editor.view.dispatch(editor.state.tr.insertText('# literal **not bold** <test>'));
    const saved = exportMarkdown(editor);
    const reopened = open(saved);
    expect(reopened.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(reopened.state.doc.textContent).toBe('# literal **not bold** <test>');
    expect(reopened.getJSON().content?.[0].content?.[0].marks ?? []).toEqual([]);
  });

  test('edits across blocks and undoes them as a document transaction', () => {
    const editor = open('第一段\n\n第二段');
    const before = editor.getJSON();
    editor.commands.setTextSelection({ from: 2, to: 8 });
    editor.commands.deleteSelection();
    expect(editor.getJSON()).not.toEqual(before);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  test.each(['a`b', '`edge`', '  code  ', '```', '   '])('exports literal inline code %j without delimiter loss', text => {
    const editor = open('正文');
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text, marks: [{ type: 'code' }] }
    ] }] });
    expect(open(exportMarkdown(editor)).state.doc.textContent, exportMarkdown(editor)).toBe(text);
    expect(open(exportMarkdown(editor)).getJSON().content?.[0].content?.[0].marks).toContainEqual({ type: 'code' });
  });

  test('bold inline code keeps both marks after export', () => {
    const editor = open('**`a`**');
    const saved = exportMarkdown(editor);
    const reopened = open(saved);
    expect(reopened.state.doc.textContent).toBe('a');
    expect(reopened.getJSON().content?.[0].content?.[0].marks?.map(mark => mark.type).sort(), saved + JSON.stringify(editor.getJSON())).toEqual(['bold', 'code']);
  });

  test('quoted link and image titles and balanced destination parentheses survive editing', () => {
    const editor = open('[链接](./a\\(b\\).md "标题 \\"引号\\"")\n\n[![图\\[1\\]](assets/a\\(b\\).png "图片 \\"引号\\"")](https://example.com)');
    const saved = exportMarkdown(editor);
    expect(open(saved).getJSON()).toEqual(editor.getJSON());
  });

  test('table hard breaks and empty paragraphs remain structural after saving', () => {
    const editor = open('| A |\n| --- |\n| 一<br>二 |\n\n&nbsp;\n\n末尾');
    const saved = exportMarkdown(editor);
    const reopened = open(saved);
    expect(reopened.getJSON()).toEqual(editor.getJSON());
  });

  test('new table rows inherit column alignment and undo with their insertion', () => {
    const editor = open('| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |');
    const original = editor.getJSON();
    editor.commands.setTextSelection(3);
    editor.commands.addRowAfter();
    const expected = editor.getJSON();
    const insertedRow = editor.state.doc.firstChild!.child(1);
    expect(Array.from({ length: insertedRow.childCount }, (_, index) => insertedRow.child(index).attrs.align))
      .toEqual(['left', 'center', 'right']);
    const saved = exportMarkdown(editor);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(original);
    expect(open(saved).getJSON()).toEqual(expected);
  });

  test.each(['    indented text', '1. literal list', '---', '| A | B |\n:--- | ---:', '> literal quote'])('typed paragraph %j cannot turn into another block type', text => {
    const editor = open('');
    editor.view.dispatch(editor.state.tr.insertText(text));
    const reopened = open(exportMarkdown(editor));
    expect(reopened.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(reopened.state.doc.textContent).toBe(text);
  });
});
