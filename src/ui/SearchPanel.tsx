import type { DocumentSearch } from './useDocumentSearch';

export function SearchPanel({ search, inert }: { search: DocumentSearch; inert: boolean }) {
  const { inputRef: searchInputRef, query: searchQuery, expanded: searchExpanded,
    count: activeSearchCount, activeIndex: activeSearchIndex, close: closeSearch, navigate: navigateSearch } = search;
  return (
    <div
      id="document-search"
      className="search-bar"
      data-testid="search-bar"
      data-expanded={searchExpanded}
      role="search"
      aria-label="搜索当前文档"
      inert={inert}
    >
      <div className="search-query-row">
        <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.25" />
          <path d="m12.5 12.5 4 4" />
        </svg>
        <input
          ref={searchInputRef}
          type="search"
          className="search-input"
          data-testid="search-input"
          placeholder="查找"
          aria-label="搜索当前文档"
          value={searchQuery}
          onCompositionStart={search.onCompositionStart}
          onCompositionEnd={search.onCompositionEnd}
          onChange={event => search.changeQuery(event.target.value)}
          onKeyDown={search.onInputKeyDown}
        />
        <button
          type="button"
          className="search-icon-btn search-close"
          data-testid="search-close"
          onClick={closeSearch}
          aria-label="关闭查找"
        >
          <svg
            className="search-control-icon search-close-icon"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M5.53 4.47a.75.75 0 0 0-1.06 1.06L6.94 8l-2.47 2.47a.75.75 0 0 0 1.06 1.06L8 9.06l2.47 2.47a.75.75 0 0 0 1.06-1.06L9.06 8l2.47-2.47a.75.75 0 0 0-1.06-1.06L8 6.94 5.53 4.47Z" />
          </svg>
        </button>
      </div>
      <div className="search-navigation-row" aria-hidden={!searchExpanded}>
        <div className="search-navigation-actions">
          <button
            type="button"
            className="search-icon-btn"
            data-testid="search-prev"
            disabled={activeSearchCount <= 0}
            onClick={() => {
              navigateSearch(-1);
            }}
            aria-label="上一个匹配项"
          >
            <svg
              className="search-control-icon search-arrow-icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 6l2-2 2 2M8 4v8" />
            </svg>
          </button>
          <button
            type="button"
            className="search-icon-btn"
            data-testid="search-next"
            disabled={activeSearchCount <= 0}
            onClick={() => {
              navigateSearch(1);
            }}
            aria-label="下一个匹配项"
          >
            <svg
              className="search-control-icon search-arrow-icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m6 10 2 2 2-2M8 12V4" />
            </svg>
          </button>
        </div>
        <span className="search-count" data-testid="search-count" role="status" aria-live="polite" aria-atomic="true">
          {activeSearchCount > 0
            ? `${activeSearchIndex + 1} / ${activeSearchCount}`
            : '0 / 0'}
        </span>
      </div>
    </div>
  );
}
