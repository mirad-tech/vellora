/**
 * Golden scenario generator.
 *
 * Runs the frozen baseline's own import/serialize pipeline to produce the
 * expected Markdown bytes for neutral operations. The output is the standard
 * answer the native engine must reproduce; it is generated from source, not
 * hand-written.
 *
 * Run from the repository root:
 *   npx vitest run --config native/tools/goldens/vitest.config.ts
 */
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterAll, test } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { editorExtensions } from '../../../src/editor/extensions';
import { exportMarkdown } from '../../../src/editor/exportMarkdown';
import { documentLineEnding, importMarkdown } from '../../../src/editor/markdownDocument';

type Operation =
  | { kind: 'appendAtEnd'; text: string }
  | { kind: 'insertAtStart'; text: string };

type Scenario = { id: string; source: string; operation: Operation; expected: string };

const scenarios: { id: string; source: string; operation: Operation }[] = [
  { id: 'paragraph-append', source: 'hello\n', operation: { kind: 'appendAtEnd', text: '!' } },
  {
    id: 'heading-body-append',
    source: '# Title\n\nbody text\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'list-append',
    source: '- alpha\n- beta\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'ordered-list-append',
    source: '1. first\n2. second\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'nested-list-append',
    source: '- alpha\n  - nested\n- beta\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'table-append',
    source: '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'code-append',
    source: '```js\nconst value = 1;\n```\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'quote-append',
    source: '> quoted line\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'frontmatter-append',
    source: '---\ntitle: "Report"\ntags: [one, two]\n---\n\nbody\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'crlf-append',
    source: '# Title\r\n\r\nbody\r\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'cjk-emoji-append',
    source: '# 标题\n\n中文正文 😀 mix\n',
    operation: { kind: 'appendAtEnd', text: '好' }
  },
  {
    id: 'raw-html-append',
    source: '<div class="note">raw</div>\n\nbody\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'task-list-append',
    source: '- [ ] todo\n- [x] done\n\nbody\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'reference-link-append',
    source: '[link][doc]\n\n[doc]: ./old.md "Title"\n\nbody\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'inline-format-append',
    source: '**bold** and *italic* and `code` and ~~gone~~\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'image-append',
    source: '![alt](./pic.png)\n',
    operation: { kind: 'appendAtEnd', text: '!' }
  },
  {
    id: 'start-insert',
    source: 'body\n',
    operation: { kind: 'insertAtStart', text: 'X' }
  }
];

const results: Scenario[] = [];

for (const scenario of scenarios) {
  const editor = new Editor({
    extensions: editorExtensions(),
    content: importMarkdown(scenario.source),
    enableInputRules: false,
    enablePasteRules: false
  });
  editor.state.doc.check();

  // Neutral operation: the caret goes to the end of the last text block (or the
  // start of the first), exactly like a user pressing Ctrl+End / Ctrl+Home.
  // ProseMirror positions are deliberately not part of the scenario contract.
  const selection =
    scenario.operation.kind === 'appendAtEnd'
      ? TextSelection.atEnd(editor.state.doc)
      : TextSelection.atStart(editor.state.doc);
  editor.view.dispatch(editor.state.tr.insertText(scenario.operation.text, selection.from));

  const exported = exportMarkdown(editor).replace(/\r\n|\r|\n/g, documentLineEnding(scenario.source));
  results.push({ ...scenario, expected: exported });
  editor.destroy();
}

afterAll(() => {
  const outDir = 'native/tests/golden';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/scenarios.json`, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
});

test('emits golden scenarios from the frozen baseline', () => {
  if (results.length !== scenarios.length) throw new Error('scenario count mismatch');
});
