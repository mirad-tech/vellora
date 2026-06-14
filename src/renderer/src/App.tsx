import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent
} from 'react';
import {
  MDXEditor,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  type MDXEditorMethods
} from '@mdxeditor/editor';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  File as FileIcon,
  FileText,
  FolderOpen,
  FolderTree,
  ListTree,
  Moon,
  Save,
  Search,
  SquarePen,
  Sun,
  Settings,
  Info,
  History,
  Printer,
  AlertTriangle,
  X,
  Command,
} from 'lucide-react';

import { useI18n } from './i18n/useI18n';
import { renderMarkdownDocument } from './markdown/renderMarkdown';
import {
  applyImageResolutions,
  collectLocalImageResolutionGroups,
  resolveImageGroupsWithLimit,
  type ImageResolutionMap
} from './markdown/resolveImages';
import { applySearchHighlights } from './markdown/searchHtml';
import type {
  MarkdownDocument,
  MarkdownOpenResult,
  MarkdownWorkspace,
  RecentItem,
  WorkspaceOpenResult,
  WorkspaceTreeNode,
  SecurityDiagnostics
} from '../../shared/documentTypes';

type ViewState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'ready'; document: MarkdownDocument }
  | { status: 'error'; message: string };

type ThemeMode = 'light' | 'dark';
type EditorMode = 'read' | 'source-edit';
type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

type WorkspaceState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'ready'; workspace: MarkdownWorkspace }
  | { status: 'error'; message: string };

function formatModifiedTime(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function documentWordCount(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  const latinWords = trimmed.match(/[A-Za-z0-9_]+/g) ?? [];
  const cjkChars = trimmed.match(/[\u3400-\u9FFF]/g) ?? [];
  return latinWords.length + cjkChars.length;
}

function decodeMarkdownHref(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isProtocolLink(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function collectLocalMarkdownLinkTargets(content: string): Set<string> {
  const targets = new Set<string>();
  const linkPattern = /(?<!!)\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(content)) !== null) {
    const target = decodeMarkdownHref(match[1] ?? '').trim();
    if (target && !isProtocolLink(target)) {
      targets.add(target);
    }
  }

  return targets;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function recoverMdxNormalizedLocalHref(href: string, referenceContent: string): string {
  if (!href.startsWith('https://')) return href;

  const candidate = decodeMarkdownHref(stripTrailingSlash(href.slice('https://'.length)));
  const localTargets = collectLocalMarkdownLinkTargets(referenceContent);
  return localTargets.has(candidate) ? candidate : href;
}

function restoreMdxNormalizedLocalLinks(markdown: string, referenceContent: string): string {
  const localTargets = collectLocalMarkdownLinkTargets(referenceContent);
  if (localTargets.size === 0) return markdown;

  return markdown.replace(
    /(?<!!)(\[[^\]]+]\()https:\/\/([^)]+)(\))/g,
    (full, prefix: string, target: string, suffix: string) => {
      const candidate = decodeMarkdownHref(stripTrailingSlash(target));
      return localTargets.has(candidate) ? `${prefix}${candidate}${suffix}` : full;
    }
  );
}

function toViewState(result: MarkdownOpenResult): ViewState {
  if (result.ok) {
    return { status: 'ready', document: result.document };
  }

  if (result.code === 'CANCELED') {
    return { status: 'empty' };
  }

  return { status: 'error', message: result.message };
}

function toWorkspaceState(result: WorkspaceOpenResult): WorkspaceState {
  if (result.ok) {
    return { status: 'ready', workspace: result.workspace };
  }

  if (result.code === 'CANCELED') {
    return { status: 'empty' };
  }

  return { status: 'error', message: result.message };
}

function nodeMatchesFilter(node: WorkspaceTreeNode, normalizedFilter: string): boolean {
  if (!normalizedFilter) return true;
  return (
    node.name.toLocaleLowerCase().includes(normalizedFilter) ||
    node.relativePath.toLocaleLowerCase().includes(normalizedFilter)
  );
}

function filterWorkspaceNodes(
  nodes: WorkspaceTreeNode[],
  normalizedFilter: string
): WorkspaceTreeNode[] {
  if (!normalizedFilter) return nodes;

  const filteredNodes: WorkspaceTreeNode[] = [];

  for (const node of nodes) {
    if (node.type === 'file') {
      if (nodeMatchesFilter(node, normalizedFilter)) {
        filteredNodes.push(node);
      }
      continue;
    }

    const children = filterWorkspaceNodes(node.children, normalizedFilter);
    if (children.length > 0 || nodeMatchesFilter(node, normalizedFilter)) {
      filteredNodes.push({
        ...node,
        children
      });
    }
  }

  return filteredNodes;
}

