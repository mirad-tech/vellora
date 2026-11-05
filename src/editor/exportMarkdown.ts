import type { Editor, JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';

function prepareCodeSpans(node: JSONContent): JSONContent {
  if (node.type === 'text' && node.marks?.some(mark => mark.type === 'code')) {
    return { type: 'serializedCode', marks: node.marks.filter(mark => mark.type !== 'code'),
      content: [{ type: 'text', text: node.text }] };
  }
  const content = node.content?.map(prepareCodeSpans);
  // Keep each inline run together so marks span text, code and images without
  // the Markdown manager closing/reopening delimiters around every inline atom.
  if (content && ['paragraph', 'heading'].includes(node.type ?? '') &&
    content.some(child => child.type === 'serializedCode' || child.type === 'image')) {
    return { ...node, content: [{ type: 'serializedInline', content }] };
  }
  return { ...node, ...(content ? { content } : {}) };
}

export function exportMarkdown(editor: Editor, freshManager = false): string {
  const manager = freshManager ? new MarkdownManager({ extensions: editor.extensionManager.extensions }) : editor.markdown;
  if (!manager) throw new Error('Markdown serializer is unavailable');
  return manager.serialize(prepareCodeSpans(editor.getJSON()));
}
