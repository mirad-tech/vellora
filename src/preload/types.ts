import type {
  ImageResolutionResult,
  ConfirmDiscardChangesResult,
  RecentItemsResult,
  MarkdownLinkOpenResult,
  MarkdownOpenResult,
  MarkdownSaveResult,
  OpenDefaultEditorResult,
  PdfExportResult,
  SecurityDiagnostics,
  WorkspaceOpenResult
} from '../shared/documentTypes';

export type MdViewerApi = {
  openMarkdownFile: () => Promise<MarkdownOpenResult>;
  openMarkdownByPath: (filePath: string) => Promise<MarkdownOpenResult>;
  onMarkdownOpenRequested: (callback: (filePath: string) => void) => () => void;
  openDroppedMarkdownFile: (file: File) => Promise<MarkdownOpenResult>;
  openWorkspaceFolder: () => Promise<WorkspaceOpenResult>;
  openWorkspaceByPath: (folderPath: string) => Promise<WorkspaceOpenResult>;
  getRecentItems: () => Promise<RecentItemsResult>;
  saveMarkdownFile: (filePath: string, content: string) => Promise<MarkdownSaveResult>;
  openDefaultEditor: (filePath: string) => Promise<OpenDefaultEditorResult>;
  onMenuAction: (callback: (action: string) => void) => () => void;
  exportToPdf: () => Promise<PdfExportResult>;
  setUnsavedChanges: (hasUnsavedChanges: boolean) => Promise<{ ok: true }>;
  confirmDiscardChanges: () => Promise<ConfirmDiscardChangesResult>;
  resolveMarkdownImage: (documentPath: string, imageSource: string) => Promise<ImageResolutionResult>;
  openMarkdownLink: (documentPath: string, href: string) => Promise<MarkdownLinkOpenResult>;
  getSecurityDiagnostics: () => Promise<SecurityDiagnostics>;
  setLanguage: (lang: string) => Promise<void>;
  removeRecentItem: (path: string, type: 'file' | 'folder') => Promise<{ ok: boolean; message?: string }>;
};
