import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { collectMarkdownReferences, renderMarkdownDocument, type MarkdownReferences } from '../markdown/renderMarkdown';
import { headingId } from '../markdown/headingIds';

type Heading = { text: string; level: number; pos: number; size: number; source: 'node' | 'raw'; index?: number };
type Metadata = { headings: Heading[]; images: string[] };
type RenderContext = { key: string; references: MarkdownReferences };
type Preview = { html: string; headings: Array<{ text: string; level: number }>; images: string[] };
type DocumentMetadata = {
  headings: Array<Heading & { id: string }>;
  images: string[];
  context: RenderContext;
  rawHeadingIds: Map<number, string[]>;
};
const emptyContext: RenderContext = { key: '{}', references: {} };
const metadataCache = new WeakMap<ProseMirrorNode, { key: string; metadata: Metadata }>();
const previewCache = new WeakMap<ProseMirrorNode, { key: string; preview: Preview }>();
const documentCache = new WeakMap<ProseMirrorNode, DocumentMetadata>();
const referenceCache = new WeakMap<ProseMirrorNode, { nodes: ProseMirrorNode[]; context: RenderContext }>();

function rawPreview(node: ProseMirrorNode, context: RenderContext): Preview {
  const cached = previewCache.get(node);
  if (cached?.key === context.key) return cached.preview;
  const rendered = renderMarkdownDocument(node.textContent, undefined, context);
  const html = rendered.status === 'ready' ? rendered.html : '';
  const template = document.createElement('template');
  template.innerHTML = html;
  const preview = {
    html,
    headings: Array.from(template.content.querySelectorAll('[data-heading-id]'))
      .filter(heading => /^H[1-6]$/.test(heading.tagName))
      .map(heading => ({ text: heading.textContent?.trim() ?? '', level: Number(heading.tagName.slice(1)) })),
    images: Array.from(template.content.querySelectorAll('img[data-local-src]'), image => image.getAttribute('data-local-src') ?? ''),
  };
  previewCache.set(node, { key: context.key, preview });
  return preview;
}

export function rawSourcePreview(node: ProseMirrorNode, context: RenderContext = emptyContext): string {
  return rawPreview(node, context).html;
}

function documentRenderContext(doc: ProseMirrorNode): RenderContext {
  const nodes: ProseMirrorNode[] = [];
  doc.descendants(node => {
    if (node.type.name === 'rawSource') nodes.push(node);
    return !node.isTextblock;
  });
  if (!nodes.length) return emptyContext;
  const cached = referenceCache.get(nodes[0]);
  if (cached && cached.nodes.length === nodes.length && nodes.every((node, index) => node === cached.nodes[index])) return cached.context;
  const references = collectMarkdownReferences(nodes.map(node => node.textContent));
  const context = { references, key: JSON.stringify(references) };
  referenceCache.set(nodes[0], { nodes, context });
  return context;
}

// ProseMirror reuses unchanged subtrees. Cache their metadata rather than walking
// every text node again for body input or selection changes.
function collectMetadata(node: ProseMirrorNode, context: RenderContext): Metadata {
  const cached = metadataCache.get(node);
  if (cached?.key === context.key) return cached.metadata;
  const result: Metadata = { headings: [], images: [] };
  if (node.type.name === 'heading') {
    result.headings.push({ text: node.textContent, level: node.attrs.level, pos: 0, size: node.nodeSize, source: 'node' });
  }
  if (node.type.name === 'image') result.images.push(String(node.attrs.src ?? ''));
  if (node.type.name === 'rawSource') {
    const preview = rawPreview(node, context);
    result.images.push(...preview.images);
    result.headings.push(...preview.headings.map((heading, index) => ({ ...heading, pos: 0, size: node.nodeSize, source: 'raw' as const, index })));
  } else if (!node.isText) {
    node.forEach((child, offset) => {
      const metadata = collectMetadata(child, context);
      const start = offset + (node.type.name === 'doc' ? 0 : 1);
      result.headings.push(...metadata.headings.map(heading => ({ ...heading, pos: start + heading.pos })));
      result.images.push(...metadata.images);
    });
  }
  metadataCache.set(node, { key: context.key, metadata: result });
  return result;
}

export function documentMetadata(doc: ProseMirrorNode): DocumentMetadata {
  const cached = documentCache.get(doc);
  if (cached) return cached;
  const context = documentRenderContext(doc);
  const metadata = collectMetadata(doc, context);
  const seen = new Map<string, number>();
  const rawHeadingIds = new Map<number, string[]>();
  const headings = metadata.headings.map(heading => {
    const id = headingId(heading.text, seen);
    if (heading.source === 'raw') {
      const ids = rawHeadingIds.get(heading.pos) ?? [];
      ids[heading.index!] = id;
      rawHeadingIds.set(heading.pos, ids);
    }
    return { ...heading, id };
  });
  const result = { headings, images: metadata.images, context, rawHeadingIds };
  documentCache.set(doc, result);
  return result;
}