export function App() {
  const { t, lang, setLang } = useI18n();

  // Original core states
  const [viewState, setViewState] = useState<ViewState>({ status: 'empty' });
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>({ status: 'empty' });
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [editorMode, setEditorMode] = useState<EditorMode>('read');
  const [draftContent, setDraftContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [editorError, setEditorError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [imageResolutions, setImageResolutions] = useState<ImageResolutionMap>({});
  const readerRef = useRef<HTMLElement | null>(null);
  const markdownBodyRef = useRef<HTMLDivElement | null>(null);
  const mdxEditorRef = useRef<MDXEditorMethods | null>(null);
  const draftContentRef = useRef('');
  const mdxEditorTouchedRef = useRef(false);
  const pendingMdxSyncFrameRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const menuActionHandlerRef = useRef<(action: string) => void>(() => {});

  // New visual/structural states
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRecentOpen, setIsRecentOpen] = useState(false);
  const [isFileInfoOpen, setIsFileInfoOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState('');
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const [securityDiagnostics, setSecurityDiagnostics] = useState<SecurityDiagnostics | null>(null);
  const [sidebarTab, setSidebarTab] = useState<'workspace' | 'outline'>('workspace');

  function updateDraftContent(nextContent: string): void {
    draftContentRef.current = nextContent;
    setDraftContent(nextContent);
  }

  function resetDocumentState(): void {
    setSearchQuery('');
    setActiveSearchIndex(0);
    setActiveHeadingId('');
    setImageResolutions({});
    setEditorMode('read');
    setEditorError(null);
    mdxEditorTouchedRef.current = false;
    if (pendingMdxSyncFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingMdxSyncFrameRef.current);
      pendingMdxSyncFrameRef.current = null;
    }
    setSaveState({ status: 'idle' });
  }

  function applyOpenResult(result: MarkdownOpenResult): void {
    resetDocumentState();
    if (result.ok) {
      updateDraftContent(result.document.content);
    }
    setViewState(toViewState(result));
  }

  const isDirty = viewState.status === 'ready' && draftContent !== viewState.document.content;
  const hasUnsavedChanges = isDirty;

  function syncReadEditorToDraft(force = false): string {
    if (editorMode !== 'read' || viewState.status !== 'ready' || mdxEditorRef.current === null) {
      return draftContentRef.current;
    }

    if (!force && !mdxEditorTouchedRef.current) {
      return draftContentRef.current;
    }

    const referenceContent = `${viewState.document.content}\n${draftContentRef.current}`;
    const nextContent = restoreMdxNormalizedLocalLinks(mdxEditorRef.current.getMarkdown(), referenceContent);
    if (nextContent !== draftContentRef.current) {
      updateDraftContent(nextContent);
      setSaveState({ status: 'idle' });
    }
    mdxEditorTouchedRef.current = false;
    return nextContent;
  }

  function scheduleReadEditorSync(): void {
    if (editorMode !== 'read' || viewState.status !== 'ready' || mdxEditorRef.current === null) return;
    mdxEditorTouchedRef.current = true;
    if (pendingMdxSyncFrameRef.current !== null) return;

    pendingMdxSyncFrameRef.current = window.requestAnimationFrame(() => {
      pendingMdxSyncFrameRef.current = null;
      syncReadEditorToDraft(true);
    });
  }

  function isContentChangingKey(key: string): boolean {
    return key.length === 1 || ['Backspace', 'Delete', 'Enter', 'Tab'].includes(key);
  }

  async function confirmBeforeReplacingDocument(): Promise<boolean> {
    const currentContent = syncReadEditorToDraft();
    const dirty = viewState.status === 'ready' && currentContent !== viewState.document.content;
    if (!dirty) return true;
    const result = await window.mdViewer.confirmDiscardChanges();
    return result.action === 'discard';
  }

  async function openMarkdownFile(): Promise<void> {
    if (!(await confirmBeforeReplacingDocument())) return;
    setViewState({ status: 'loading' });
    const result = await window.mdViewer.openMarkdownFile();
    applyOpenResult(result);
    await refreshRecentItems();
  }

  async function openDroppedFile(file: File): Promise<void> {
    if (!(await confirmBeforeReplacingDocument())) return;
    setViewState({ status: 'loading' });
    const result = await window.mdViewer.openDroppedMarkdownFile(file);
    applyOpenResult(result);
    await refreshRecentItems();
  }

  async function refreshRecentItems(): Promise<void> {
    const result = await window.mdViewer.getRecentItems();
    if (result.ok) {
      setRecentItems(result.items);
    }
  }

  async function openWorkspaceFolder(): Promise<void> {
    setWorkspaceState({ status: 'loading' });
    const result = await window.mdViewer.openWorkspaceFolder();
    setWorkspaceState(toWorkspaceState(result));
    if (result.ok) {
      setSidebarTab('workspace');
      setSidebarOpen(true);
    }
    await refreshRecentItems();
  }

  async function openWorkspaceByPath(folderPath: string): Promise<void> {
    setWorkspaceState({ status: 'loading' });
    const result = await window.mdViewer.openWorkspaceByPath(folderPath);
    setWorkspaceState(toWorkspaceState(result));
    if (result.ok) {
      setSidebarTab('workspace');
      setSidebarOpen(true);
    }
    await refreshRecentItems();
  }

  async function openMarkdownByPath(filePath: string): Promise<void> {
    if (!(await confirmBeforeReplacingDocument())) return;
    setViewState({ status: 'loading' });
    const result = await window.mdViewer.openMarkdownByPath(filePath);
    applyOpenResult(result);
    await refreshRecentItems();
  }

  useEffect(() => {
    return window.mdViewer.onMarkdownOpenRequested((filePath) => {
      void openMarkdownByPath(filePath);
    });
  });

  function toggleSidebar(): void {
    if (!sidebarOpen && viewState.status === 'ready' && workspaceState.status !== 'ready') {
      setSidebarTab('outline');
    }
    setSidebarOpen((value) => !value);
  }

  async function openRecentItem(item: RecentItem): Promise<void> {
    if (item.type === 'folder') {
      await openWorkspaceByPath(item.path);
      setSidebarTab('workspace');
      return;
    }

    await openMarkdownByPath(item.path);
  }

  const fileStatus = useMemo(() => {
    if (viewState.status !== 'ready') {
      return {
        name: t.statusBar.noFile,
        path: '',
        modifiedAt: '',
        words: t.statusBar.words(0)
      };
    }

    return {
      name: viewState.document.name,
      path: viewState.document.path,
      modifiedAt: t.fileInfo.modifiedLabel(formatModifiedTime(viewState.document.modifiedAt, lang)),
      words: t.fileInfo.words(documentWordCount(draftContent))
    };
  }, [draftContent, viewState, t, lang]);

  const renderedMarkdown = useMemo(() => {
    if (viewState.status !== 'ready') return null;
    return renderMarkdownDocument(draftContent);
  }, [draftContent, viewState]);

  const outline = renderedMarkdown?.status === 'ready' ? renderedMarkdown.outline : [];
  const filteredWorkspaceNodes = useMemo(() => {
    if (workspaceState.status !== 'ready') return [];
    return filterWorkspaceNodes(workspaceState.workspace.children, workspaceFilter.trim().toLocaleLowerCase());
  }, [workspaceFilter, workspaceState]);

  const resolvedMarkdownHtml = useMemo(() => {
    if (renderedMarkdown?.status !== 'ready') return '';
    return applyImageResolutions(renderedMarkdown.html, imageResolutions);
  }, [imageResolutions, renderedMarkdown]);

  const searchResult = useMemo(() => {
    if (renderedMarkdown?.status !== 'ready') {
      return {
        html: '',
        count: 0,
        activeIndex: -1
      };
    }
    return applySearchHighlights(resolvedMarkdownHtml, searchQuery, activeSearchIndex);
  }, [activeSearchIndex, renderedMarkdown, resolvedMarkdownHtml, searchQuery]);

  const activeDocumentPath = viewState.status === 'ready' ? viewState.document.path : '';
  const showSearchPreview =
    editorMode === 'read' && searchQuery.trim().length > 0 && renderedMarkdown?.status === 'ready';

  const mdxEditorPlugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      linkDialogPlugin({
        onClickLinkCallback: (url) => {
          void openMarkdownHref(url);
        }
      }),
      tablePlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: 'txt' }),
      codeMirrorPlugin({
        codeBlockLanguages: {
          bash: 'Bash',
          css: 'CSS',
          html: 'HTML',
          javascript: 'JavaScript',
          js: 'JavaScript',
          json: 'JSON',
          markdown: 'Markdown',
          md: 'Markdown',
          text: 'Text',
          ts: 'TypeScript',
          typescript: 'TypeScript',
          txt: 'Text'
        }
      }),
      imagePlugin({
        disableImageResize: true,
        disableImageSettingsButton: true,
        imagePreviewHandler: async (source) => {
          if (!activeDocumentPath) return '';
          const result = await window.mdViewer.resolveMarkdownImage(activeDocumentPath, source);
          return result.ok ? result.src : '';
        }
      }),
      markdownShortcutPlugin()
    ],
    [activeDocumentPath]
  );

  const searchStatus = useMemo(() => {
    if (!searchQuery.trim()) return '';
    if (searchResult.count === 0) return t.search.noResults;
    return `${searchResult.activeIndex + 1}/${searchResult.count}`;
  }, [searchQuery, searchResult, t]);

  const missingImageSources = useMemo(
    () =>
      Array.from(
        new Set(
          Object.entries(imageResolutions)
            .filter(([, resolution]) => !resolution.ok)
            .map(([source]) => source)
        )
      ),
    [imageResolutions]
  );

  useEffect(() => {
    if (outline.length === 0) {
      setActiveHeadingId('');
      return;
    }
    setActiveHeadingId((current) => current || outline[0].id);
  }, [outline]);

  useEffect(() => {
    if (searchResult.activeIndex < 0) return;
    const hit = document.querySelector(`[data-search-hit="${searchResult.activeIndex}"]`);
    if (hit instanceof HTMLElement) {
      scrollElementIntoReader(hit, 'center');
    }
  }, [searchResult.activeIndex, searchQuery]);

  useEffect(() => {
    if (viewState.status !== 'ready' || renderedMarkdown?.status !== 'ready') return;

    const imageGroups = collectLocalImageResolutionGroups(renderedMarkdown.html);
    if (imageGroups.length === 0) {
      setImageResolutions({});
      return;
    }

    const documentPath = viewState.document.path;
    let canceled = false;
    setImageResolutions({});

    async function resolveImages(): Promise<void> {
      const resolutions = await resolveImageGroupsWithLimit(
        imageGroups,
        (source) => window.mdViewer.resolveMarkdownImage(documentPath, source),
        undefined,
        () => canceled
      );
      if (!canceled) {
        setImageResolutions(resolutions);
      }
    }

    void resolveImages();

    return () => {
      canceled = true;
    };
  }, [renderedMarkdown, viewState]);

  useEffect(() => {
    void refreshRecentItems();
  }, []);

  useEffect(() => {
    void window.mdViewer.setUnsavedChanges(hasUnsavedChanges);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    draftContentRef.current = draftContent;
  }, [draftContent]);

  useEffect(() => {
    if (viewState.status !== 'ready' || editorMode !== 'read' || mdxEditorRef.current === null) return;
    mdxEditorRef.current.setMarkdown(draftContentRef.current);
    mdxEditorTouchedRef.current = false;
    setEditorError(null);
  }, [editorMode, viewState]);

  useEffect(() => {
    if (editorMode !== 'read' || showSearchPreview || outline.length === 0) return;
    const body = markdownBodyRef.current;
    if (!body) return;

    const frame = window.requestAnimationFrame(() => {
      const headings = Array.from(body.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
      headings.forEach((heading, index) => {
        const entry = outline[index];
        if (!entry) return;
        heading.id = entry.id;
        heading.dataset.headingId = entry.id;
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [draftContent, editorMode, outline, showSearchPreview]);

  function scrollElementIntoReader(element: HTMLElement, block: 'start' | 'center' = 'start'): void {
    const reader = readerRef.current;
    if (!reader) return;

    const readerRect = reader.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const offset = elementRect.top - readerRect.top;
    const centerOffset = block === 'center' ? reader.clientHeight / 2 - elementRect.height / 2 : 16;
    reader.scrollTop = reader.scrollTop + offset - centerOffset;
  }

  function updateActiveHeadingFromScroll(): void {
    const reader = readerRef.current;
    if (!reader || outline.length === 0) return;

    const readerTop = reader.getBoundingClientRect().top;
    let current = outline[0].id;

    for (const entry of outline) {
      const heading = document.getElementById(entry.id);
      if (!heading) continue;
      const relativeTop = heading.getBoundingClientRect().top - readerTop;
      if (relativeTop <= 96) {
        current = entry.id;
      }
    }

    setActiveHeadingId(current);
  }

  function scrollToHeading(id: string): void {
    const heading = document.getElementById(id);
    if (heading instanceof HTMLElement) {
      scrollElementIntoReader(heading);
    }
    setActiveHeadingId(id);
    window.requestAnimationFrame(() => {
      setActiveHeadingId(id);
    });
  }

  function moveSearchResult(direction: 1 | -1): void {
    if (searchResult.count === 0) return;
    setActiveSearchIndex((current) => {
      const next = current + direction;
      if (next < 0) return searchResult.count - 1;
      if (next >= searchResult.count) return 0;
      return next;
    });
  }

  function setEditorModeSafely(nextMode: EditorMode): void {
    if (editorMode === 'read' && nextMode !== 'read') {
      syncReadEditorToDraft(true);
    }
    setEditorError(null);
    setEditorMode(nextMode);
  }

  function handleMdxEditorChange(nextMarkdown: string, initialMarkdownNormalize: boolean): void {
    if (initialMarkdownNormalize && !mdxEditorTouchedRef.current) return;
    mdxEditorTouchedRef.current = true;
    updateDraftContent(nextMarkdown);
    setEditorError(null);
    setSaveState({ status: 'idle' });
  }

  async function openMarkdownHref(rawHref: string): Promise<void> {
    if (viewState.status !== 'ready') return;

    const href = recoverMdxNormalizedLocalHref(rawHref, `${viewState.document.content}\n${draftContentRef.current}`);
    const isExternal = href.startsWith('http://') || href.startsWith('https://');
    if (isExternal) {
      setPendingExternalUrl(href);
      return;
    }

    const result = await window.mdViewer.openMarkdownLink(
      viewState.document.path,
      href
    );

    if (result.ok && result.action === 'markdown') {
      applyOpenResult({ ok: true, document: result.document });
      await refreshRecentItems();
    } else if (!result.ok) {
      setSaveState({ status: 'error', message: result.message });
    }
  }

  async function handleMarkdownClick(event: MouseEvent<HTMLElement>): Promise<void> {
    if (viewState.status !== 'ready') return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    // Check if clicked image for Lightbox
    const img = target.closest('img');
    if (img instanceof HTMLImageElement) {
      const src = img.getAttribute('src');
      if (src) {
        setLightboxImageUrl(src);
        return;
      }
    }

    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!event.ctrlKey && !event.metaKey) return;

    event.preventDefault();
    event.stopPropagation();
    const href = anchor.getAttribute('href') ?? '';
    await openMarkdownHref(href);
  }

  async function handleConfirmExternalLink(): Promise<void> {
    if (!pendingExternalUrl || viewState.status !== 'ready') return;
    const url = pendingExternalUrl;
    setPendingExternalUrl(null);
    await window.mdViewer.openMarkdownLink(viewState.document.path, url);
  }

  async function handleDrop(event: DragEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    const file = event.dataTransfer.files.item(0);
    if (file) {
      await openDroppedFile(file);
    }
  }

  async function saveCurrentDocument(): Promise<void> {
    if (viewState.status !== 'ready') return;

    const contentToSave = syncReadEditorToDraft();
    if (contentToSave === viewState.document.content) {
      void window.mdViewer.setUnsavedChanges(false);
      return;
    }

    setSaveState({ status: 'saving' });
    const result = await window.mdViewer.saveMarkdownFile(viewState.document.path, contentToSave);

    if (result.ok) {
      updateDraftContent(result.document.content);
      mdxEditorTouchedRef.current = false;
      setViewState({ status: 'ready', document: result.document });
      setSaveState({ status: 'saved' });
      void window.mdViewer.setUnsavedChanges(false);
      await refreshRecentItems();
      return;
    }

    setSaveState({ status: 'error', message: result.message });
  }

  async function openCurrentInDefaultEditor(): Promise<void> {
    if (viewState.status !== 'ready') return;
    const result = await window.mdViewer.openDefaultEditor(viewState.document.path);
    if (!result.ok) {
      setSaveState({ status: 'error', message: result.message });
    }
  }

  async function loadSecurityDiagnostics(): Promise<void> {
    const result = await window.mdViewer.getSecurityDiagnostics();
    setSecurityDiagnostics(result);
  }

  function openCommandPalette(): void {
    setCommandPaletteQuery('');
    setCommandPaletteIndex(0);
    setIsCommandPaletteOpen(true);
  }

  function openSettingsDrawer(): void {
    void loadSecurityDiagnostics();
    setIsSettingsOpen(true);
  }

  function openFindBar(): void {
    syncReadEditorToDraft();
    setIsFindOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }

  async function closeCurrentDocument(): Promise<void> {
    if (viewState.status !== 'ready') return;
    if (await confirmBeforeReplacingDocument()) {
      resetDocumentState();
      setViewState({ status: 'empty' });
    }
  }

  async function exportCurrentDocumentToPdf(): Promise<void> {
    if (viewState.status !== 'ready') return;
    syncReadEditorToDraft();
    const result = await window.mdViewer.exportToPdf();
    if (!result.ok && result.message !== t.pdf.cancelled) {
      setSaveState({ status: 'error', message: result.message ?? t.pdf.failed });
    }
  }

  menuActionHandlerRef.current = (action) => {
    switch (action) {
      case 'open-file':
        void openMarkdownFile();
        break;
      case 'open-folder':
        void openWorkspaceFolder();
        break;
      case 'save-document':
        void saveCurrentDocument();
        break;
      case 'export-pdf':
        void exportCurrentDocumentToPdf();
        break;
      case 'open-default-editor':
        void openCurrentInDefaultEditor();
        break;
      case 'close-document':
        void closeCurrentDocument();
        break;
      case 'focus-search':
        openFindBar();
        break;
      case 'open-command-palette':
        openCommandPalette();
        break;
      case 'toggle-sidebar':
        toggleSidebar();
        break;
      case 'toggle-source-edit':
        if (viewState.status === 'ready') {
          setEditorModeSafely(editorMode === 'source-edit' ? 'read' : 'source-edit');
        }
        break;
      case 'toggle-theme':
        setTheme((value) => (value === 'light' ? 'dark' : 'light'));
        break;
      case 'show-file-info':
        if (viewState.status === 'ready') {
          setIsFileInfoOpen(true);
        }
        break;
      case 'open-settings':
        openSettingsDrawer();
        break;
      case 'show-recent':
        setIsRecentOpen(true);
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    return window.mdViewer.onMenuAction((action) => {
      menuActionHandlerRef.current(action);
    });
  }, []);

  // Escape closes transient UI. Command shortcuts are handled by the native menu.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setLightboxImageUrl(null);
      setPendingExternalUrl(null);
      setIsSettingsOpen(false);
      setIsRecentOpen(false);
      setIsFileInfoOpen(false);
      setIsCommandPaletteOpen(false);
      setIsFindOpen(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Command palette options list
  const commandList = useMemo(() => {
    const isDocReady = viewState.status === 'ready';
    return [
      {
        id: 'open_file',
        name: t.commandPalette.items.openFile,
        icon: <FolderOpen size={16} />,
        shortcut: 'Ctrl+O',
        action: () => void openMarkdownFile()
      },
      {
        id: 'open_folder',
        name: t.commandPalette.items.openFolder,
        icon: <FolderTree size={16} />,
        shortcut: 'Ctrl+Shift+O',
        action: () => void openWorkspaceFolder()
      },
      {
        id: 'save_document',
        name: t.commandPalette.items.save,
        icon: <Save size={16} />,
        shortcut: 'Ctrl+S',
        disabled: !isDocReady || !hasUnsavedChanges,
        action: () => void saveCurrentDocument()
      },
      {
        id: 'source_edit_mode',
        name: editorMode === 'source-edit' ? t.commandPalette.items.editRead : t.commandPalette.items.editSource,
        icon: <SquarePen size={16} />,
        shortcut: 'Ctrl+E',
        disabled: !isDocReady,
        action: () => setEditorModeSafely(editorMode === 'source-edit' ? 'read' : 'source-edit')
      },
      {
        id: 'toggle_theme',
        name: theme === 'light' ? t.commandPalette.items.themeDark : t.commandPalette.items.themeLight,
        icon: theme === 'light' ? <Moon size={16} /> : <Sun size={16} />,
        shortcut: 'Ctrl+D',
        action: () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))
      },
      {
        id: 'view_file_info',
        name: t.commandPalette.items.fileInfo,
        icon: <Info size={16} />,
        shortcut: 'Ctrl+I',
        disabled: !isDocReady,
        action: () => setIsFileInfoOpen(true)
      },
      {
        id: 'print_document',
        name: t.commandPalette.items.exportPdf,
        icon: <Printer size={16} />,
        shortcut: 'Ctrl+Shift+P',
        disabled: !isDocReady,
        action: () => void exportCurrentDocumentToPdf()
      },
      {
        id: 'security_audit',
        name: t.commandPalette.items.settings,
        icon: <Settings size={16} />,
        shortcut: 'Ctrl+,',
        action: openSettingsDrawer
      },
      {
        id: 'recent_history',
        name: t.commandPalette.items.recent,
        icon: <History size={16} />,
        shortcut: '',
        action: () => setIsRecentOpen(true)
      },
      {
        id: 'close_file',
        name: t.commandPalette.items.closeDoc,
        icon: <X size={16} />,
        shortcut: 'Esc',
        disabled: !isDocReady,
        action: async () => {
          if (await confirmBeforeReplacingDocument()) {
            resetDocumentState();
            setViewState({ status: 'empty' });
          }
        }
      }
    ];
  }, [viewState, hasUnsavedChanges, editorMode, theme, draftContent, t]);

  const filteredCommands = useMemo(() => {
    const q = commandPaletteQuery.trim().toLowerCase();
    if (!q) return commandList;
    return commandList.filter((c) => c.name.toLowerCase().includes(q));
  }, [commandPaletteQuery, commandList]);

  // Navigate filtered commands on keydown
  const handleCommandPaletteKeyDown = (e: KeyboardEvent) => {
    if (filteredCommands.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCommandPaletteIndex((prev) => (prev + 1) % filteredCommands.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCommandPaletteIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredCommands[commandPaletteIndex];
      if (selected && !selected.disabled) {
        setIsCommandPaletteOpen(false);
        selected.action();
      }
    }
  };

  function renderWorkspaceNodes(nodes: WorkspaceTreeNode[], level = 1) {
    return (
      <ol className="workspace-tree" data-level={level}>
        {nodes.map((node) => (
          <li key={node.path}>
            {node.type === 'directory' ? (
              <div className="workspace-directory">
                <span className="workspace-directory-label" style={{ '--level': level } as CSSProperties}>
                  <ChevronRight aria-hidden="true" size={13} />
                  {node.name}
                </span>
                {node.children.length > 0 && renderWorkspaceNodes(node.children, level + 1)}
              </div>
            ) : (
              <button
                className="workspace-file"
                data-testid="workspace-file"
                style={{ '--level': level } as CSSProperties}
                title={node.relativePath}
                type="button"
                onClick={() => openMarkdownByPath(node.path)}
              >
                <FileIcon aria-hidden="true" size={13} />
                <span>{node.name}</span>
              </button>
            )}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <main
      className="app-shell"
      data-theme={theme}
      data-testid="app-shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      {/* 工作区和内容区域 */}
      <div className={`workspace ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
        {/* 侧边栏 */}
        <aside
          className="sidebar-panel outline-panel"
          data-testid="sidebar-panel"
          hidden={!sidebarOpen}
          aria-label={t.sidebar.ariaLabel}
        >
          <div className="sidebar-tabs-header" role="tablist" aria-label={t.sidebar.ariaView}>
            <button
              aria-selected={sidebarTab === 'workspace'}
              className={`sidebar-tab-btn ${sidebarTab === 'workspace' ? 'active' : ''}`}
              data-testid="sidebar-tab-workspace"
              role="tab"
              type="button"
              onClick={() => setSidebarTab('workspace')}
            >
              <FolderTree aria-hidden="true" size={14} />
              <span>{t.workspace.tab}</span>
            </button>
            <button
              aria-selected={sidebarTab === 'outline'}
              className={`sidebar-tab-btn ${sidebarTab === 'outline' ? 'active' : ''}`}
              data-testid="sidebar-tab-outline"
              role="tab"
              type="button"
              onClick={() => setSidebarTab('outline')}
            >
              <ListTree aria-hidden="true" size={14} />
              <span>{t.outline.tab}</span>
            </button>
          </div>

          <div className="sidebar-tab-content-wrapper">
            {sidebarTab === 'workspace' && (
              <section className="workspace-panel" data-testid="workspace-panel">
                <div className="outline-heading">
                  <FolderTree aria-hidden="true" size={15} />
                  <span>{t.workspace.heading}</span>
                </div>
                <div className="workspace-controls">
                  {(workspaceState.status === 'empty' || workspaceState.status === 'error') && (
                    <button className="sidebar-action" type="button" onClick={openWorkspaceFolder}>
                      {t.app.openFolder}
                    </button>
                  )}
                  {workspaceState.status === 'ready' && (
                    <div className="workspace-filter-container">
                      <Search aria-hidden="true" className="filter-icon" size={13} />
                      <input
                        aria-label={t.workspace.filterAria}
                        data-testid="workspace-filter"
                        placeholder={t.workspace.filterPlaceholder}
                        type="search"
                        value={workspaceFilter}
                        onChange={(event) => setWorkspaceFilter(event.target.value)}
                      />
                    </div>
                  )}
                </div>
                {workspaceState.status === 'empty' && <div className="sidebar-note">{t.workspace.noFolder}</div>}
                {workspaceState.status === 'loading' && <div className="sidebar-note">{t.workspace.loading}</div>}
                {workspaceState.status === 'error' && (
                  <div className="sidebar-error" role="alert">
                    {workspaceState.message}
                  </div>
                )}
                {workspaceState.status === 'ready' && (
                  <div className="workspace-content">
                    <div className="workspace-name" title={workspaceState.workspace.path}>
                      {workspaceState.workspace.name}
                    </div>
                    {workspaceState.workspace.truncated && (
                      <div className="workspace-limit" data-testid="workspace-limit">
                        {t.workspace.truncated(workspaceState.workspace.limit)}
                      </div>
                    )}
                    {filteredWorkspaceNodes.length > 0 ? (
                      renderWorkspaceNodes(filteredWorkspaceNodes)
                    ) : (
                      <div className="sidebar-note">{t.workspace.noMatch}</div>
                    )}
                  </div>
                )}
              </section>
            )}

            {sidebarTab === 'outline' && (
              <section className="outline-section">
                <div className="outline-heading">
                  <ListTree aria-hidden="true" size={15} />
                  <span>{t.outline.heading}</span>
                </div>
                {outline.length > 0 ? (
                  <ol className="outline-list">
                    {outline.map((entry) => (
                      <li key={entry.id} style={{ '--level': entry.level } as CSSProperties}>
                        <button
                          aria-current={activeHeadingId === entry.id ? 'true' : undefined}
                          data-level={entry.level}
                          data-testid="outline-item"
                          title={entry.text}
                          type="button"
                          onClick={() => scrollToHeading(entry.id)}
                        >
                          {entry.text}
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="sidebar-note">{t.outline.empty}</div>
                )}
              </section>
            )}
          </div>
        </aside>

        {/* 中央主文档视图 */}
        <section
          className="content-surface"
          data-testid="reader-main"
          ref={readerRef}
          aria-live="polite"
          onScroll={updateActiveHeadingFromScroll}
        >
          {/* 空状态视图 */}
          {viewState.status === 'empty' && (
            <div className="empty-state">
              <h1>{t.app.emptyTitle}</h1>
              <p>{t.app.emptyHint}</p>

              <button className="secondary-action" type="button" onClick={openMarkdownFile}>
                <FolderOpen aria-hidden="true" size={16} />
                <span>{t.app.openFile}</span>
              </button>
              {recentItems.length > 0 && (
                <div className="recent-list" data-testid="recent-list">
                  <strong>{t.app.recentHeading}</strong>
                  {recentItems.slice(0, 5).map((item) => (
                    <button
                      className="recent-item"
                      data-recent-type={item.type}
                      data-testid="recent-item"
                      key={`${item.type}:${item.path}`}
                      title={item.path}
                      type="button"
                      onClick={() => openRecentItem(item)}
                    >
                      <span>{item.name}</span>
                      <small>{item.exists ? item.path : t.app.fileNotExist}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 正在加载视图 */}
          {viewState.status === 'loading' && (
            <div className="loading-state">{t.app.loading}</div>
          )}

          {/* 加载失败视图 */}
          {viewState.status === 'error' && (
            <div className="error-state" role="alert">
              <h1>{t.app.errorTitle}</h1>
              <p>{viewState.message}</p>
              <button className="secondary-action" type="button" onClick={openMarkdownFile}>
                <FolderOpen aria-hidden="true" size={16} />
                <span>{t.app.reselect}</span>
              </button>
            </div>
          )}

          {/* 文档载入成功 */}
          {viewState.status === 'ready' && (
            <article className={`document-view${editorMode === 'source-edit' ? ' document-view--source-edit' : ''}`}>
              {saveState.status === 'error' && (
                <div className="document-render-error" data-testid="save-error" role="alert">
                  {saveState.message}
                </div>
              )}

              {(renderedMarkdown?.status === 'error' || editorError) && (
                <div className="document-render-error" role="alert">
                  {editorError ?? (renderedMarkdown?.status === 'error' ? renderedMarkdown.message : '')}
                </div>
              )}

              {renderedMarkdown?.status === 'empty' ? (
                <div className="document-empty" data-testid="markdown-empty">
                  {t.app.documentEmpty}
                </div>
              ) : editorMode === 'source-edit' ? (
                <div className="editor-split" data-testid="editor-split">
                  <textarea
                    className="source-editor"
                    data-testid="source-editor"
                    spellCheck={false}
                    value={draftContent}
                    onChange={(event) => {
                      updateDraftContent(event.target.value);
                      setEditorError(null);
                      setSaveState({ status: 'idle' });
                    }}
                  />
                  <div
                    className="markdown-body editor-preview"
                    data-testid="editor-preview"
                    dangerouslySetInnerHTML={{ __html: renderedMarkdown?.status === 'ready' ? searchResult.html : '' }}
                    onClick={handleMarkdownClick}
                  />
                </div>
              ) : showSearchPreview ? (
                <div
                  className="markdown-body editor-search-preview"
                  data-testid="markdown-body"
                  dangerouslySetInnerHTML={{ __html: searchResult.html }}
                  onClick={handleMarkdownClick}
                />
              ) : (
                <div
                  className="mdx-wysiwyg-host"
                  data-testid="markdown-body"
                  ref={markdownBodyRef}
                  onClickCapture={handleMarkdownClick}
                  onInputCapture={() => {
                    scheduleReadEditorSync();
                  }}
                  onKeyDownCapture={(event) => {
                    if (isContentChangingKey(event.key)) {
                      scheduleReadEditorSync();
                    }
                  }}
                >
                  <MDXEditor
                    ref={mdxEditorRef}
                    className="mdx-wysiwyg-editor-root"
                    contentEditableClassName="markdown-body mdx-wysiwyg-editor"
                    markdown={draftContent}
                    plugins={mdxEditorPlugins}
                    spellCheck
                    suppressHtmlProcessing
                    trim={false}
                    onChange={handleMdxEditorChange}
                    onError={(payload) => {
                      setEditorError(payload.error || t.app.parseError);
                    }}
                  />
                  {missingImageSources.map((source) => (
                    <span className="image-placeholder" data-testid="missing-image" key={source}>
                      {t.app.imageMissing(source)}
                    </span>
                  ))}
                </div>
              )}
            </article>
          )}
        </section>
      </div>

      {isFindOpen && (
        <div className="find-bar" data-testid="find-bar">
          <div className="search-cluster" role="search">
            <Search aria-hidden="true" size={13} />
            <input
              ref={searchInputRef}
              aria-label={t.search.ariaLabel}
              data-testid="document-search"
              placeholder={t.search.placeholder}
              type="search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setActiveSearchIndex(0);
              }}
            />
            <span className="search-status" data-testid="search-status">
              {searchStatus}
            </span>
            <button
              aria-label={t.search.prevAria}
              className="search-step"
              data-testid="search-previous"
              disabled={searchResult.count === 0}
              title={t.search.prevTitle}
              type="button"
              onClick={() => moveSearchResult(-1)}
            >
              <ChevronUp aria-hidden="true" size={13} />
            </button>
            <button
              aria-label={t.search.nextAria}
              className="search-step"
              data-testid="search-next"
              disabled={searchResult.count === 0}
              title={t.search.nextTitle}
              type="button"
              onClick={() => moveSearchResult(1)}
            >
              <ChevronDown aria-hidden="true" size={13} />
            </button>
          </div>
          <button
            aria-label={t.search.closeAria}
            className="find-close"
            title={t.search.closeTitle}
            type="button"
            onClick={() => setIsFindOpen(false)}
          >
            <X aria-hidden="true" size={13} />
          </button>
        </div>
      )}

      {/* 底部只读状态栏 */}
      <footer className="status-bar" data-testid="status-bar">
        <span data-testid="status-file-name">{fileStatus.name}</span>
        <span data-testid="status-file-path">{fileStatus.path}</span>
        <span data-testid="status-modified-time">{fileStatus.modifiedAt}</span>
        <span data-testid="status-word-count">{fileStatus.words}</span>
      </footer>

      {/* ========================================================================= */}
      {/* 二级悬浮界面 / Modals / Drawers */}
      {/* ========================================================================= */}

      {/* 1. 快捷命令面板 (Command Palette) */}
      {isCommandPaletteOpen && (
        <div className="modal-overlay" onClick={() => setIsCommandPaletteOpen(false)}>
          <div className="command-palette-card" onClick={(e) => e.stopPropagation()}>
            <div className="palette-input-wrapper">
              <Command size={16} className="palette-search-icon" />
              <input
                autoFocus
                placeholder={t.commandPalette.placeholder}
                type="text"
                value={commandPaletteQuery}
                onChange={(e) => {
                  setCommandPaletteQuery(e.target.value);
                  setCommandPaletteIndex(0);
                }}
                onKeyDown={(e) => handleCommandPaletteKeyDown(e.nativeEvent)}
              />
              <span className="palette-esc-badge">ESC</span>
            </div>
            <div className="palette-results-list">
              {filteredCommands.length > 0 ? (
                filteredCommands.map((cmd, idx) => (
                  <button
                    className={`palette-item-btn ${commandPaletteIndex === idx ? 'focused' : ''} ${cmd.disabled ? 'disabled' : ''}`}
                    disabled={cmd.disabled}
                    key={cmd.id}
                    type="button"
                    onClick={() => {
                      if (!cmd.disabled) {
                        setIsCommandPaletteOpen(false);
                        cmd.action();
                      }
                    }}
                  >
                    <div className="palette-item-left">
                      {cmd.icon}
                      <span>{cmd.name}</span>
                    </div>
                    {cmd.shortcut && <kbd className="palette-item-kbd">{cmd.shortcut}</kbd>}
                  </button>
                ))
              ) : (
                <div className="palette-empty-note">{t.commandPalette.noMatch}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. 设置与安全诊断抽屉 (Settings Drawer) */}
      {isSettingsOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="settings-drawer-card" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <div className="drawer-title-group">
                <Settings size={18} />
                <h2>{t.settings.title}</h2>
              </div>
              <button className="drawer-close-btn" type="button" onClick={() => setIsSettingsOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="drawer-scroll-content">
              <div className="settings-section">
                <h3>{t.settings.theme}</h3>
                <div className="theme-selector-grid">
                  <button
                    className={`theme-pick-btn ${theme === 'light' ? 'selected' : ''}`}
                    type="button"
                    onClick={() => setTheme('light')}
                  >
                    <Sun size={16} />
                    <span>{t.settings.themeLight}</span>
                  </button>
                  <button
                    className={`theme-pick-btn ${theme === 'dark' ? 'selected' : ''}`}
                    type="button"
                    onClick={() => setTheme('dark')}
                  >
                    <Moon size={16} />
                    <span>{t.settings.themeDark}</span>
                  </button>
                </div>
              </div>

              <div className="settings-section">
                <h3>{t.settings.language}</h3>
                <div className="theme-selector-grid">
                  <button
                    className={`theme-pick-btn ${lang === 'en' ? 'selected' : ''}`}
                    type="button"
                    onClick={() => setLang('en')}
                  >
                    <span>{t.settings.langEn}</span>
                  </button>
                  <button
                    className={`theme-pick-btn ${lang === 'zh' ? 'selected' : ''}`}
                    type="button"
                    onClick={() => setLang('zh')}
                  >
                    <span>{t.settings.langZh}</span>
                  </button>
                </div>
              </div>

              <div className="settings-section">
                <h3>{t.settings.securityReport}</h3>
                {securityDiagnostics ? (
                  <div className="security-diagnostics-grid">
                    <div className="security-diagnostic-item">
                      <span>{t.settings.contextIsolation}</span>
                      <strong className={securityDiagnostics.contextIsolation ? 'status-safe' : 'status-danger'}>
                        {securityDiagnostics.contextIsolation ? t.settings.enabled : t.settings.disabled}
                      </strong>
                    </div>
                    <div className="security-diagnostic-item">
                      <span>{t.settings.nodeIntegration}</span>
                      <strong className={!securityDiagnostics.nodeIntegration ? 'status-safe' : 'status-danger'}>
                        {!securityDiagnostics.nodeIntegration ? t.settings.disabled : t.settings.enabled}
                      </strong>
                    </div>
                    <div className="security-diagnostic-item">
                      <span>{t.settings.sandbox}</span>
                      <strong className={securityDiagnostics.sandbox ? 'status-safe' : 'status-danger'}>
                        {securityDiagnostics.sandbox ? t.settings.enabled : t.settings.disabled}
                      </strong>
                    </div>
                    <div className="security-diagnostic-item">
                      <span>{t.settings.webSecurity}</span>
                      <strong className={securityDiagnostics.webSecurity ? 'status-safe' : 'status-danger'}>
                        {securityDiagnostics.webSecurity ? t.settings.enabled : t.settings.disabled}
                      </strong>
                    </div>
                    <div className="security-diagnostic-item">
                      <span>{t.settings.webviewTag}</span>
                      <strong className={!securityDiagnostics.webviewTag ? 'status-safe' : 'status-danger'}>
                        {!securityDiagnostics.webviewTag ? t.settings.disabled : t.settings.enabled}
                      </strong>
                    </div>
                  </div>
                ) : (
                  <div className="diagnostics-loading">
                    <span>{t.settings.loadingDiagnostics}</span>
                  </div>
                )}
              </div>

              <div className="settings-section">
                <h3>{t.settings.ipcWhitelist}</h3>
                {securityDiagnostics?.allowedIpcChannels ? (
                  <div className="ipc-whitelist-list">
                    {securityDiagnostics.allowedIpcChannels.map((channel) => (
                      <code className="ipc-channel-tag" key={channel}>{channel}</code>
                    ))}
                  </div>
                ) : (
                  <small className="muted-text">{t.settings.notLoaded}</small>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. 文件元信息模态窗口 (File Info Modal) */}
      {isFileInfoOpen && viewState.status === 'ready' && (
        <div className="modal-overlay" onClick={() => setIsFileInfoOpen(false)}>
          <div className="file-info-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <Info size={16} />
                <h2>{t.fileInfo.title}</h2>
              </div>
              <button className="modal-close-btn" type="button" onClick={() => setIsFileInfoOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="file-info-body">
              <div className="info-row">
                <span className="info-label">{t.fileInfo.fileName}</span>
                <span className="info-value text-highlight">{viewState.document.name}</span>
              </div>
              <div className="info-row">
                <span className="info-label">{t.fileInfo.filePath}</span>
                <span className="info-value code-path-value">{viewState.document.path}</span>
              </div>
              <div className="info-row-grid">
                <div className="info-sub-item">
                  <span className="info-label">{t.fileInfo.fileSize}</span>
                  <span className="info-value">{t.fileInfo.bytes(viewState.document.size)}</span>
                </div>
                <div className="info-sub-item">
                  <span className="info-label">{t.fileInfo.wordCount}</span>
                  <span className="info-value">{t.fileInfo.words(documentWordCount(draftContent))}</span>
                </div>
                <div className="info-sub-item">
                  <span className="info-label">{t.fileInfo.charCount}</span>
                  <span className="info-value">{draftContent.length}</span>
                </div>
              </div>
              <div className="info-row">
                <span className="info-label">{t.fileInfo.modifiedAt}</span>
                <span className="info-value">{formatModifiedTime(viewState.document.modifiedAt, lang)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. 最近打开记录抽屉 (Recent Drawer) */}
      {isRecentOpen && (
        <div className="modal-overlay" onClick={() => setIsRecentOpen(false)}>
          <div className="settings-drawer-card" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <div className="drawer-title-group">
                <History size={18} />
                <h2>{t.recent.heading}</h2>
              </div>
              <button className="drawer-close-btn" type="button" onClick={() => setIsRecentOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="drawer-scroll-content">
              {recentItems.length > 0 ? (
                <div className="drawer-recent-list">
                  {recentItems.map((item) => (
                    <button
                      className="recent-drawer-item-btn"
                      key={`${item.type}:${item.path}`}
                      title={item.path}
                      type="button"
                      disabled={!item.exists}
                      onClick={() => {
                        setIsRecentOpen(false);
                        void openRecentItem(item);
                      }}
                    >
                      <div className="recent-item-icon-wrapper">
                        {item.type === 'folder' ? <FolderTree size={16} /> : <FileText size={16} />}
                      </div>
                      <div className="recent-item-info">
                        <span className="recent-item-name">{item.name}</span>
                        <span className="recent-item-path">{item.path}</span>
                      </div>
                      {!item.exists && <span className="recent-exists-badge">{t.recent.expired}</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="drawer-empty-state">
                  <p>{t.recent.empty}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 5. 图片大图预览 (Lightbox) */}
      {lightboxImageUrl && (
        <div className="modal-overlay lightbox-overlay" onClick={() => setLightboxImageUrl(null)}>
          <button className="lightbox-close-btn" type="button" onClick={() => setLightboxImageUrl(null)}>
            <X size={24} />
          </button>
          <div className="lightbox-image-container" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxImageUrl} alt={t.imageLightbox.alt} />
          </div>
        </div>
      )}

      {/* 6. 外部跳转安全确认弹层 (Link Confirmation Modal) */}
      {pendingExternalUrl && (
        <div className="modal-overlay" onClick={() => setPendingExternalUrl(null)}>
          <div className="link-confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-alert-header">
              <AlertTriangle size={20} className="warning-icon" />
              <h2>{t.externalLink.title}</h2>
            </div>
            <p className="link-alert-text">{t.externalLink.message}</p>
            <div className="target-url-card">
              <span className="target-url-text">{pendingExternalUrl}</span>
            </div>
            <div className="link-alert-actions">
              <button className="secondary-flat-btn" type="button" onClick={() => setPendingExternalUrl(null)}>
                {t.externalLink.cancel}
              </button>
              <button className="primary-accent-btn alert-action-btn danger-btn" type="button" onClick={() => void handleConfirmExternalLink()}>
                {t.externalLink.confirm}
              </button>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}
