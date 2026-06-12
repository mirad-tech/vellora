export type MarkdownDocument = {
  path: string;
  name: string;
  content: string;
  modifiedAt: number;
  size: number;
};

export type MarkdownOpenErrorCode =
  | 'CANCELED'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'READ_FAILED';

export type MarkdownOpenResult =
  | {
      ok: true;
      document: MarkdownDocument;
    }
  | {
      ok: false;
      code: MarkdownOpenErrorCode;
      message: string;
    };

export type MarkdownSaveErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'SAVE_FAILED';

export type MarkdownSaveResult =
  | {
      ok: true;
      document: MarkdownDocument;
    }
  | {
      ok: false;
      code: MarkdownSaveErrorCode;
      message: string;
    };

export type OpenDefaultEditorResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      code: 'INVALID_ARGUMENT' | 'UNSUPPORTED_FILE_TYPE' | 'NOT_FOUND' | 'NOT_A_FILE' | 'OPEN_FAILED';
      message: string;
    };

export type ConfirmDiscardChangesResult = {
  action: 'cancel' | 'discard';
};

export type WorkspaceTreeNode =
  | {
      type: 'directory';
      name: string;
      path: string;
      relativePath: string;
      children: WorkspaceTreeNode[];
    }
  | {
      type: 'file';
      name: string;
      path: string;
      relativePath: string;
    };

export type MarkdownWorkspace = {
  path: string;
  name: string;
  children: WorkspaceTreeNode[];
  fileCount: number;
  truncated: boolean;
  limit: number;
};

export type WorkspaceOpenErrorCode =
  | 'CANCELED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'READ_FAILED';

export type WorkspaceOpenResult =
  | {
      ok: true;
      workspace: MarkdownWorkspace;
    }
  | {
      ok: false;
      code: WorkspaceOpenErrorCode;
      message: string;
    };

export type RecentItemType = 'file' | 'folder';

export type RecentItem = {
  type: RecentItemType;
  path: string;
  name: string;
  openedAt: number;
  exists: boolean;
};

export type RecentItemsResult =
  | {
      ok: true;
      items: RecentItem[];
    }
  | {
      ok: false;
      code: 'RECENT_READ_FAILED';
      message: string;
    };

export type MarkdownImageErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_IMAGE_SOURCE'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'IMAGE_NOT_FOUND'
  | 'IMAGE_READ_FAILED';

export type ImageResolutionResult =
  | {
      ok: true;
      src: string;
      mime: string;
    }
  | {
      ok: false;
      code: MarkdownImageErrorCode;
      message: string;
    };

export type MarkdownLinkErrorCode =
  | 'INVALID_ARGUMENT'
  | 'DANGEROUS_PROTOCOL'
  | 'UNSUPPORTED_LINK'
  | MarkdownOpenErrorCode;

export type MarkdownLinkOpenResult =
  | {
      ok: true;
      action: 'markdown';
      document: MarkdownDocument;
    }
  | {
      ok: true;
      action: 'external';
      url: string;
    }
  | {
      ok: false;
      code: MarkdownLinkErrorCode;
      message: string;
    };

export type SecurityDiagnostics = {
  contextIsolation: true;
  nodeIntegration: false;
  sandbox: true;
  webSecurity: true;
  webviewTag: false;
  allowedIpcChannels: string[];
};
