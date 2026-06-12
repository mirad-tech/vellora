import type {
  ImageResolutionResult,
  ConfirmDiscardChangesResult,
  RecentItemsResult,
  MarkdownLinkOpenResult,
  MarkdownOpenResult,
  MarkdownSaveResult,
  OpenDefaultEditorResult,
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
  setUnsavedChanges: (hasUnsavedChanges: boolean) => Promise<{ ok: true }>;
  confirmDiscardChanges: () => Promise<ConfirmDiscardChangesResult>;
  resolveMarkdownImage: (documentPath: string, imageSource: string) => Promise<ImageResolutionResult>;
  openMarkdownLink: (documentPath: string, href: string) => Promise<MarkdownLinkOpenResult>;
  getSecurityDiagnostics: () => Promise<SecurityDiagnostics>;
};
