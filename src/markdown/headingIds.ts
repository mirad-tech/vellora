/** Shared by editable headings, source outlines and sanitized fragment previews. */
export function headingId(text: string, seen: Map<string, number>): string {
  const slug = text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const base = `heading-${slug || 'heading'}`;
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}
