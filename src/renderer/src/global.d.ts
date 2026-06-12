import type { MdViewerApi } from '../../preload/types';

declare global {
  interface Window {
    mdViewer: MdViewerApi;
  }
}

export {};
