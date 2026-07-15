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
  | 'READ_FAILED'
  | 'NO_INITIAL';

export type MarkdownOpenResult =
  | { ok: true; document: MarkdownDocument }
  | { ok: false; code: MarkdownOpenErrorCode | string; message: string };

export type MarkdownSaveErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'SAVE_FAILED';

export type MarkdownSaveResult =
  | { ok: true; document: MarkdownDocument }
  | { ok: false; code: MarkdownSaveErrorCode | string; message: string };

export type MarkdownImageErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_IMAGE_SOURCE'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'IMAGE_NOT_FOUND'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_READ_FAILED';

export type ImageResolutionResult =
  | { ok: true; src: string; mime: string }
  | { ok: false; code: MarkdownImageErrorCode | string; message: string };

export type MarkdownLinkErrorCode =
  | 'INVALID_ARGUMENT'
  | 'DANGEROUS_PROTOCOL'
  | 'UNSUPPORTED_LINK'
  | MarkdownOpenErrorCode
  | string;

export type MarkdownLinkInspectResult =
  | { ok: true; action: 'markdown'; document: MarkdownDocument }
  | { ok: true; action: 'external'; url: string }
  | { ok: false; code: MarkdownLinkErrorCode; message: string };

export type EmptyResult =
  | { ok: true }
  | { ok: false; code: string; message: string };
