export type SearchHighlightResult = {
  html: string;
  count: number;
  activeIndex: number;
};

function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function collectTextNodes(root: ParentNode): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style')) return NodeFilter.FILTER_REJECT;
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function highlightTextNode(textNode: Text, query: string, state: { count: number; activeIndex: number }): void {
  const source = textNode.textContent ?? '';
  const lowerSource = source.toLocaleLowerCase();
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  let matchIndex = lowerSource.indexOf(query, cursor);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      fragment.append(document.createTextNode(source.slice(cursor, matchIndex)));
    }

    const hitIndex = state.count;
    const mark = document.createElement('mark');
    mark.className = 'search-hit';
    mark.dataset.searchHit = String(hitIndex);
    if (hitIndex === state.activeIndex) {
      mark.dataset.activeSearch = 'true';
    }
    mark.textContent = source.slice(matchIndex, matchIndex + query.length);
    fragment.append(mark);

    state.count += 1;
    cursor = matchIndex + query.length;
    matchIndex = lowerSource.indexOf(query, cursor);
  }

  if (cursor === 0) return;

  if (cursor < source.length) {
    fragment.append(document.createTextNode(source.slice(cursor)));
  }

  textNode.replaceWith(fragment);
}

export function applySearchHighlights(
  html: string,
  rawQuery: string,
  requestedActiveIndex: number
): SearchHighlightResult {
  const query = normalizeQuery(rawQuery);
  if (!query) {
    return {
      html,
      count: 0,
      activeIndex: -1
    };
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  const textNodes = collectTextNodes(template.content);
  const state = {
    count: 0,
    activeIndex: Math.max(0, requestedActiveIndex)
  };

  for (const textNode of textNodes) {
    highlightTextNode(textNode, query, state);
  }

  if (state.count === 0) {
    return {
      html,
      count: 0,
      activeIndex: -1
    };
  }

  if (state.activeIndex >= state.count) {
    const normalizedActiveIndex = state.activeIndex % state.count;
    const currentActive = template.content.querySelector('[data-active-search="true"]');
    currentActive?.removeAttribute('data-active-search');
    template.content
      .querySelector(`[data-search-hit="${normalizedActiveIndex}"]`)
      ?.setAttribute('data-active-search', 'true');
    state.activeIndex = normalizedActiveIndex;
  }

  return {
    html: template.innerHTML,
    count: state.count,
    activeIndex: state.activeIndex
  };
}
