import type { Editor, JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';

function prepareCodeSpans(node: JSONContent): JSONContent {
  if (node.type === 'text' && node.marks?.some(mark => mark.type === 'code')) {
    return { type: 'serializedCode', marks: node.marks.filter(mark => mark.type !== 'code'),
      content: [{ type: 'text', text: node.text }] };
  }
  return { ...node, ...(node.content ? { content: node.content.map(prepareCodeSpans) } : {}) };
}

export function exportMarkdown(editor: Editor, freshManager = false): string {
  const manager = freshManager ? new MarkdownManager({ extensions: editor.extensionManager.extensions }) : editor.markdown;
  if (!manager) throw new Error('Markdown serializer is unavailable');
  return manager.serialize(prepareCodeSpans(editor.getJSON()));
}
