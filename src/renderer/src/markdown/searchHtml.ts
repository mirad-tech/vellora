export type SearchHighlightResult = {
  html: string;
  count: number;
  activeIndex: number;
};

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function collectTextNodes(root: ParentNode, query: string): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, mark')) return NodeFilter.FILTER_REJECT;
      const text = node.textContent ?? '';
      if (!text.trim()) return NodeFilter.FILTER_REJECT;
      // Pre-filter: reject node if it does not contain the query string
      if (!text.toLowerCase().includes(query)) return NodeFilter.FILTER_REJECT;
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
  const lowerSource = source.toLowerCase();

  let cursor = 0;
  let matchIndex = lowerSource.indexOf(query, cursor);
  const matchesInNode: number[] = [];

  while (matchIndex !== -1) {
    matchesInNode.push(matchIndex);
    cursor = matchIndex + query.length;
    matchIndex = lowerSource.indexOf(query, cursor);
  }

  if (matchesInNode.length === 0) return;

  // Melt-down protection: count matches but do not render extra DOM if we exceed limit
  if (state.count >= 1000) {
    state.count += matchesInNode.length;
    return;
  }

  const fragment = document.createDocumentFragment();
  let lastCursor = 0;

  for (const index of matchesInNode) {
    if (state.count >= 1000) {
      state.count += 1;
      continue;
    }

    if (index > lastCursor) {
      fragment.append(document.createTextNode(source.slice(lastCursor, index)));
    }

    const hitIndex = state.count;
    const mark = document.createElement('mark');
    mark.className = 'search-hit';
    mark.dataset.searchHit = String(hitIndex);
    if (hitIndex === state.activeIndex) {
      mark.dataset.activeSearch = 'true';
    }
    mark.textContent = source.slice(index, index + query.length);
    fragment.append(mark);

    state.count += 1;
    lastCursor = index + query.length;
  }

  if (lastCursor > 0) {
    if (lastCursor < source.length) {
      fragment.append(document.createTextNode(source.slice(lastCursor)));
    }
    textNode.replaceWith(fragment);
  }
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

  // Pre-filter on raw html string to avoid DOM parser overhead if query is completely absent
  // Only apply pre-filter when query does not contain HTML entity characters like <, >, &, ", '
  if (!/[<>&"']/.test(query)) {
    if (!html.toLowerCase().includes(query)) {
      return {
        html,
        count: 0,
        activeIndex: -1
      };
    }
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  const textNodes = collectTextNodes(template.content, query);
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
